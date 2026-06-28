// Conexao WhatsApp via Baileys.
//
// Milestone 2 (multi-chip): este modulo agora e um POOL de sessoes. Cada conta
// (chip) tem seu proprio `sock`, estado, dir de auth (`wa-session/<accountId>/`)
// e ciclo de vida isolado. As funcoes "single-chip" (start/getState/sendContent…)
// continuam funcionando: operam na CONTA PRIMARIA (menor accountId), entao com
// 1 chip o comportamento e identico ao anterior.

import * as baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  renameSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// require em ESM — para libs opcionais de proxy (carregadas sob demanda na Fase B).
const require = createRequire(import.meta.url);

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

// ===========================================================================
//  POOL — gerencia N sessoes (chips). API single-chip delega para a primaria.
// ===========================================================================

export function createWhatsApp(db, sessionRootDir) {
  const sessions = new Map(); // accountId -> sessao
  const handlers = { message: null, membership: null }; // compartilhados entre sessoes
  const getHandlers = () => handlers;

  mkdirSync(sessionRootDir, { recursive: true });
  migrateLegacySession(sessionRootDir);
  ensurePrimaryAccount(db);

  const sessionDirFor = (accountId) => join(sessionRootDir, String(accountId));

  function getSession(accountId) {
    let s = sessions.get(accountId);
    if (!s) {
      s = createSession({ db, accountId, sessionDir: sessionDirFor(accountId), getHandlers });
      sessions.set(accountId, s);
    }
    return s;
  }

  // Conta primaria = menor id existente (a "conta principal" do fluxo 1-chip).
  function primaryId() {
    const row = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();
    return row?.id ?? 1;
  }
  const primary = () => getSession(primaryId());

  // Reconecta no arranque todas as contas com credenciais salvas.
  function bootReconnect() {
    const accts = db.prepare('SELECT id FROM accounts ORDER BY id').all();
    for (const a of accts) {
      if (existsSync(join(sessionDirFor(a.id), 'creds.json'))) {
        console.error(`[wa] conta ${a.id}: sessao salva — reconectando`);
        getSession(a.id).start();
      }
    }
  }

  // --- Gestao de contas (Fase B usa; util ja aqui) ---

  function listAccounts() {
    return db
      .prepare('SELECT id, label, jid, status, proxy_url, proxy_enabled FROM accounts ORDER BY id')
      .all()
      .map((a) => {
        const st = sessions.get(a.id)?.getState() ?? null;
        const admin = db
          .prepare("SELECT COUNT(*) AS n FROM targets WHERE account_id = ? AND is_admin = 1")
          .get(a.id).n;
        const groups = db
          .prepare('SELECT COUNT(*) AS n FROM targets WHERE account_id = ?')
          .get(a.id).n;
        return {
          id: a.id,
          label: a.label,
          jid: a.jid,
          proxy_url: a.proxy_url ?? null,
          proxy_enabled: !!a.proxy_enabled,
          status: st?.status ?? a.status ?? 'disconnected',
          qr: st?.qr ?? null,
          me: st?.me ?? null,
          groups,
          admin_groups: admin,
        };
      });
  }

  function addAccount(label) {
    const now = new Date().toISOString();
    const r = db
      .prepare("INSERT INTO accounts (label, status, created_at) VALUES (?, 'disconnected', ?)")
      .run(String(label || 'Novo chip').slice(0, 60), now);
    return r.lastInsertRowid;
  }

  async function removeAccount(accountId) {
    const s = sessions.get(accountId);
    if (s) await s.logout().catch(() => {});
    sessions.delete(accountId);
    await rm(sessionDirFor(accountId), { recursive: true, force: true }).catch(() => {});
    db.exec('BEGIN;');
    try {
      db.prepare('DELETE FROM targets WHERE account_id = ?').run(accountId);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
  }

  function setAccountProxy(accountId, proxyUrl, enabled) {
    db.prepare('UPDATE accounts SET proxy_url = ?, proxy_enabled = ? WHERE id = ?')
      .run(proxyUrl || null, enabled ? 1 : 0, accountId);
  }

  // Lista de alvos de TODAS as contas (com account_id para cobertura).
  function listTargets() {
    return db
      .prepare(
        'SELECT id, account_id, jid, name, type, is_admin, last_synced_at FROM targets ORDER BY is_admin DESC, name COLLATE NOCASE'
      )
      .all();
  }

  return {
    // --- Pool / multi-chip ---
    listAccounts,
    addAccount,
    removeAccount,
    setAccountProxy,
    bootReconnect,
    startAccount: (id) => getSession(id).start(),
    logoutAccount: (id) => getSession(id).logout(),
    getAccountState: (id) => getSession(id).getState(),
    syncTargetsForAccount: (id) => getSession(id).syncTargets(),
    isAccountConnected: (id) => getSession(id).isConnected(),
    accountSend: (id, jid, content) => getSession(id).sendContent(jid, content),
    accountReplyText: (id, jid, text, q) => getSession(id).replyText(jid, text, q),
    accountSendDirect: (id, to, text) => getSession(id).sendDirect(to, text),
    accountRemoveParticipant: (id, jid, p) => getSession(id).removeParticipant(jid, p),
    accountIsParticipantAdmin: (id, jid, p) => getSession(id).isParticipantAdmin(jid, p),
    connectedAccountIds: () =>
      [...sessions.entries()].filter(([, s]) => s.isConnected()).map(([id]) => id),

    // --- Handlers compartilhados (todas as sessoes chamam) ---
    setMessageHandler: (fn) => { handlers.message = fn; },
    setMembershipHandler: (fn) => { handlers.membership = fn; },

    // --- Compat single-chip (operam na conta primaria) ---
    start: () => primary().start(),
    logout: () => primary().logout(),
    getState: () => primary().getState(),
    syncTargets: () => primary().syncTargets(),
    listTargets,
    sendContent: (jid, content) => primary().sendContent(jid, content),
    isConnected: () => primary().isConnected(),
    replyText: (jid, text, q) => primary().replyText(jid, text, q),
    sendDirect: (to, text) => primary().sendDirect(to, text),
    removeParticipant: (jid, p) => primary().removeParticipant(jid, p),
    isParticipantAdmin: (jid, p) => primary().isParticipantAdmin(jid, p),
  };
}

// ===========================================================================
//  SESSAO — uma conexao Baileys isolada (um chip).
// ===========================================================================

function createSession({ db, accountId, sessionDir, getHandlers }) {
  let sock = null;
  let starting = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  // Caches para enriquecer os webhooks: nome (pushName/contatos) e telefone por id.
  const nameById = new Map();
  const phoneById = new Map();

  const state = {
    status: 'disconnected', // disconnected | connecting | qr | connected
    qr: null,
    me: null,
    last_error: null,
  };

  function getState() {
    return { account_id: accountId, status: state.status, qr: state.qr, me: state.me, last_error: state.last_error };
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
        ...proxyAgentFor(db, accountId), // { agent, fetchAgent } quando ha proxy
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => onConnectionUpdate(u).catch((e) =>
        console.error(`[wa:${accountId}] erro no connection.update:`, e?.message)
      ));

      // Mensagens recebidas (gatilho 'message'). So grupos, ignora as proprias.
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        const messageHandler = getHandlers().message;
        if (type !== 'notify' || !messageHandler) return;
        for (const m of messages) {
          if (m.key?.fromMe) continue;
          const j = m.key?.remoteJid;
          if (!j || !j.endsWith('@g.us')) continue;
          const sender = m.key.participant ?? null;
          if (sender && m.pushName) nameById.set(sender, m.pushName);
          const info = {
            account_id: accountId,
            msg_id: m.key?.id ?? null,
            jid: j,
            sender,
            phone: (sender && phoneById.get(sender)) || null,
            name: m.pushName || (sender && nameById.get(sender)) || null,
            text: extractText(m),
            raw: m,
          };
          if (info.text) {
            Promise.resolve(messageHandler(info)).catch((e) =>
              console.error(`[wa:${accountId}] erro no handler de mensagem:`, e?.message)
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
      sock.ev.on('messaging-history.set', (h) => cacheContacts(h?.contacts));

      // Entrada/saida de membros (gatilhos 'join'/'leave').
      sock.ev.on('group-participants.update', (ev) => {
        const membershipHandler = getHandlers().membership;
        if (!membershipHandler) return;
        const jid = ev?.id;
        const action = ev?.action; // add | remove | promote | demote
        const eventType = action === 'add' ? 'join' : action === 'remove' ? 'leave' : null;
        if (!jid || !eventType) return;
        for (const participant of ev.participants ?? []) {
          const id = typeof participant === 'object' ? participant.id : participant;
          const phone =
            digitsOnly(typeof participant === 'object' ? participant.phoneNumber : null) ||
            phoneById.get(id) ||
            (typeof id === 'string' && id.includes('@s.whatsapp.net') ? digitsOnly(id) : null);
          if (id && phone) phoneById.set(id, phone);
          const info = { account_id: accountId, jid, sender: id, phone, name: (id && nameById.get(id)) || null };
          Promise.resolve(membershipHandler(eventType, info)).catch((e) =>
            console.error(`[wa:${accountId}] erro no handler de membership:`, e?.message)
          );
        }
      });
    } catch (err) {
      state.status = 'disconnected';
      state.last_error = err?.message ?? String(err);
      console.error(`[wa:${accountId}] falha ao iniciar:`, state.last_error);
    } finally {
      starting = false;
    }
  }

  async function onConnectionUpdate(u) {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      state.status = 'qr';
      state.qr = await QRCode.toDataURL(qr);
      db.prepare("UPDATE accounts SET status = 'qr_pending' WHERE id = ?").run(accountId);
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      state.status = 'connected';
      state.qr = null;
      const credsMe = sock.authState?.creds?.me ?? {};
      const rawLid = sock.user?.lid ?? credsMe.lid ?? null;
      state.me = {
        jid: jidNormalizedUser(sock.user?.id ?? credsMe.id ?? ''),
        lid: rawLid ? jidNormalizedUser(rawLid) : null,
        name: sock.user?.name ?? credsMe.name ?? null,
      };
      updateAccountOnConnect(state.me);
      console.error(`[wa:${accountId}] conectado: jid=${state.me.jid} lid=${state.me.lid ?? '—'}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      state.me = null;
      sock = null;

      if (loggedOut) {
        state.status = 'disconnected';
        state.qr = null;
        db.prepare("UPDATE accounts SET status = 'disconnected' WHERE id = ?").run(accountId);
        console.error(`[wa:${accountId}] sessao encerrada (logout).`);
      } else {
        state.status = 'connecting';
        reconnectAttempts += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** reconnectAttempts);
        console.error(`[wa:${accountId}] queda (code ${code}); reconectando em ${delay}ms`);
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
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    db.prepare("UPDATE accounts SET status = 'disconnected' WHERE id = ?").run(accountId);
  }

  function updateAccountOnConnect(me) {
    const r = db
      .prepare("UPDATE accounts SET jid = ?, label = COALESCE(label, ?), session_path = ?, status = 'connected' WHERE id = ?")
      .run(me.jid, me.name ?? 'Conta principal', sessionDir, accountId);
    // Salvaguarda: se a linha sumiu (ex.: banco recriado), recria.
    if (r.changes === 0) {
      db.prepare("INSERT INTO accounts (id, label, jid, session_path, status, created_at) VALUES (?,?,?,?, 'connected', ?)")
        .run(accountId, me.name ?? 'Conta principal', me.jid, sessionDir, new Date().toISOString());
    }
  }

  // --- Sincronizacao de alvos (desta conta) ---

  async function syncTargets() {
    if (state.status !== 'connected' || !sock) {
      throw new Error('WhatsApp nao conectado');
    }
    const myIds = new Set([state.me.jid, state.me.lid].filter(Boolean));
    const isMe = (id) => !!id && myIds.has(jidNormalizedUser(id));
    const meta = await sock.groupFetchAllParticipating();
    const now = new Date().toISOString();

    const debug = [];
    const rows = [];
    for (const g of Object.values(meta)) {
      const participants = g.participants ?? [];
      const mine = participants.find((p) => isMe(p.id) || isMe(p.jid) || isMe(p.lid));
      const isAdmin = mine && (mine.admin === 'admin' || mine.admin === 'superadmin') ? 1 : 0;

      let name = (g.subject ?? '').trim();
      let nameSource = 'batch';
      if (!name) {
        try {
          const full = await sock.groupMetadata(g.id);
          name = (full?.subject ?? '').trim();
          nameSource = 'metadata';
        } catch (e) {
          console.error(`[wa:${accountId}] groupMetadata falhou para ${g.id}: ${e?.message}`);
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
      `[wa:${accountId}] sync: ${rows.length} grupos (${rows.filter((r) => r.is_admin).length} admin, ${comm.length} de comunidade).`
    );

    try {
      const debugPath = join(dirname(sessionDir), `last-sync-debug-${accountId}.json`);
      writeFileSync(
        debugPath,
        JSON.stringify({ me: { jid: state.me.jid, lid: state.me.lid }, groups: debug }, null, 2)
      );
    } catch (e) {
      console.error(`[wa:${accountId}] falha ao gravar debug:`, e?.message);
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

  // Envio generico (texto/midia/enquete). Suporta @all (mencao oculta) e preview de link.
  async function sendContent(jid, content) {
    if (state.status !== 'connected' || !sock) {
      throw new Error('WhatsApp nao conectado');
    }

    let payload = content;
    const mentionText = typeof content.text === 'string' ? content.text : content.caption;

    if (jid.endsWith('@g.us') && typeof mentionText === 'string' && hasAllMention(mentionText)) {
      try {
        const md = await sock.groupMetadata(jid);
        const mentions = (md.participants ?? []).map((p) => p.id).filter(Boolean);
        payload = { ...payload, mentions };
        console.error(`[wa:${accountId}] @all em ${jid}: ${mentions.length} mencao(es) oculta(s)`);
      } catch (e) {
        console.error(`[wa:${accountId}] @all: falha ao buscar participantes de ${jid}: ${e?.message}`);
      }
    }

    if (typeof payload.text === 'string' && hasUrl(payload.text)) {
      payload = { ...payload, generateHighQualityLinkPreview: true };
    }

    return sock.sendMessage(jid, payload);
  }

  function isConnected() {
    return state.status === 'connected' && !!sock;
  }

  async function replyText(jid, text, quotedKeyOrMsg) {
    if (!isConnected()) throw new Error('WhatsApp nao conectado');
    const opts = quotedKeyOrMsg ? { quoted: quotedKeyOrMsg } : {};
    return sock.sendMessage(jid, { text }, opts);
  }

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
    start, logout, getState, syncTargets, sendContent, isConnected,
    replyText, sendDirect, removeParticipant, isParticipantAdmin,
  };
}

// ===========================================================================
//  Helpers de pool
// ===========================================================================

// Migra a sessao legada (1 chip) de `wa-session/*.json` para `wa-session/1/`.
function migrateLegacySession(root) {
  const legacyCreds = join(root, 'creds.json');
  const oneDir = join(root, '1');
  if (existsSync(legacyCreds) && !existsSync(join(oneDir, 'creds.json'))) {
    mkdirSync(oneDir, { recursive: true });
    for (const f of readdirSync(root)) {
      const full = join(root, f);
      try {
        if (statSync(full).isFile()) renameSync(full, join(oneDir, f));
      } catch {
        /* ignora arquivos que nao deram para mover */
      }
    }
    console.error('[wa] sessao legada migrada -> wa-session/1/');
  }
}

// Garante ao menos uma conta (id=1 em instalacao nova) para o fluxo primario.
function ensurePrimaryAccount(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  if (n === 0) {
    db.prepare("INSERT INTO accounts (label, status, created_at) VALUES (?, 'disconnected', ?)")
      .run('Conta principal', new Date().toISOString());
  }
}

// Monta o agente de proxy da conta (SOCKS5 ou HTTP/HTTPS) para o makeWASocket.
// Sem proxy habilitado -> objeto vazio (conexao direta, comportamento padrao).
function proxyAgentFor(db, accountId) {
  try {
    const a = db
      .prepare('SELECT proxy_url, proxy_enabled FROM accounts WHERE id = ?')
      .get(accountId);
    if (!a || !a.proxy_enabled || !a.proxy_url) return {};
    const agent = makeProxyAgent(a.proxy_url);
    if (!agent) return {};
    console.error(`[wa:${accountId}] usando proxy ${maskProxy(a.proxy_url)}`);
    return { agent, fetchAgent: agent };
  } catch {
    return {};
  }
}

// ===========================================================================
//  Helpers de classificacao / texto (inalterados)
// ===========================================================================

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

function digitsOnly(x) {
  if (!x) return null;
  const user = String(x).split('@')[0].split(':')[0];
  const d = user.replace(/\D/g, '');
  return d || null;
}

function hasAllMention(text) {
  return /(^|\s)@all\b/i.test(text);
}

function hasUrl(text) {
  return /https?:\/\/[^\s]+/i.test(text);
}

// Mascara credenciais da URL de proxy em logs.
function maskProxy(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || '?'}`;
  } catch {
    return 'proxy';
  }
}

// Cria o agente de proxy conforme o esquema da URL. As libs sao opcionais:
// se nao estiverem instaladas (ou a URL for invalida), retorna null (sem proxy).
let _proxyLibs;
function makeProxyAgent(url) {
  try {
    const scheme = new URL(url).protocol.replace(':', '').toLowerCase();
    if (!_proxyLibs) {
      _proxyLibs = {};
      try { _proxyLibs.socks = require('socks-proxy-agent'); } catch { /* opcional */ }
      try { _proxyLibs.http = require('https-proxy-agent'); } catch { /* opcional */ }
    }
    if (scheme.startsWith('socks')) {
      return _proxyLibs.socks ? new _proxyLibs.socks.SocksProxyAgent(url) : null;
    }
    if (scheme === 'http' || scheme === 'https') {
      return _proxyLibs.http ? new _proxyLibs.http.HttpsProxyAgent(url) : null;
    }
    return null;
  } catch {
    return null;
  }
}
