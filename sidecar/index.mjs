// isigroup — sidecar Node
// Servidor HTTP local em 127.0.0.1 protegido por token de sessao.
// Sobe o SQLite, aplica migrations, conecta o WhatsApp (Baileys) e expoe a API.
// Ciclo de vida (spawn/supervise/kill) e responsabilidade do core Rust.

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { openDatabase } from './src/db.mjs';
import { createWhatsApp } from './src/whatsapp.mjs';
import { createScheduler } from './src/scheduler.mjs';
import { saveUpload } from './src/media.mjs';
import { createAutomation } from './src/automation.mjs';

// Nome/versão vêm do package.json (copiado ao lado deste módulo no bundle),
// para o /health nunca defasar em relação à versão real publicada.
const PKG = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

const TOKEN = process.env.ISI_SIDECAR_TOKEN;
const DB_PATH = process.env.ISI_DB_PATH || './isigroup.db';
const READY_MARKER = '__SIDECAR_READY__';

if (!TOKEN) {
  console.error('[sidecar] ISI_SIDECAR_TOKEN ausente — encerrando.');
  process.exit(1);
}

let db;
try {
  db = openDatabase(DB_PATH);
} catch (err) {
  console.error('[sidecar] falha ao abrir/migrar o banco:', err.message);
  process.exit(1);
}

// Sessao do WhatsApp e midia persistem ao lado do banco.
const dataDir = dirname(DB_PATH);
const sessionDir = join(dataDir, 'wa-session');
const mediaDir = join(dataDir, 'media');
const wa = createWhatsApp(db, sessionDir);

// Worker do agendador: re-hidrata a fila e dispara no horario.
const scheduler = createScheduler(db, wa);
scheduler.start();

// Edicao da licenca (free/pro), definida pelo front apos validar a licenca.
// Default free = trava nao-admin ate o front confirmar Pro.
const editionState = { edition: 'free' };

// Automacoes & gatilhos: mensagem + entrada/saida de membros.
const automation = createAutomation(db, wa, editionState);
wa.setMessageHandler(automation.onMessage);
wa.setMembershipHandler(automation.onMembership);

// Reconexao automatica no arranque: religa todas as contas (chips) com sessao
// salva — sem precisar clicar em "Conectar" nem reescanear o QR.
wa.bootReconnect();

// A webview do Tauri tem origem propria (tauri://localhost). Chamadas ao
// loopback sao cross-origin: liberamos CORS (a protecao real e o token).
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'x-isi-token, content-type, x-filename',
  'access-control-max-age': '600',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  });
  res.end(payload);
}

// Comparacao de token em tempo constante (evita timing leak).
function tokenOk(provided) {
  if (typeof provided !== 'string' || provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) {
    diff |= provided.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

const server = createServer((req, res) => {
  // Preflight CORS nao carrega token — responde antes da checagem.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Toda rota exige o token de sessao no header.
  if (!tokenOk(req.headers['x-isi-token'])) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  route(req, res, url).catch((err) => {
    console.error('[sidecar] erro na rota:', err?.message);
    json(res, 500, { error: 'internal', message: err?.message ?? 'erro interno' });
  });
});

async function route(req, res, url) {
  const { method } = req;
  const path = url.pathname;
  const match = (m, p) => method === m && path === p;

  if (match('POST', '/edition')) {
    const b = await readJson(req);
    editionState.edition = b?.edition === 'pro' ? 'pro' : 'free';
    return json(res, 200, { edition: editionState.edition });
  }

  if (match('GET', '/health')) {
    const migrations = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n;
    return json(res, 200, {
      ok: true,
      service: PKG.name,
      version: PKG.version,
      migrations_applied: migrations,
      uptime_s: Math.round(process.uptime()),
    });
  }

  // --- Conexao WhatsApp ---
  if (match('POST', '/connection/start')) {
    wa.start();
    return json(res, 202, wa.getState());
  }
  if (match('GET', '/connection/status')) {
    return json(res, 200, wa.getState());
  }
  if (match('POST', '/connection/logout')) {
    await wa.logout();
    return json(res, 200, wa.getState());
  }

  // --- Contas / chips (multi-chip, Milestone 2) ---
  if (match('GET', '/accounts')) {
    return json(res, 200, { accounts: wa.listAccounts(), edition: editionState.edition });
  }
  if (match('POST', '/accounts')) {
    const b = await readJson(req);
    // Gating: free = 1 chip; pro = ilimitado (enforcement no sidecar, nao so na UI).
    const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
    if (editionState.edition !== 'pro' && count >= 1) {
      return json(res, 403, { error: 'pro_required', message: 'Multiplos chips sao exclusivos do plano Pro.' });
    }
    const id = wa.addAccount(b?.label);
    return json(res, 201, { id });
  }
  const acctConnect = path.match(/^\/accounts\/(\d+)\/connect$/);
  if (method === 'POST' && acctConnect) {
    const id = Number(acctConnect[1]);
    // Free: so a conta primaria pode conectar (trava de 2o chip tambem no connect).
    if (editionState.edition !== 'pro') {
      const primary = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();
      if (primary && id !== primary.id) {
        return json(res, 403, { error: 'pro_required', message: 'Multiplos chips sao exclusivos do plano Pro.' });
      }
    }
    wa.startAccount(id);
    return json(res, 202, wa.getAccountState(id));
  }
  const acctLogout = path.match(/^\/accounts\/(\d+)\/logout$/);
  if (method === 'POST' && acctLogout) {
    await wa.logoutAccount(Number(acctLogout[1]));
    return json(res, 200, wa.getAccountState(Number(acctLogout[1])));
  }
  const acctStatus = path.match(/^\/accounts\/(\d+)\/status$/);
  if (method === 'GET' && acctStatus) {
    return json(res, 200, wa.getAccountState(Number(acctStatus[1])));
  }
  const acctSync = path.match(/^\/accounts\/(\d+)\/sync$/);
  if (method === 'POST' && acctSync) {
    try {
      return json(res, 200, await wa.syncTargetsForAccount(Number(acctSync[1])));
    } catch (err) {
      return json(res, 409, { error: 'not_connected', message: err.message });
    }
  }
  if (match('POST', '/proxy/test')) {
    const b = await readJson(req);
    if (!b?.proxy_url) return json(res, 400, { error: 'bad_request', message: 'informe a url do proxy' });
    return json(res, 200, await wa.testProxy(String(b.proxy_url)));
  }
  const acctProxy = path.match(/^\/accounts\/(\d+)\/proxy$/);
  if (method === 'POST' && acctProxy) {
    const b = await readJson(req);
    if (b?.proxy_url && !/^(socks5?|https?):\/\//i.test(String(b.proxy_url))) {
      return json(res, 400, { error: 'bad_request', message: 'proxy deve ser socks5:// ou http(s)://' });
    }
    wa.setAccountProxy(Number(acctProxy[1]), b?.proxy_url ?? null, !!b?.proxy_enabled);
    return json(res, 200, { ok: true });
  }
  const acctDel = path.match(/^\/accounts\/(\d+)$/);
  if (method === 'DELETE' && acctDel) {
    const id = Number(acctDel[1]);
    const primary = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();
    if (primary && id === primary.id) {
      return json(res, 409, { error: 'cannot_remove_primary', message: 'A conta principal nao pode ser removida.' });
    }
    await wa.removeAccount(id);
    return json(res, 200, { ok: true });
  }

  // --- Cobertura (multi-chip): quais chips sao membros de quais grupos ---
  if (match('POST', '/coverage')) {
    const b = await readJson(req);
    const groupJids = Array.isArray(b?.group_jids) ? b.group_jids.map(String) : [];
    const accountIds = Array.isArray(b?.account_ids)
      ? b.account_ids.map(Number).filter(Number.isInteger)
      : [];
    return json(res, 200, computeCoverage(groupJids, accountIds));
  }

  // --- Alvos (grupos/comunidades) ---
  if (match('POST', '/targets/sync')) {
    try {
      const result = await wa.syncTargets();
      return json(res, 200, result);
    } catch (err) {
      return json(res, 409, { error: 'not_connected', message: err.message });
    }
  }
  if (match('GET', '/targets')) {
    return json(res, 200, { targets: wa.listTargets() });
  }

  // --- Upload de midia (corpo binario) ---
  if (match('POST', '/media/upload')) {
    const buf = await readBuffer(req);
    if (!buf || buf.length === 0) {
      return json(res, 400, { error: 'bad_request', message: 'arquivo vazio' });
    }
    const mimetype = req.headers['content-type'] || 'application/octet-stream';
    const filename = decodeURIComponent(req.headers['x-filename'] || 'arquivo');
    const media = await saveUpload(mediaDir, buf, mimetype, filename);
    return json(res, 200, { media });
  }

  // --- Agendamentos ---
  if (match('POST', '/schedules')) {
    const body = await readJson(req);
    return createSchedule(res, body);
  }
  if (match('GET', '/schedules')) {
    return json(res, 200, { schedules: listSchedules() });
  }
  const detail = path.match(/^\/schedules\/(\d+)$/);
  if (method === 'GET' && detail) {
    return scheduleDetail(res, Number(detail[1]));
  }
  const cancel = path.match(/^\/schedules\/(\d+)\/cancel$/);
  if (method === 'POST' && cancel) {
    return cancelSchedule(res, Number(cancel[1]));
  }
  const reschedule = path.match(/^\/schedules\/(\d+)\/reschedule$/);
  if (method === 'POST' && reschedule) {
    return rescheduleSchedule(res, Number(reschedule[1]), await readJson(req));
  }
  const del = path.match(/^\/schedules\/(\d+)$/);
  if (method === 'DELETE' && del) {
    return deleteSchedule(res, Number(del[1]));
  }

  // --- Automacao por gatilho ---
  if (match('GET', '/automation/rules')) return json(res, 200, { rules: listRules() });
  if (match('POST', '/automation/rules')) return createRule(res, await readJson(req));
  if (match('GET', '/automation/logs')) return json(res, 200, { logs: listAutoLogs() });
  const ruleToggle = path.match(/^\/automation\/rules\/(\d+)\/toggle$/);
  if (method === 'POST' && ruleToggle) return toggleRule(res, Number(ruleToggle[1]));
  const ruleUpd = path.match(/^\/automation\/rules\/(\d+)$/);
  if (method === 'PUT' && ruleUpd) return updateRule(res, Number(ruleUpd[1]), await readJson(req));
  const ruleDel = path.match(/^\/automation\/rules\/(\d+)$/);
  if (method === 'DELETE' && ruleDel) return deleteRule(res, Number(ruleDel[1]));

  return json(res, 404, { error: 'not_found' });
}

// Le o corpo bruto (binario) — usado no upload de midia. Limite de 64 MB.
function readBuffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

// Le e parseia o corpo JSON da requisicao (limite simples de tamanho).
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// Cobertura group-first: dado um conjunto de grupos + chips candidatos, calcula
// quais chips cobrem cada grupo (sao membros) e quais grupos ficam descobertos.
function computeCoverage(groupJids, accountIds) {
  const gset = new Set(groupJids);
  if (groupJids.length === 0) return { total_groups: 0, by_account: [], uncovered: [] };

  const nameByJid = {};
  const nameRows = db
    .prepare(`SELECT DISTINCT jid, name FROM targets WHERE jid IN (${groupJids.map(() => '?').join(',')})`)
    .all(...groupJids);
  for (const r of nameRows) nameByJid[r.jid] = r.name;

  const coveredBy = {}; // jid -> Set(accountId)
  let accts = [];
  if (accountIds.length) {
    const ph = accountIds.map(() => '?').join(',');
    accts = db.prepare(`SELECT id, label FROM accounts WHERE id IN (${ph})`).all(...accountIds);
    const rows = db.prepare(`SELECT account_id, jid FROM targets WHERE account_id IN (${ph})`).all(...accountIds);
    for (const r of rows) {
      if (!gset.has(r.jid)) continue;
      (coveredBy[r.jid] ??= new Set()).add(r.account_id);
    }
  }

  const by_account = accts.map((a) => {
    const jids = groupJids.filter((j) => coveredBy[j]?.has(a.id));
    return { account_id: a.id, label: a.label, covers: jids.length, jids };
  });
  const uncovered = groupJids
    .filter((j) => !coveredBy[j] || coveredBy[j].size === 0)
    .map((j) => ({ jid: j, name: nameByJid[j] ?? null }));

  return { total_groups: groupJids.length, by_account, uncovered };
}

// --- Handlers de agendamento ---

function createSchedule(res, body) {
  const {
    name, scheduled_at, content_mode, default_text, targets,
    kind: rawKind, recur_dow, recur_time,
    payload_type: rawType, media, poll,
    messages, steps: rawSteps, step_min_s, step_max_s, account_ids,
  } = body ?? {};

  // Pool de chips selecionado (multi-chip) — o scheduler rotaciona por execucao.
  const poolJson =
    Array.isArray(account_ids) && account_ids.length
      ? JSON.stringify(account_ids.map(Number).filter(Number.isInteger))
      : null;

  if (!Array.isArray(targets) || targets.length === 0) {
    return json(res, 400, { error: 'bad_request', message: 'selecione ao menos um alvo' });
  }
  const kind = rawKind === 'recurring' ? 'recurring' : 'once';

  if (kind === 'once' && !scheduled_at) {
    return json(res, 400, { error: 'bad_request', message: 'data/hora obrigatoria' });
  }
  if (kind === 'recurring') {
    const dowOk = Number.isInteger(recur_dow) && recur_dow >= 0 && recur_dow <= 6;
    const timeOk = typeof recur_time === 'string' && /^\d{2}:\d{2}$/.test(recur_time);
    if (!dowOk || !timeOk) {
      return json(res, 400, { error: 'bad_request', message: 'dia da semana (0-6) e horario HH:MM obrigatorios' });
    }
  }

  const mode = content_mode === 'per_target' ? 'per_target' : 'broadcast';

  let payloadType = 'text';
  let defaultJson;
  let richSteps = null; // passos multi-formato (broadcast)
  let legacyTextSteps = null; // [string] (broadcast texto legado)
  let stepMin = null;
  let stepMax = null;

  if (mode === 'per_target') {
    // Mensagem especifica por grupo (somente texto, mensagem unica).
    payloadType = 'text';
    defaultJson = JSON.stringify({ text: String(default_text ?? '') });
  } else if (Array.isArray(rawSteps) && rawSteps.length > 0) {
    // SEQUENCIA MULTI-FORMATO: cada passo tem seu proprio tipo + conteudo.
    const normalized = [];
    for (const rs of rawSteps) {
      const n = normalizeStep(rs);
      if (n.error) return json(res, 400, { error: 'bad_request', message: n.error });
      normalized.push(n);
    }
    richSteps = normalized;
    payloadType = normalized.length > 1 ? 'sequence' : normalized[0].payload_type;
    defaultJson = normalized[0].body_json;
    if (normalized.length > 1) {
      stepMin = Number.isInteger(step_min_s) && step_min_s >= 0 ? step_min_s : 5;
      stepMax = Number.isInteger(step_max_s) && step_max_s >= stepMin ? step_max_s : stepMin;
    }
  } else {
    // Caminho legado (broadcast unico ou sequencia de texto via `messages`).
    payloadType = ['text', 'audio', 'video', 'image', 'poll'].includes(rawType) ? rawType : 'text';
    if (payloadType === 'text') {
      const msgs = Array.isArray(messages)
        ? messages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : [];
      const single = String(default_text ?? '').trim();
      if (msgs.length) legacyTextSteps = msgs;
      else if (single) legacyTextSteps = [single];
      else return json(res, 400, { error: 'bad_request', message: 'mensagem vazia' });
      defaultJson = JSON.stringify({ text: legacyTextSteps[0] });
      if (legacyTextSteps.length > 1) {
        stepMin = Number.isInteger(step_min_s) && step_min_s >= 0 ? step_min_s : 5;
        stepMax = Number.isInteger(step_max_s) && step_max_s >= stepMin ? step_max_s : stepMin;
      }
    } else if (payloadType === 'video' || payloadType === 'image') {
      if (!media?.stored_path) return json(res, 400, { error: 'bad_request', message: 'envie o arquivo' });
      defaultJson = JSON.stringify({ text: String(default_text ?? '') });
    } else if (payloadType === 'audio') {
      if (!media?.stored_path) return json(res, 400, { error: 'bad_request', message: 'envie o audio' });
      defaultJson = JSON.stringify({});
    } else {
      const values = Array.isArray(poll?.values)
        ? poll.values.map((v) => String(v).trim()).filter(Boolean)
        : [];
      if (!String(poll?.name ?? '').trim() || values.length < 2) {
        return json(res, 400, { error: 'bad_request', message: 'enquete precisa de pergunta e ao menos 2 opcoes' });
      }
      const selectableCount =
        Number.isInteger(poll.selectableCount) && poll.selectableCount >= 1
          ? Math.min(poll.selectableCount, values.length)
          : 1;
      defaultJson = JSON.stringify({ poll: { name: String(poll.name).trim(), values, selectableCount } });
    }
  }

  const now = new Date().toISOString();
  const account = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();

  // Recorrente: se hoje ja e o dia e a hora ja passou, marca como "rodado hoje".
  let initialLastRun = null;
  if (kind === 'recurring') {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getDay() === recur_dow && hhmm >= recur_time) {
      initialLastRun = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  }

  db.exec('BEGIN;');
  let scheduleId;
  try {
    const r = db
      .prepare(
        `INSERT INTO schedules
           (account_id, name, scheduled_at, payload_type, content_mode, default_json, status, created_at,
            kind, recur_dow, recur_time, last_run_at, step_min_s, step_max_s, account_ids_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        account?.id ?? null,
        name ?? null,
        kind === 'once' ? new Date(scheduled_at).toISOString() : null,
        payloadType,
        mode,
        defaultJson,
        kind === 'once' ? 'pending' : 'active',
        now,
        kind,
        kind === 'recurring' ? recur_dow : null,
        kind === 'recurring' ? recur_time : null,
        initialLastRun,
        stepMin,
        stepMax,
        poolJson
      );
    scheduleId = r.lastInsertRowid;

    if (richSteps) {
      // Passos multi-formato (autossuficientes).
      const insStep = db.prepare(
        `INSERT INTO schedule_steps
           (schedule_id, order_index, payload_type, body_json,
            media_path, media_mimetype, media_kind, media_duration_seconds, media_waveform_json)
         VALUES (?,?,?,?,?,?,?,?,?)`
      );
      richSteps.forEach((s, idx) =>
        insStep.run(
          scheduleId, idx, s.payload_type, s.body_json,
          s.media?.stored_path ?? null,
          s.media?.mimetype ?? null,
          s.media?.kind ?? null,
          s.media?.duration_seconds ?? null,
          s.media?.waveform_json ?? null
        )
      );
    } else if (legacyTextSteps) {
      // Sequencia de texto legada (coluna text).
      const insStep = db.prepare(
        'INSERT INTO schedule_steps (schedule_id, order_index, payload_type, body_json, text) VALUES (?,?,?,?,?)'
      );
      legacyTextSteps.forEach((t, idx) =>
        insStep.run(scheduleId, idx, 'text', JSON.stringify({ text: t }), t)
      );
    } else if (['audio', 'video', 'image'].includes(payloadType)) {
      // Midia unica legada.
      db.prepare(
        `INSERT INTO media_assets (schedule_id, path, mimetype, kind, duration_seconds, waveform_json)
         VALUES (?,?,?,?,?,?)`
      ).run(
        scheduleId,
        media.stored_path,
        media.mimetype ?? null,
        media.kind ?? payloadType,
        media.duration_seconds ?? null,
        media.waveform_json ?? null
      );
    }

    const insTarget = db.prepare(
      `INSERT INTO schedule_targets (schedule_id, target_id, account_id, message_json, status)
       VALUES (?,?,?,?,?)`
    );
    for (const t of targets) {
      const targetId = typeof t === 'object' ? t.target_id : t;
      // Roteamento multi-chip: account_id define qual chip envia (null = primaria).
      const accountId = typeof t === 'object' && Number.isInteger(t.account_id) ? t.account_id : null;
      const skipped = typeof t === 'object' && t.skipped;
      const perText = typeof t === 'object' ? t.message : null;
      const msgJson = mode === 'per_target' && perText ? JSON.stringify({ text: String(perText) }) : null;
      insTarget.run(scheduleId, targetId, accountId, msgJson, skipped ? 'skipped_no_coverage' : 'pending');
    }
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return json(res, 500, { error: 'internal', message: e?.message ?? 'erro ao criar' });
  }

  return json(res, 201, { id: scheduleId });
}

// --- Handlers de automacao ---

function listRules() {
  const rules = db
    .prepare('SELECT * FROM automation_rules ORDER BY id DESC')
    .all();
  return rules.map((r) => ({
    ...r,
    scope_json: undefined,
    account_ids_json: undefined,
    scope: safeArr(r.scope_json),
    account_ids: safeArr(r.account_ids_json),
    actions: db
      .prepare('SELECT action_type, config_json, order_index FROM automation_actions WHERE rule_id = ? ORDER BY order_index')
      .all(r.id)
      .map((a) => ({ action_type: a.action_type, order_index: a.order_index, config: safeObj(a.config_json) })),
  }));
}

// Valida o corpo de uma regra (create/update). Retorna { error } ou os campos prontos.
function validateRuleBody(body) {
  const { name, trigger_type: rawTrigger, match_type, pattern, case_sensitive, scope, actions, account_ids } = body ?? {};
  const accountIdsJson =
    Array.isArray(account_ids) && account_ids.length
      ? JSON.stringify(account_ids.map(Number).filter(Number.isInteger))
      : null;
  const trigger = ['message', 'message_link', 'join', 'leave'].includes(rawTrigger) ? rawTrigger : 'message';

  if (!String(name ?? '').trim()) return { error: 'nome obrigatorio' };
  if (trigger === 'message') {
    const validMatch = ['starts_with', 'contains', 'ends_with', 'exact'].includes(match_type);
    if (!validMatch || !String(pattern ?? '').trim()) return { error: 'tipo de match e padrao sao obrigatorios' };
  }
  if (!Array.isArray(scope) || scope.length === 0) return { error: 'selecione ao menos um grupo' };
  if (!Array.isArray(actions) || actions.length === 0) return { error: 'defina ao menos uma acao' };

  const prepared = [];
  for (const a of actions) {
    const type = ['group_message', 'dm', 'remove', 'webhook'].includes(a?.type) ? a.type : null;
    if (!type) continue;
    let cfg = {};
    if (type === 'group_message' || type === 'dm') {
      const rawSteps = Array.isArray(a.steps) && a.steps.length
        ? a.steps
        : a.text
          ? [{ type: 'text', text: a.text }]
          : [];
      if (rawSteps.length === 0) return { error: 'uma acao de mensagem esta vazia' };
      const norm = [];
      for (const rs of rawSteps) {
        const n = normalizeStep(rs);
        if (n.error) return { error: n.error };
        norm.push(n);
      }
      cfg = { steps: norm };
      if (norm.length > 1) {
        cfg.step_min_s = Number.isInteger(a.step_min_s) && a.step_min_s >= 0 ? a.step_min_s : 5;
        cfg.step_max_s = Number.isInteger(a.step_max_s) && a.step_max_s >= cfg.step_min_s ? a.step_max_s : cfg.step_min_s;
      }
    } else if (type === 'webhook') {
      if (!/^https?:\/\//i.test(String(a.url ?? ''))) return { error: 'webhook precisa de url http(s)' };
      cfg = { url: String(a.url), secret: String(a.secret ?? '') };
    }
    // Intervalo irregular (janela) antes da proxima acao.
    const dmin = Number.isInteger(a.delay_min_s) && a.delay_min_s >= 0 ? a.delay_min_s : 0;
    const dmax = Number.isInteger(a.delay_max_s) && a.delay_max_s >= dmin ? a.delay_max_s : dmin;
    if (dmax > 0) {
      cfg.delay_min_s = dmin;
      cfg.delay_max_s = dmax;
    }
    prepared.push({ type, cfg });
  }
  if (prepared.length === 0) return { error: 'defina ao menos uma acao valida' };

  return {
    trigger,
    match_type: trigger === 'message' ? match_type : null,
    pattern: trigger === 'message' ? String(pattern) : null,
    case_sensitive: case_sensitive ? 1 : 0,
    scope: JSON.stringify(Array.isArray(scope) ? scope : []),
    account_ids_json: accountIdsJson,
    prepared,
  };
}

function insertActions(ruleId, prepared) {
  const insAct = db.prepare(
    'INSERT INTO automation_actions (rule_id, action_type, config_json, order_index) VALUES (?,?,?,?)'
  );
  prepared.forEach((p, idx) => insAct.run(ruleId, p.type, JSON.stringify(p.cfg), idx));
}

function createRule(res, body) {
  const v = validateRuleBody(body);
  if (v.error) return json(res, 400, { error: 'bad_request', message: v.error });
  const account = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();

  db.exec('BEGIN;');
  let ruleId;
  try {
    const r = db
      .prepare(
        `INSERT INTO automation_rules (account_id, name, enabled, trigger_type, match_type, pattern, case_sensitive, scope_json, account_ids_json)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(account?.id ?? null, String(body.name).trim(), 1, v.trigger, v.match_type, v.pattern, v.case_sensitive, v.scope, v.account_ids_json);
    ruleId = r.lastInsertRowid;
    insertActions(ruleId, v.prepared);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return json(res, 500, { error: 'internal', message: e?.message });
  }
  return json(res, 201, { id: ruleId });
}

function updateRule(res, id, body) {
  const existing = db.prepare('SELECT id FROM automation_rules WHERE id = ?').get(id);
  if (!existing) return json(res, 404, { error: 'not_found' });
  const v = validateRuleBody(body);
  if (v.error) return json(res, 400, { error: 'bad_request', message: v.error });

  db.exec('BEGIN;');
  try {
    db.prepare(
      `UPDATE automation_rules SET name=?, trigger_type=?, match_type=?, pattern=?, case_sensitive=?, scope_json=?, account_ids_json=? WHERE id=?`
    ).run(String(body.name).trim(), v.trigger, v.match_type, v.pattern, v.case_sensitive, v.scope, v.account_ids_json, id);
    db.prepare('DELETE FROM automation_actions WHERE rule_id = ?').run(id);
    insertActions(id, v.prepared);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return json(res, 500, { error: 'internal', message: e?.message });
  }
  return json(res, 200, { ok: true });
}

function toggleRule(res, id) {
  const r = db.prepare('SELECT enabled FROM automation_rules WHERE id = ?').get(id);
  if (!r) return json(res, 404, { error: 'not_found' });
  db.prepare('UPDATE automation_rules SET enabled = ? WHERE id = ?').run(r.enabled ? 0 : 1, id);
  return json(res, 200, { enabled: r.enabled ? 0 : 1 });
}

function deleteRule(res, id) {
  db.exec('BEGIN;');
  try {
    db.prepare('DELETE FROM automation_actions WHERE rule_id = ?').run(id);
    db.prepare('DELETE FROM automation_rules WHERE id = ?').run(id);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return json(res, 500, { error: 'internal', message: e?.message });
  }
  return json(res, 200, { ok: true });
}

function listAutoLogs() {
  return db
    .prepare(
      `SELECT l.id, l.target_jid, l.sender_e164, l.matched_text, l.actions_taken, l.created_at,
              r.name AS rule_name, a.label AS chip_label
         FROM automation_logs l
         LEFT JOIN automation_rules r ON r.id = l.rule_id
         LEFT JOIN accounts a ON a.id = l.account_id
        ORDER BY l.id DESC LIMIT 100`
    )
    .all();
}

function safeArr(s) {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function safeObj(s) {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
}

// Valida e normaliza um passo de sequencia (qualquer formato).
// Retorna { payload_type, body_json, media } ou { error }.
function normalizeStep(raw) {
  const type = ['text', 'image', 'audio', 'video', 'poll'].includes(raw?.type) ? raw.type : 'text';

  if (type === 'text') {
    const text = String(raw.text ?? '').trim();
    if (!text) return { error: 'mensagem de texto vazia na sequencia' };
    return { payload_type: 'text', body_json: JSON.stringify({ text }), media: null };
  }
  if (type === 'image' || type === 'video') {
    if (!raw.media?.stored_path) return { error: `envie o arquivo de ${type === 'image' ? 'imagem' : 'video'}` };
    const caption = String(raw.text ?? raw.caption ?? '');
    return { payload_type: type, body_json: JSON.stringify({ caption }), media: raw.media };
  }
  if (type === 'audio') {
    if (!raw.media?.stored_path) return { error: 'envie o arquivo de audio' };
    return { payload_type: 'audio', body_json: JSON.stringify({}), media: raw.media };
  }
  // poll
  const values = Array.isArray(raw.poll?.values)
    ? raw.poll.values.map((v) => String(v).trim()).filter(Boolean)
    : [];
  if (!String(raw.poll?.name ?? '').trim() || values.length < 2) {
    return { error: 'enquete da sequencia precisa de pergunta e 2+ opcoes' };
  }
  const selectableCount =
    Number.isInteger(raw.poll.selectableCount) && raw.poll.selectableCount >= 1
      ? Math.min(raw.poll.selectableCount, values.length)
      : 1;
  return {
    payload_type: 'poll',
    body_json: JSON.stringify({ poll: { name: String(raw.poll.name).trim(), values, selectableCount } }),
    media: null,
  };
}

function listSchedules() {
  return db
    .prepare(
      `SELECT s.id, s.name, s.scheduled_at, s.payload_type, s.content_mode, s.status, s.created_at,
              s.kind, s.recur_dow, s.recur_time, s.last_run_at,
              COUNT(st.id) AS total,
              SUM(st.status = 'sent')   AS sent,
              SUM(st.status = 'failed') AS failed,
              SUM(st.status = 'skipped_no_coverage') AS skipped,
              GROUP_CONCAT(DISTINCT a.label) AS chips
         FROM schedules s
         LEFT JOIN schedule_targets st ON st.schedule_id = s.id
         LEFT JOIN accounts a ON a.id = st.account_id
        GROUP BY s.id
        ORDER BY s.created_at DESC`
    )
    .all();
}

function scheduleDetail(res, id) {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!schedule) return json(res, 404, { error: 'not_found' });
  const targets = db
    .prepare(
      `SELECT st.id, st.status, st.sent_at, st.error, st.message_json, t.name, t.jid
         FROM schedule_targets st JOIN targets t ON t.id = st.target_id
        WHERE st.schedule_id = ?`
    )
    .all(id);
  return json(res, 200, { schedule, targets });
}

function cancelSchedule(res, id) {
  const s = db.prepare('SELECT status FROM schedules WHERE id = ?').get(id);
  if (!s) return json(res, 404, { error: 'not_found' });
  // 'pending' = unico aguardando; 'active' = recorrente em vigor. Ambos podem ser cancelados.
  if (s.status !== 'pending' && s.status !== 'active') {
    return json(res, 409, { error: 'not_cancelable', message: 'agendamento nao pode ser cancelado neste estado' });
  }
  db.prepare("UPDATE schedules SET status = 'canceled' WHERE id = ?").run(id);
  db.prepare("UPDATE schedule_targets SET status = 'canceled' WHERE schedule_id = ? AND status = 'pending'").run(id);
  return json(res, 200, { ok: true });
}

// Apaga um agendamento por completo (registros + arquivos de midia).
function deleteSchedule(res, id) {
  const s = db.prepare('SELECT id FROM schedules WHERE id = ?').get(id);
  if (!s) return json(res, 404, { error: 'not_found' });

  const assets = db.prepare('SELECT path FROM media_assets WHERE schedule_id = ?').all(id);
  db.exec('BEGIN;');
  try {
    db.prepare('DELETE FROM schedule_targets WHERE schedule_id = ?').run(id);
    db.prepare('DELETE FROM schedule_steps WHERE schedule_id = ?').run(id);
    db.prepare('DELETE FROM media_assets WHERE schedule_id = ?').run(id);
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    return json(res, 500, { error: 'internal', message: e?.message });
  }
  // Remove os arquivos de midia do disco (fora da transacao).
  for (const a of assets) {
    if (a.path) rmSync(a.path, { force: true });
  }
  return json(res, 200, { ok: true });
}

// Reagenda: muda data/hora (unico) ou dia/horario (recorrente) e reabilita o disparo.
function rescheduleSchedule(res, id, body) {
  const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!s) return json(res, 404, { error: 'not_found' });

  if (s.kind === 'once') {
    if (!body?.scheduled_at) {
      return json(res, 400, { error: 'bad_request', message: 'data/hora obrigatoria' });
    }
    db.prepare("UPDATE schedules SET scheduled_at = ?, status = 'pending' WHERE id = ?")
      .run(new Date(body.scheduled_at).toISOString(), id);
  } else {
    const dowOk = Number.isInteger(body?.recur_dow) && body.recur_dow >= 0 && body.recur_dow <= 6;
    const timeOk = typeof body?.recur_time === 'string' && /^\d{2}:\d{2}$/.test(body.recur_time);
    if (!dowOk || !timeOk) {
      return json(res, 400, { error: 'bad_request', message: 'dia (0-6) e horario HH:MM obrigatorios' });
    }
    db.prepare("UPDATE schedules SET recur_dow = ?, recur_time = ?, status = 'active', last_run_at = NULL WHERE id = ?")
      .run(body.recur_dow, body.recur_time, id);
  }
  // Reabilita os alvos que nao foram enviados ainda (ou todos, para refazer).
  db.prepare("UPDATE schedule_targets SET status = 'pending', sent_at = NULL, error = NULL, seq_step = 0 WHERE schedule_id = ? AND status != 'skipped_no_coverage'").run(id);
  return json(res, 200, { ok: true });
}

// Bind em porta efemera no loopback; o OS escolhe a porta livre.
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // O core Rust le este marcador no stdout para descobrir a porta.
  console.log(`${READY_MARKER}${JSON.stringify({ port })}`);
});

function shutdown(signal) {
  console.error(`[sidecar] recebido ${signal}, encerrando.`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* noop */
    }
    process.exit(0);
  });
  // Failsafe: nao trava se conexoes ficarem penduradas.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Se o pai (Rust) morrer, o stdin fecha — encerramos junto.
process.stdin.on('close', () => shutdown('stdin-close'));
process.stdin.resume();
