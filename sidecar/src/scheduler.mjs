// Worker do agendador (Fase 2). A fila vive no SQLite (fonte de verdade).
// Um tick periodico re-hidrata a fila a cada arranque: nada se perde em reinicio.
// Disparo sequencial com espacamento curto e levemente aleatorio entre grupos —
// apenas para nao floodar e respeitar rate limit, nunca para evadir deteccao.

import { readFileSync } from 'node:fs';

const TICK_MS = 5000;
const SPACING_MIN_MS = 2500;
const SPACING_MAX_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => SPACING_MIN_MS + Math.floor(Math.random() * (SPACING_MAX_MS - SPACING_MIN_MS));

export function createScheduler(db, wa) {
  const inFlight = new Set();
  let timer = null;

  // Roteamento por chip (Milestone 2). account_id nulo = conta primaria.
  const isReachable = (accountId) =>
    accountId ? wa.isAccountConnected(accountId) : wa.isConnected();
  function sendVia(accountId, jid, content) {
    if (accountId) {
      if (!wa.isAccountConnected(accountId)) throw new Error('chip desconectado');
      return wa.accountSend(accountId, jid, content);
    }
    return wa.sendContent(jid, content); // conta primaria (single-chip)
  }
  const anyConnected = () => wa.isConnected() || wa.connectedAccountIds().length > 0;

  // Chips do pool que sao membros do grupo E estao conectados (ordenados por id).
  function memberConnectedChips(jid, pool) {
    if (!Array.isArray(pool) || pool.length === 0) return [];
    const ph = pool.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT DISTINCT account_id FROM targets WHERE jid = ? AND account_id IN (${ph})`)
      .all(jid, ...pool);
    return rows
      .map((r) => r.account_id)
      .filter((id) => id && wa.isAccountConnected(id))
      .sort((a, b) => a - b);
  }

  // Resolve, EM TEMPO DE DISPARO, qual chip envia o alvo (rodizio por grupo +
  // failover). pool vazio (single-chip) -> usa o fallback (geralmente a primaria).
  function resolveChip(pool, offset, jid, fallbackAccountId, index) {
    const covering = memberConnectedChips(jid, pool);
    if (covering.length) return covering[(offset + index) % covering.length];
    return fallbackAccountId; // chip fixo (se conectado) ou null = primaria
  }

  function start() {
    // Re-hidratacao: agendamentos que ficaram 'sending' (app caiu no meio)
    // voltam para 'pending' e os alvos ja enviados continuam marcados como sent.
    db.prepare("UPDATE schedules SET status = 'pending' WHERE status = 'sending'").run();
    timer = setInterval(() => tick().catch((e) => console.error('[sched] tick erro:', e?.message)), TICK_MS);
    tick().catch(() => {});
    console.error('[sched] worker iniciado');
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  async function tick() {
    if (!anyConnected()) return; // nenhum chip conectado; tenta no proximo tick
    await tickOnce();
    await tickRecurring();
  }

  // --- Disparo unico ---
  async function tickOnce() {
    const nowIso = new Date().toISOString();
    const due = db
      .prepare(
        "SELECT id FROM schedules WHERE kind = 'once' AND status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at"
      )
      .all(nowIso);

    for (const { id } of due) {
      if (inFlight.has(id)) continue;
      inFlight.add(id);
      try {
        await processOnce(id);
      } catch (e) {
        console.error(`[sched] falha no agendamento ${id}:`, e?.message);
      } finally {
        inFlight.delete(id);
      }
    }
  }

  async function processOnce(scheduleId) {
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId);
    if (!schedule || schedule.status !== 'pending') return;
    db.prepare("UPDATE schedules SET status = 'sending' WHERE id = ?").run(scheduleId);
    await sendPending(scheduleId, schedule);
    finalizeStatus(scheduleId);
  }

  // --- Disparo recorrente (semanal: dia da semana + horario local) ---
  async function tickRecurring() {
    const now = new Date();
    const dow = now.getDay();
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const today = localDate(now);

    const recs = db
      .prepare("SELECT * FROM schedules WHERE kind = 'recurring' AND status = 'active'")
      .all();

    for (const s of recs) {
      if (s.recur_dow !== dow) continue;
      if (hhmm < (s.recur_time ?? '99:99')) continue; // ainda nao chegou a hora
      if (s.last_run_at === today) continue; // ja disparou hoje (ou criado para pular hoje)
      if (inFlight.has(s.id)) continue;

      inFlight.add(s.id);
      try {
        // Marca o dia ANTES de enviar: no maximo um disparo por dia, sem duplicar.
        // Catch-up: se o app estava fora as 19:00 e subiu 19:10, ainda dispara hoje.
        db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(today, s.id);
        db.prepare(
          "UPDATE schedule_targets SET status = 'pending', sent_at = NULL, error = NULL, seq_step = 0 WHERE schedule_id = ?"
        ).run(s.id);
        console.error(`[sched] recorrente #${s.id} disparando ${today} ${hhmm}`);
        await sendPending(s.id, s); // status do schedule permanece 'active'
      } catch (e) {
        console.error(`[sched] falha no recorrente ${s.id}:`, e?.message);
      } finally {
        inFlight.delete(s.id);
      }
    }
  }

  // --- Loop de envio compartilhado ---
  async function sendPending(scheduleId, schedule) {
    const targets = db
      .prepare(
        `SELECT st.id, st.message_json, st.account_id, st.seq_step, t.jid, t.name
           FROM schedule_targets st
           JOIN targets t ON t.id = st.target_id
          WHERE st.schedule_id = ? AND st.status = 'pending'`
      )
      .all(scheduleId);

    // Multi-chip: pool de chips selecionado + offset de rotacao (rodizio por execucao).
    const pool = parseArr(schedule.account_ids_json);
    const offset = schedule.rotation_offset || 0;
    // Resolve o chip de cada alvo no disparo (rodizio + failover) e grava o real usado.
    const chipFor = (tgt, i) => {
      if (!pool.length) return tgt.account_id;
      const acct = resolveChip(pool, offset, tgt.jid, tgt.account_id, i);
      if (acct !== tgt.account_id) {
        db.prepare('UPDATE schedule_targets SET account_id = ? WHERE id = ?').run(acct, tgt.id);
        tgt.account_id = acct;
      }
      return acct;
    };

    // Sequencia de mensagens (broadcast texto): 1+ passos com intervalo entre eles.
    if (schedule.content_mode === 'broadcast') {
      const steps = db
        .prepare('SELECT * FROM schedule_steps WHERE schedule_id = ? ORDER BY order_index')
        .all(scheduleId);
      if (steps.length > 0) {
        await sendSequence(scheduleId, schedule, targets, steps, chipFor);
        if (pool.length) bumpRotation(scheduleId);
        return;
      }
      // sem passos: agendamento legado (midia/poll/texto unico via default_json)
    }

    // Midia (imagem/audio/video) lida do disco uma vez e reutilizada nos alvos.
    let media = null;
    let mediaBuffer = null;
    if (['audio', 'video', 'image'].includes(schedule.payload_type)) {
      media = db.prepare('SELECT * FROM media_assets WHERE schedule_id = ? LIMIT 1').get(scheduleId);
      if (media?.path) {
        try {
          mediaBuffer = readFileSync(media.path);
        } catch (e) {
          console.error(`[sched] midia ausente p/ #${scheduleId}: ${e?.message}`);
        }
      }
    }

    for (let i = 0; i < targets.length; i++) {
      const tgt = targets[i];
      const acct = chipFor(tgt, i);
      const content = buildContent(schedule, tgt, media, mediaBuffer);

      try {
        await sendVia(acct, tgt.jid, content);
        db.prepare(
          "UPDATE schedule_targets SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?"
        ).run(new Date().toISOString(), tgt.id);
        console.error(`[sched] enviado #${scheduleId}${acct ? ` [chip ${acct}]` : ''} -> ${tgt.name || tgt.jid}`);
      } catch (e) {
        if (!isReachable(acct)) {
          console.error(`[sched] chip indisponivel durante #${scheduleId}; mantendo pendentes`);
          continue;
        }
        db.prepare("UPDATE schedule_targets SET status = 'failed', error = ? WHERE id = ?").run(
          e?.message ?? 'erro', tgt.id
        );
        console.error(`[sched] FALHA #${scheduleId} -> ${tgt.name || tgt.jid}: ${e?.message}`);
      }

      if (i < targets.length - 1) await sleep(jitter());
    }
    if (pool.length) bumpRotation(scheduleId);
  }

  // Avanca o offset de rotacao do schedule (rodizio entre execucoes).
  function bumpRotation(scheduleId) {
    db.prepare('UPDATE schedules SET rotation_offset = rotation_offset + 1 WHERE id = ?').run(scheduleId);
  }

  function finalizeStatus(scheduleId) {
    const counts = db
      .prepare(
        `SELECT
           SUM(status = 'sent')   AS sent,
           SUM(status = 'failed') AS failed,
           SUM(status = 'pending') AS pending,
           COUNT(*) AS total
         FROM schedule_targets WHERE schedule_id = ?`
      )
      .get(scheduleId);

    let status;
    if (counts.pending > 0) status = 'pending'; // sobrou algo (ex: caiu a conexao) — re-tenta no proximo tick
    else if (counts.failed === 0) status = 'sent';
    else if (counts.sent === 0) status = 'failed';
    else status = 'partial';

    db.prepare('UPDATE schedules SET status = ? WHERE id = ?').run(status, scheduleId);
  }

  // Envio de sequencia: cada passo vai para todos os alvos; entre passos,
  // espera uma janela aleatoria (step_min_s..step_max_s).
  // Resumability (#7): `seq_step` por alvo guarda o ultimo passo enviado; numa
  // queda, ao re-rodar, cada alvo retoma de onde parou (sem reenviar passos).
  async function sendSequence(scheduleId, schedule, targets, steps, chipFor) {
    const minMs = (schedule.step_min_s ?? 0) * 1000;
    const maxMs = Math.max(minMs, (schedule.step_max_s ?? schedule.step_min_s ?? 0) * 1000);
    const failed = {}; // target.id -> erro
    const stuck = new Set(); // alvos cujo chip caiu no meio -> seguem 'pending'
    const bufCache = new Map(); // media_path -> Buffer (le cada arquivo so uma vez)
    // Cada alvo usa um unico chip em toda a sequencia (resolvido uma vez).
    const chipByTarget = {};
    targets.forEach((t, i) => { chipByTarget[t.id] = chipFor ? chipFor(t, i) : t.account_id; });

    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      // Le a midia do passo (imagem/audio/video), com cache por caminho.
      let mediaBuffer = null;
      if (step.media_path) {
        if (!bufCache.has(step.media_path)) {
          try {
            bufCache.set(step.media_path, readFileSync(step.media_path));
          } catch (e) {
            bufCache.set(step.media_path, null);
            console.error(`[sched] midia do passo ausente (#${scheduleId}): ${e?.message}`);
          }
        }
        mediaBuffer = bufCache.get(step.media_path);
      }
      const content = buildStepContent(step, mediaBuffer);

      for (let i = 0; i < targets.length; i++) {
        const tgt = targets[i];
        if (failed[tgt.id] || stuck.has(tgt.id)) continue;
        if (s < (tgt.seq_step || 0)) continue; // passo ja enviado a este alvo (retomada)
        const acct = chipByTarget[tgt.id];
        try {
          await sendVia(acct, tgt.jid, content);
          db.prepare('UPDATE schedule_targets SET seq_step = ? WHERE id = ?').run(s + 1, tgt.id);
          tgt.seq_step = s + 1;
          console.error(`[sched] seq #${scheduleId} passo ${s + 1}/${steps.length}${acct ? ` [chip ${acct}]` : ''} -> ${tgt.name || tgt.jid}`);
        } catch (e) {
          if (!isReachable(acct)) {
            console.error(`[sched] chip indisponivel na sequencia #${scheduleId}; mantendo pendente`);
            stuck.add(tgt.id); // segue 'pending' -> retoma do seq_step no proximo tick
            continue;
          }
          failed[tgt.id] = e?.message ?? 'erro';
        }
        if (i < targets.length - 1) await sleep(jitter());
      }
      // Intervalo entre mensagens (nao apos a ultima).
      if (s < steps.length - 1) {
        const wait = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
        console.error(`[sched] seq #${scheduleId}: aguardando ${Math.round(wait / 1000)}s ate o proximo passo`);
        await sleep(wait);
      }
    }

    // Marca status final por alvo (sequencia concluida). seq_step volta a 0.
    const now = new Date().toISOString();
    for (const tgt of targets) {
      if (stuck.has(tgt.id)) continue; // chip caiu -> permanece 'pending' (re-tenta)
      if (failed[tgt.id]) {
        db.prepare("UPDATE schedule_targets SET status = 'failed', error = ? WHERE id = ?").run(failed[tgt.id], tgt.id);
      } else {
        db.prepare("UPDATE schedule_targets SET status = 'sent', sent_at = ?, error = NULL, seq_step = 0 WHERE id = ?").run(now, tgt.id);
      }
    }
  }

  return { start, stop, tick };
}

// Conteudo de um PASSO de sequencia (autossuficiente: tipo + corpo + midia).
function buildStepContent(step, mediaBuffer) {
  const type = step.payload_type || 'text';
  const body = step.body_json ? parseContent(step.body_json) : { text: step.text ?? '' };
  switch (type) {
    case 'image':
      return { image: mediaBuffer, caption: body.caption ? String(body.caption) : undefined };
    case 'video':
      return { video: mediaBuffer, caption: body.caption ? String(body.caption) : undefined };
    case 'audio':
      return {
        audio: mediaBuffer,
        ptt: true,
        mimetype: step.media_mimetype || 'audio/ogg; codecs=opus',
        seconds: step.media_duration_seconds || undefined,
        waveform: waveformBuffer(step.media_waveform_json),
      };
    case 'poll':
      return { poll: body.poll };
    default:
      return { text: body.text ?? step.text ?? '' };
  }
}

// Monta o objeto de conteudo do Baileys conforme o tipo do agendamento (legado/per_target).
function buildContent(schedule, tgt, media, mediaBuffer) {
  switch (schedule.payload_type) {
    case 'audio':
      return {
        audio: mediaBuffer,
        ptt: true, // nota de voz (com a ondinha), nao anexo de arquivo
        mimetype: media?.mimetype || 'audio/ogg; codecs=opus',
        seconds: media?.duration_seconds || undefined,
        waveform: waveformBuffer(media?.waveform_json),
      };
    case 'image': {
      const c = parseContent(schedule.default_json);
      return { image: mediaBuffer, caption: c.text ? String(c.text) : undefined };
    }
    case 'video': {
      const c = parseContent(schedule.default_json);
      return { video: mediaBuffer, caption: c.text ? String(c.text) : undefined };
    }
    case 'poll': {
      const c = parseContent(schedule.default_json);
      const p = c.poll ?? {};
      return { poll: { name: p.name, values: p.values, selectableCount: p.selectableCount ?? 1 } };
    }
    default: {
      // texto: suporta override por alvo (per_target)
      return schedule.content_mode === 'per_target' && tgt.message_json
        ? parseContent(tgt.message_json)
        : parseContent(schedule.default_json);
    }
  }
}

function waveformBuffer(waveformJson) {
  if (!waveformJson) return undefined;
  try {
    const arr = JSON.parse(waveformJson);
    return Array.isArray(arr) ? Uint8Array.from(arr) : undefined;
  } catch {
    return undefined;
  }
}

function parseContent(jsonStr) {
  try {
    return JSON.parse(jsonStr ?? '{}');
  } catch {
    return { text: '' };
  }
}

// Array de account_ids (pool de chips) a partir do JSON; [] se ausente/invalido.
function parseArr(jsonStr) {
  try {
    const v = JSON.parse(jsonStr ?? '[]');
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Data local YYYY-MM-DD (para marcar o dia do disparo recorrente).
function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
