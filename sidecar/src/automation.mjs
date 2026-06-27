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

  // Mensagem recebida em grupo -> gatilhos 'message' e 'message_link'.
  async function onMessage({ jid, sender, text, raw }) {
    if (!text) return;
    const ctx = { jid, sender, text, raw };
    await runTrigger('message', ctx);
    await runTrigger('message_link', ctx);
  }

  // Entrada/saida de membro -> gatilho 'join' | 'leave'.
  async function onMembership(eventType, { jid, sender }) {
    await runTrigger(eventType, { jid, sender });
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
    for (let ai = 0; ai < actions.length; ai++) {
      const action = actions[ai];
      const cfg = safeParse(action.config_json);
      switch (action.action_type) {
        case 'group_message': {
          // Sequencia rica (texto/imagem/audio/video/enquete) no grupo.
          const sent = await runMessageAction(ctx.jid, cfg);
          if (sent) taken.push('group_message');
          break;
        }
        case 'dm': {
          if (ctx.sender) {
            try {
              const sent = await runMessageAction(ctx.sender, cfg); // DM ao membro (@lid — questao #6)
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
          // TRAVA DE ADMIN: nunca remove admin por gatilho.
          const isAdmin = await wa.isParticipantAdmin(ctx.jid, ctx.sender).catch(() => false);
          if (isAdmin) {
            taken.push('remove_skipped_admin');
          } else {
            await wa.removeParticipant(ctx.jid, ctx.sender);
            taken.push('remove');
          }
          break;
        }
        case 'webhook': {
          if (cfg.url) {
            await postWebhook(cfg.url, cfg.secret, buildPayload(triggerType, rule, ctx));
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
      `INSERT INTO automation_logs (rule_id, target_jid, sender_e164, matched_text, actions_taken, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(
      rule.id,
      ctx.jid,
      jidToE164(ctx.sender),
      (ctx.text ?? `[${triggerType}]`).slice(0, 500),
      taken.join(','),
      new Date().toISOString()
    );
    console.error(`[auto] "${rule.name}" (${triggerType}) em ${ctx.jid}: ${taken.join(',') || 'nenhuma acao'}`);
  }

  // Executa uma acao de mensagem (sequencia rica) num jid (grupo ou privado).
  async function runMessageAction(jid, cfg) {
    const steps = actionSteps(cfg);
    if (steps.length === 0) return false;
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
      await wa.sendContent(jid, contentFromStep(step, buf)); // @all/link tratados em sendContent
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
function buildPayload(triggerType, rule, ctx) {
  const timestamp = new Date().toISOString();
  if (triggerType === 'message') {
    return {
      event: 'automation.match',
      timestamp,
      rule: { name: rule.name, match_type: rule.match_type, pattern: rule.pattern },
      group: { jid: ctx.jid },
      sender: { jid: ctx.sender, phone_e164: jidToE164(ctx.sender) },
      message: { text: ctx.text },
    };
  }
  return {
    event: triggerType === 'join' ? 'group.member_joined' : 'group.member_left',
    timestamp,
    group: { jid: ctx.jid },
    member: { jid: ctx.sender, phone_e164: jidToE164(ctx.sender) },
  };
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

// Best-effort: E.164 quando o jid e numero (@s.whatsapp.net); @lid nao resolve (questao #6).
function jidToE164(jid) {
  if (typeof jid !== 'string') return null;
  if (jid.includes('@s.whatsapp.net')) {
    const user = jid.split('@')[0].split(':')[0];
    return /^\d+$/.test(user) ? `+${user}` : null;
  }
  return null;
}

function safeParse(s) {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
}
