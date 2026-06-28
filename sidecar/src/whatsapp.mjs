// Conexao WhatsApp via Baileys (Fase 1): pareamento por QR, sessao persistida,
// reconexao com backoff e sincronizacao de grupos/comunidades admin.
// A ferramenta e observadora: nao adiciona membros nem envia em massa nao solicitado.

import * as baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Baileys publica como ESM/CJS; resolvemos os simbolos de forma robusta.
const makeWASocket = baileys.default ?? baileys.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = baileys;

// Logger silencioso compativel com a interface pino que a Baileys espera.
const silentLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; },
};

const MAX_BACKOFF_MS = 30_000;

export function createWhatsApp(db, sessionDir) {
  let sock = null;
  let starting = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let messageHandler = null; // (info) => Promise — gatilho de mensagem
  let membershipHandler = null; // (eventType, info) => Promise — entrou/saiu

  // Caches para enriquecer os webhooks: nome (pushName/contatos) e telefone por id.
  const nameById = new Map(); // jid/lid -> nome de exibicao
  const phoneById = new Map(); // lid -> telefone (somente digitos)

  const state = {
    status: 'disconnected', // disconnected | connecting | qr | connected
    qr: null, // data URL do QR quando status === 'qr'
    me: null, // { jid, name }
    last_error: null,
  };

  function getState() {
    return { status: state.status, qr: state.qr, me: state.me, last_error: state.last_error };
  }

  async function start() {
    if (starting || state.status === 'connected') return;
    starting = true;
    state.status = 'connecting';
    state.qr = null;
    state.last_error = null;

    try {
      mkdirSync(sessionDir, { recursive: true });
      const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

      sock = makeWASocket({
        version,
        auth: authState,
        logger: silentLogger,
        browser: ['isigroup', 'Chrome', '1.0'],
        markOnlineOnConnect: false,
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => onConnectionUpdate(u).catch((e) =>
        console.error('[wa] erro no connection.update:', e?.message)
      ));

      // Mensagens recebidas (gatilho 'message'). So grupos, ignora as proprias.
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify' || !messageHandler) return;
        for (const m of messages) {
          if (m.key?.fromMe) continue;
          const j = m.key?.remoteJid;
          if (!j || !j.endsWith('@g.us')) continue;
          const sender = m.key.participant ?? null;
          // Cacheia o nome de exibicao do remetente (pushName).
          if (sender && m.pushName) nameById.set(sender, m.pushName);
          const info = {
            jid: j,
            sender,
            phone: (sender && phoneById.get(sender)) || null,
            name: m.pushName || (sender && nameById.get(sender)) || null,
            text: extractText(m),
            raw: m,
          };
          if (info.text) {
            Promise.resolve(messageHandler(info)).catch((e) =>
              console.error('[wa] erro no handler de mensagem:', e?.message)
            );
          }
        }
      });

      // Atualizacoes de contatos -> cacheia nomes (para join/leave).
      const cacheContacts = (contacts) => {
        for (const c of contacts ?? []) {
          const nm = c.name || c.notify || c.verifiedName;
          if (c.id && nm) nameById.set(c.id, nm);
        }
      };
      sock.ev.on('contacts.upsert', cacheContacts);
      sock.ev.on('contacts.update', cacheContacts);
      // Sync inicial do historico tambem traz contatos (nomes).
      sock.ev.on('messaging-history.set', (h) => cacheContacts(h?.contacts));

      // Entrada/saida de membros (gatilhos 'join'/'leave').
      sock.ev.on('group-participants.update', (ev) => {
        if (!membershipHandler) return;
        const jid = ev?.id;
        const action = ev?.action; // add | remove | promote | demote
        const eventType = action === 'add' ? 'join' : action === 'remove' ? 'leave' : null;
        if (!jid || !eventType) return;
        for (const participant of ev.participants ?? []) {
          // O participante pode vir como string (@lid) ou objeto { id, phoneNumber }.
          const id = typeof participant === 'object' ? participant.id : participant;
          const phone =
            digitsOnly(typeof participant === 'object' ? participant.phoneNumber : null) ||
            phoneById.get(id) ||
            (typeof id === 'string' && id.includes('@s.whatsapp.net') ? digitsOnly(id) : null);
          if (id && phone) phoneById.set(id, phone);
          const info = { jid, sender: id, phone, name: (id && nameById.get(id)) || null };
          Promise.resolve(membershipHandler(eventType, info)).catch((e) =>
            console.error('[wa] erro no handler de membership:', e?.message)
          );
        }
      });
    } catch (err) {
      state.status = 'disconnected';
      state.last_error = err?.message ?? String(err);
      console.error('[wa] falha ao iniciar:', state.last_error);
    } finally {
      starting = false;
    }
  }

  async function onConnectionUpdate(u) {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      state.status = 'qr';
      state.qr = await QRCode.toDataURL(qr);
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      state.status = 'connected';
      state.qr = null;
      // Captura tanto o JID de telefone quanto o LID (id de privacidade).
      // O WhatsApp identifica participantes por @lid, entao precisamos dos dois
      // para reconhecer "eu mesmo" na lista de participantes do grupo.
      const credsMe = sock.authState?.creds?.me ?? {};
      const rawLid = sock.user?.lid ?? credsMe.lid ?? null;
      state.me = {
        jid: jidNormalizedUser(sock.user?.id ?? credsMe.id ?? ''),
        lid: rawLid ? jidNormalizedUser(rawLid) : null,
        name: sock.user?.name ?? credsMe.name ?? null,
      };
      upsertAccount(state.me);
      console.error(`[wa] conectado: jid=${state.me.jid} lid=${state.me.lid ?? '—'}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      state.me = null;
      sock = null;

      if (loggedOut) {
        state.status = 'disconnected';
        state.qr = null;
        console.error('[wa] sessao encerrada (logout).');
      } else {
        // Reconexao com backoff — evita loop agressivo (sinal suspeito).
        state.status = 'connecting';
        reconnectAttempts += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** reconnectAttempts);
        console.error(`[wa] queda (code ${code}); reconectando em ${delay}ms`);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => start(), delay);
      }
    }
  }

  async function logout() {
    clearTimeout(reconnectTimer);
    try {
      if (sock) await sock.logout();
    } catch {
      /* ignora — vamos limpar a sessao de qualquer forma */
    }
    sock = null;
    state.status = 'disconnected';
    state.qr = null;
    state.me = null;
    reconnectAttempts = 0;
    // Limpa as credenciais em disco para forcar novo QR.
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    if (state.me === null) {
      db.prepare("UPDATE accounts SET status = 'disconnected'").run();
    }
  }

  // --- Persistencia ---

  function upsertAccount(me) {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM accounts WHERE jid = ?').get(me.jid);
    if (existing) {
      db.prepare('UPDATE accounts SET status = ?, label = COALESCE(label, ?) WHERE id = ?')
        .run('connected', me.name ?? 'Conta principal', existing.id);
      return existing.id;
    }
    const r = db
      .prepare(
        'INSERT INTO accounts (label, jid, session_path, status, created_at) VALUES (?,?,?,?,?)'
      )
      .run(me.name ?? 'Conta principal', me.jid, sessionDir, 'connected', now);
    return r.lastInsertRowid;
  }

  function currentAccountId() {
    const row = db.prepare('SELECT id FROM accounts WHERE jid = ?').get(state.me?.jid ?? '');
    return row?.id ?? null;
  }

  // --- Sincronizacao de alvos ---

  async function syncTargets() {
    if (state.status !== 'connected' || !sock) {
      throw new Error('WhatsApp nao conectado');
    }
    const accountId = currentAccountId();
    // Conjunto de identificadores que representam "eu": jid de telefone e LID.
    const myIds = new Set([state.me.jid, state.me.lid].filter(Boolean));
    const isMe = (id) => !!id && myIds.has(jidNormalizedUser(id));
    const meta = await sock.groupFetchAllParticipating();
    const now = new Date().toISOString();

    const debug = []; // diagnostico gravado em arquivo para auditoria

    const rows = [];
    for (const g of Object.values(meta)) {
      const participants = g.participants ?? [];
      // O participante "eu" pode estar exposto por id, jid ou lid.
      const mine = participants.find((p) => isMe(p.id) || isMe(p.jid) || isMe(p.lid));
      const isAdmin = mine && (mine.admin === 'admin' || mine.admin === 'superadmin') ? 1 : 0;

      // O fetch em lote as vezes vem sem subject; buscamos a metadata individual.
      let name = (g.subject ?? '').trim();
      let nameSource = 'batch';
      if (!name) {
        try {
          const full = await sock.groupMetadata(g.id);
          name = (full?.subject ?? '').trim();
          nameSource = 'metadata';
        } catch (e) {
          console.error(`[wa] groupMetadata falhou para ${g.id}: ${e?.message}`);
        }
      }
      if (!name) {
        name = '(sem nome)';
        nameSource = 'fallback';
      }

      debug.push({
        name,
        name_source: nameSource,
        type: classifyTarget(g),
        self_found: !!mine,
        self_admin: mine?.admin ?? null,
        self_raw: mine ? maskId(mine.id ?? mine.jid ?? mine.lid) : null,
        // dominios de id presentes (revela @lid vs @s.whatsapp.net)
        domains: [...new Set(participants.map((p) => domainOf(p.id ?? p.jid ?? p.lid)))],
        ...pickCommunityFlags(g),
      });

      rows.push({
        account_id: accountId,
        jid: g.id,
        name,
        type: classifyTarget(g),
        is_admin: isAdmin,
        last_synced_at: now,
      });
    }

    const comm = rows.filter((r) => r.type !== 'group');
    console.error(
      `[wa] sync: ${rows.length} grupos (${rows.filter((r) => r.is_admin).length} admin, ${comm.length} de comunidade).`
    );

    // Grava diagnostico (ids mascarados) para confirmar deteccao de admin / classificacao.
    try {
      const debugPath = join(dirname(sessionDir), 'last-sync-debug.json');
      writeFileSync(
        debugPath,
        JSON.stringify({ me: { jid: state.me.jid, lid: state.me.lid }, groups: debug }, null, 2)
      );
    } catch (e) {
      console.error('[wa] falha ao gravar debug:', e?.message);
    }

    const upsert = db.prepare(`
      INSERT INTO targets (account_id, jid, name, type, is_admin, last_synced_at)
      VALUES (@account_id, @jid, @name, @type, @is_admin, @last_synced_at)
      ON CONFLICT(account_id, jid) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        is_admin = excluded.is_admin,
        last_synced_at = excluded.last_synced_at
    `);

    db.exec('BEGIN;');
    try {
      for (const r of rows) {
        upsert.run({
          account_id: r.account_id,
          jid: r.jid,
          name: r.name,
          type: r.type,
          is_admin: r.is_admin,
          last_synced_at: r.last_synced_at,
        });
      }
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }

    return {
      synced: rows.length,
      admin: rows.filter((r) => r.is_admin).length,
      communities: comm.length,
    };
  }

  function listTargets() {
    return db
      .prepare(
        'SELECT id, jid, name, type, is_admin, last_synced_at FROM targets ORDER BY is_admin DESC, name COLLATE NOCASE'
      )
      .all();
  }

  // Envio generico (texto agora; midia/enquete nas Fases 3). Usado pelo scheduler.
  // Suporta o token "@all": menciona todos os membros do grupo de forma OCULTA
  // (ping silencioso) — o array `mentions` notifica todos sem poluir o texto com @.
  async function sendContent(jid, content) {
    if (state.status !== 'connected' || !sock) {
      throw new Error('WhatsApp nao conectado');
    }

    let payload = content;
    const mentionText = typeof content.text === 'string' ? content.text : content.caption;

    // Menção oculta de todos (@all).
    if (jid.endsWith('@g.us') && typeof mentionText === 'string' && hasAllMention(mentionText)) {
      try {
        const md = await sock.groupMetadata(jid);
        const mentions = (md.participants ?? []).map((p) => p.id).filter(Boolean);
        payload = { ...payload, mentions };
        console.error(`[wa] @all em ${jid}: ${mentions.length} mencao(es) oculta(s)`);
      } catch (e) {
        console.error(`[wa] @all: falha ao buscar participantes de ${jid}: ${e?.message}`);
      }
    }

    // Preview rico de link: quando o texto contem URL, a Baileys gera o card
    // (titulo, descricao, imagem og) via link-preview-js. Pedimos alta qualidade.
    if (typeof payload.text === 'string' && hasUrl(payload.text)) {
      payload = { ...payload, generateHighQualityLinkPreview: true };
    }

    return sock.sendMessage(jid, payload);
  }

  function isConnected() {
    return state.status === 'connected' && !!sock;
  }

  // --- Automacao: handler + acoes ---

  function setMessageHandler(fn) {
    messageHandler = fn;
  }
  function setMembershipHandler(fn) {
    membershipHandler = fn;
  }

  async function replyText(jid, text, quotedKeyOrMsg) {
    if (!isConnected()) throw new Error('WhatsApp nao conectado');
    const opts = quotedKeyOrMsg ? { quoted: quotedKeyOrMsg } : {};
    return sock.sendMessage(jid, { text }, opts);
  }

  // Mensagem no privado para um membro (DM). O destino pode ser @lid (questao #6).
  async function sendDirect(toJid, text) {
    if (!isConnected()) throw new Error('WhatsApp nao conectado');
    return sock.sendMessage(toJid, { text });
  }

  async function removeParticipant(jid, participant) {
    if (!isConnected()) throw new Error('WhatsApp nao conectado');
    return sock.groupParticipantsUpdate(jid, [participant], 'remove');
  }

  async function isParticipantAdmin(jid, participant) {
    if (!isConnected()) return false;
    const md = await sock.groupMetadata(jid);
    const p = (md.participants ?? []).find(
      (x) => x.id === participant || x.jid === participant || x.lid === participant
    );
    return !!p && (p.admin === 'admin' || p.admin === 'superadmin');
  }

  return {
    start, logout, getState, syncTargets, listTargets, sendContent, isConnected,
    setMessageHandler, setMembershipHandler, replyText, sendDirect, removeParticipant, isParticipantAdmin,
  };
}

// Classificacao defensiva: a validar na versao atual da Baileys (questao #1).
function classifyTarget(g) {
  if (g.isCommunityAnnounce || (g.isCommunity && g.announce)) return 'community_announce';
  if (g.linkedParent || g.communityId || g.parentGroup) return 'community_subgroup';
  if (g.isCommunity) return 'community_announce';
  return 'group';
}

function pickCommunityFlags(g) {
  return {
    isCommunity: g.isCommunity ?? null,
    isCommunityAnnounce: g.isCommunityAnnounce ?? null,
    announce: g.announce ?? null,
    linkedParent: g.linkedParent ?? null,
  };
}

// Mascara o numero mantendo o dominio (revela @lid vs @s.whatsapp.net sem expor PII).
function maskId(id) {
  if (!id) return null;
  const [user, domain] = String(id).split('@');
  const head = user.replace(/[:.].*$/, '').slice(0, 5);
  return `${head}***@${domain ?? '?'}`;
}

function domainOf(id) {
  if (!id) return '?';
  return String(id).split('@')[1] ?? '?';
}

// Extrai o texto de uma mensagem recebida (conversa, texto estendido, legendas).
function extractText(m) {
  const msg = m?.message;
  if (!msg) return '';
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ''
  );
}

// Extrai apenas os digitos do telefone de um jid/numero (ex: "5521...@s.whatsapp.net" -> "5521...").
function digitsOnly(x) {
  if (!x) return null;
  const user = String(x).split('@')[0].split(':')[0];
  const d = user.replace(/\D/g, '');
  return d || null;
}

// Detecta o token @all como palavra isolada (case-insensitive).
function hasAllMention(text) {
  return /(^|\s)@all\b/i.test(text);
}

// Detecta uma URL http/https no texto (para gerar preview de link).
function hasUrl(text) {
  return /https?:\/\/[^\s]+/i.test(text);
}
