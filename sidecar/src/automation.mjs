// Automacoes & Gatilhos (Fase 4 unificada).
// Gatilhos: 'message' (match no texto), 'join' (entrou), 'leave' (saiu).
// Acoes: group_message, dm, remove (com trava de admin), webhook.

import { readFileSync } from 'node:fs';
import { postWebhook } from './webhooks.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAutomation(db, wa, editionState) {
  // Na edicao free, automacoes so agem em grupos onde a conta e admin.
  function allowedByEdition(jid) {
    if (editionState?.edition === 'pro') return true;
    const t = db.prepare('SELECT is_admin FROM targets WHERE jid = ? LIMIT 1').get(jid);
    return !!t && !!t.is_admin;
  }

  // Nome do grupo a partir dos alvos sincronizados.
  function groupName(jid) {
    const t = db.prepare('SELECT name FROM targets WHERE jid = ? LIMIT 1').get(jid);
    return t?.name ?? null;
  }

  // Monta o corpo do webhook com os dados do lead/grupo/automacao.
  function buildPayload(triggerType, rule, ctx, actingAccountId) {
    const now = new Date();
    const event =
      triggerType === 'join'
        ? 'group.member_joined'
        : triggerType === 'leave'
          ? 'group.member_left'
          : 'automation.match';
    const chipId = actingAccountId ?? ctx.account_id ?? null;
    const chipRow = chipId ? db.prepare('SELECT label FROM accounts WHERE id = ?').get(chipId) : null;
    return {
      event,
      automation: rule.name, // nome da automacao
      chip: { account_id: chipId, label: chipRow?.label ?? null }, // chip que detectou/reagiu
      group: { jid: ctx.jid, name: groupName(ctx.jid) }, // nome do grupo
      lead: {
        name: ctx.name ?? null, // nome usado no whatsapp (pushName/contato)
        phone: ctx.phone ?? null, // ex: "5521996687008"
        jid: ctx.sender ?? null,
      },
      message: ctx.text ?? null, // mensagem do lead (se aplicavel)
      date: localDate(now), // data (local) AAAA-MM-DD
      time: localTime(now), // hora (local) HH:MM:SS
      timestamp: now.toISOString(),
    };
  }

  // Dedup multi-chip: o mesmo evento chega por cada sessao (chip) membro do grupo.
  // Processa so a 1a ocorrencia de cada (evento) numa janela curta.
  const seen = new Map(); // key -> timestamp
  function dedupe(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > 90_000) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  }

  // Chip que responde: menor account_id CONECTADO que seja membro do grupo.
  // null = conta primaria (caminho single-chip).
  function responderFor(jid) {
    const rows = db.prepare('SELECT DISTINCT account_id FROM targets WHERE jid = ? ORDER BY account_id').all(jid);
    for (const r of rows) if (r.account_id && wa.isAccountConnected(r.account_id)) return r.account_id;
    return null;
  }
  // Para 'remove': menor chip conectado que seja ADMIN do grupo.
  function adminResponderFor(jid) {
    const rows = db.prepare('SELECT account_id FROM targets WHERE jid = ? AND is_admin = 1 ORDER BY account_id').all(jid);
    for (const r of rows) if (r.account_id && wa.isAccountConnected(r.account_id)) return r.account_id;
    return null;
  }

  // Mensagem recebida em grupo -> gatilhos 'message' e 'message_link'.
  // info: { jid, sender, phone, name, text, raw, account_id, msg_id }
  async function onMessage(info) {
    if (!info?.text) return;
    if (!dedupe(`m:${info.jid}:${info.msg_id}`)) return; // multi-chip: 1x por mensagem
    await runTrigger('message', info);
    await runTrigger('message_link', info);
  }

  // Entrada/saida de membro -> gatilho 'join' | 'leave'.
  // info: { jid, sender, phone, name, account_id }
  async function onMembership(eventType, info) {
    if (!dedupe(`${eventType}:${info.jid}:${info.sender}`)) return; // 1x por evento
    await runTrigger(eventType, info);
  }

  async function runTrigger(triggerType, ctx) {
    const rules = db
      .prepare('SELECT * FROM automation_rules WHERE enabled = 1 AND trigger_type = ?')
      .all(triggerType);
    if (!allowedByEdition(ctx.jid)) return; // free: ignora grupos nao-admin
    for (const rule of rules) {
      if (!inScope(rule, ctx.jid)) continue;
      if (triggerType === 'message' && !matches(rule, ctx.text)) continue;
      if (triggerType === 'message_link' && !hasUrl(ctx.text)) continue;
      try {
        await execute(rule, triggerType, ctx);
      } catch (e) {
        console.error(`[auto] erro na regra ${rule.id}:`, e?.message);
      }
    }
  }

  async function execute(rule, triggerType, ctx) {
    const actions = db
      .prepare('SELECT * FROM automation_actions WHERE rule_id = ? ORDER BY order_index')
      .all(rule.id);

    const taken = [];
    // Chip que responde (multi-chip): membro conectado de menor id; null = primaria.
    const responder = responderFor(ctx.jid);
    for (let ai = 0; ai < actions.length; ai++) {
      const action = actions[ai];
      const cfg = safeParse(action.config_json);
      switch (action.action_type) {
        case 'group_message': {
          // Sequencia rica (texto/imagem/audio/video/enquete) no grupo.
          const sent = await runMessageAction(responder, ctx.jid, cfg);
          if (sent) taken.push('group_message');
          break;
        }
        case 'dm': {
          if (ctx.sender) {
            try {
              const sent = await runMessageAction(responder, ctx.sender, cfg); // DM ao membro (@lid — questao #6)
              if (sent) taken.push('dm');
            } catch (e) {
              taken.push('dm_failed');
              console.error('[auto] dm falhou:', e?.message);
            }
          }
          break;
        }
        case 'remove': {
          if (!ctx.sender) {
            taken.push('remove_no_sender');
            break;
          }
          // Remove exige um chip ADMIN daquele grupo (questao #6: por chip).
          const adminResp = adminResponderFor(ctx.jid);
          if (!adminResp) {
            taken.push('remove_no_admin_chip');
            break;
          }
          // TRAVA DE ADMIN: nunca remove admin por gatilho.
          const isAdmin = await wa.accountIsParticipantAdmin(adminResp, ctx.jid, ctx.sender).catch(() => false);
          if (isAdmin) {
            taken.push('remove_skipped_admin');
          } else {
            await wa.accountRemoveParticipant(adminResp, ctx.jid, ctx.sender);
            taken.push('remove');
          }
          break;
        }
        case 'webhook': {
          if (cfg.url) {
            await postWebhook(cfg.url, cfg.secret, buildPayload(triggerType, rule, ctx, responder));
            taken.push('webhook');
          }
          break;
        }
        default:
          break;
      }

      // Intervalo irregular (aleatorio na janela) antes da proxima acao.
      if (ai < actions.length - 1) {
        const dmin = (cfg.delay_min_s ?? 0) * 1000;
        const dmax = Math.max(dmin, (cfg.delay_max_s ?? cfg.delay_min_s ?? 0) * 1000);
        if (dmax > 0) await sleep(dmin + Math.floor(Math.random() * Math.max(1, dmax - dmin + 1)));
      }
    }

    db.prepare(
      `INSERT INTO automation_logs (rule_id, account_id, target_jid, sender_e164, matched_text, actions_taken, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      rule.id,
      responder ?? ctx.account_id ?? null,
      ctx.jid,
      ctx.phone ?? (ctx.name ? ctx.name : null),
      (ctx.text ?? `[${triggerType}] ${ctx.name ?? ''}`).slice(0, 500),
      taken.join(','),
      new Date().toISOString()
    );
    console.error(`[auto] "${rule.name}" (${triggerType}) em ${ctx.jid}: ${taken.join(',') || 'nenhuma acao'}`);
  }

  // Executa uma acao de mensagem (sequencia rica) num jid (grupo ou privado).
  // accountId = chip que envia (null = conta primaria, caminho single-chip).
  async function runMessageAction(accountId, jid, cfg) {
    const steps = actionSteps(cfg);
    if (steps.length === 0) return false;
    const send = (j, content) => (accountId ? wa.accountSend(accountId, j, content) : wa.sendContent(j, content));
    const minMs = (cfg.step_min_s ?? 0) * 1000;
    const maxMs = Math.max(minMs, (cfg.step_max_s ?? cfg.step_min_s ?? 0) * 1000);
    const cache = new Map();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let buf = null;
      const path = step.media?.stored_path;
      if (path) {
        if (!cache.has(path)) {
          try {
            cache.set(path, readFileSync(path));
          } catch (e) {
            cache.set(path, null);
            console.error('[auto] midia do passo ausente:', e?.message);
          }
        }
        buf = cache.get(path);
      }
      await send(jid, contentFromStep(step, buf)); // @all/link tratados em sendContent
      if (i < steps.length - 1) {
        const wait = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
        await sleep(wait);
      }
    }
    return true;
  }

  return { onMessage, onMembership };
}

// Normaliza os passos de uma acao de mensagem (suporta legado {text}).
function actionSteps(cfg) {
  if (Array.isArray(cfg.steps) && cfg.steps.length) return cfg.steps;
  if (cfg.text) return [{ payload_type: 'text', body_json: JSON.stringify({ text: cfg.text }), media: null }];
  return [];
}

// Conteudo Baileys a partir de um passo (payload_type + body_json + media).
function contentFromStep(step, mediaBuffer) {
  const body = safeParse(step.body_json);
  switch (step.payload_type) {
    case 'image':
      return { image: mediaBuffer, caption: body.caption ? String(body.caption) : undefined };
    case 'video':
      return { video: mediaBuffer, caption: body.caption ? String(body.caption) : undefined };
    case 'audio':
      return {
        audio: mediaBuffer,
        ptt: true,
        mimetype: step.media?.mimetype || 'audio/ogg; codecs=opus',
        seconds: step.media?.duration_seconds || undefined,
        waveform: waveformBuffer(step.media?.waveform_json),
      };
    case 'poll':
      return { poll: body.poll };
    default:
      return { text: body.text ?? '' };
  }
}

function waveformBuffer(json) {
  if (!json) return undefined;
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? Uint8Array.from(a) : undefined;
  } catch {
    return undefined;
  }
}

// Payload do webhook conforme o gatilho (espelha os contratos do planejamento).
// Data/hora locais (fuso da maquina do usuario) para os campos do webhook.
function pad2(n) {
  return String(n).padStart(2, '0');
}
function localDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function inScope(rule, jid) {
  const scope = safeParse(rule.scope_json);
  if (!Array.isArray(scope) || scope.length === 0) return true;
  return scope.includes(jid);
}

// Teste de match (gatilho de mensagem). Exportado para teste unitario.
export function matches(rule, text) {
  const cs = !!rule.case_sensitive;
  const hay = cs ? text : String(text).toLowerCase();
  const needle = cs ? String(rule.pattern ?? '') : String(rule.pattern ?? '').toLowerCase();
  if (!needle) return false;
  switch (rule.match_type) {
    case 'starts_with':
      return hay.startsWith(needle);
    case 'ends_with':
      return hay.endsWith(needle);
    case 'exact':
      return hay.trim() === needle.trim();
    case 'contains':
    default:
      return hay.includes(needle);
  }
}

// Detecta se o texto contem um link (URL). Exportado para teste.
// Cobre http(s)://, www. e dominio.tld (com caminho), evitando e-mails.
export function hasUrl(text) {
  const t = String(text ?? '');
  if (/\bhttps?:\/\/\S+/i.test(t)) return true;
  if (/\bwww\.\S+/i.test(t)) return true;
  const tld =
    /(^|[^@\w])[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|gov|edu|me|app|co|info|biz|tv|xyz|site|online|store|shop|dev|link|br|pt|us|uk|ai|gg|to)(\/\S*)?/i;
  return tld.test(t);
}

function safeParse(s) {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
}
