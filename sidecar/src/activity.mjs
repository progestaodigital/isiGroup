// Aba Log: visao unica do que o programa fez, esta fazendo e vai fazer.
// So LEITURA — agrega as tabelas que cada motor ja grava (agendamentos,
// acoes em massa, automacoes, planos, isiLink) num formato comum.
//
// Linha macro: { key, kind, title, sub, status, at, ok, failed, skipped, total }
//   status: scheduled | running | done | partial | failed | canceled
// Detalhe:    { info?, phone?, items: [{ name, phone?, sub, status: ok|failed|skipped|pending, detail }] }
//
// Recorrentes: cada disparo passado vira uma linha (schedule_run_items para
// mensagens; um bulk_job por execucao para edicao de grupos) e so a PROXIMA
// execucao aparece como agendada.

import { weekAllows } from './weeks.mjs';
import { localDate } from './scheduler.mjs';

const HISTORY_LIMIT = 300; // por fonte — a aba pagina no front

const AUTO_ACTION = {
  group_message: ['ok', 'Mensagem no grupo'],
  dm: ['ok', 'Mensagem no privado'],
  dm_failed: ['failed', 'Mensagem no privado falhou'],
  remove: ['ok', 'Membro removido'],
  remove_no_sender: ['skipped', 'Remover: remetente desconhecido'],
  remove_no_admin_chip: ['failed', 'Remover: nenhum chip admin'],
  remove_skipped_admin: ['skipped', 'Remover: alvo é admin (preservado)'],
  delete_message: ['ok', 'Mensagem apagada'],
  delete_failed: ['failed', 'Apagar mensagem falhou'],
  delete_no_message: ['skipped', 'Apagar: mensagem não encontrada'],
  delete_skipped_no_message: ['skipped', 'Apagar: mensagem não encontrada'],
  delete_no_admin_chip: ['failed', 'Apagar: nenhum chip admin'],
  webhook: ['ok', 'Webhook enfileirado'],
};

const TARGET_STATUS = {
  sent: ['ok', null],
  failed: ['failed', null],
  pending: ['pending', null],
  canceled: ['skipped', 'cancelado'],
  skipped_no_coverage: ['skipped', 'nenhum chip selecionado está no grupo'],
  skipped_no_admin: ['skipped', 'grupo só-admins sem chip admin'],
};

const PLAN_STEP = { done: 'ok', ok: 'ok', failed: 'failed', skipped: 'skipped', canceled: 'skipped' };

// Status macro a partir das contagens de um disparo/execucao.
export function runStatus({ ok = 0, failed = 0, pending = 0 }, running) {
  if (pending > 0) return running ? 'running' : 'partial'; // sobrou alvo sem envio
  if (failed === 0) return 'done';
  return ok === 0 ? 'failed' : 'partial';
}

// Proxima execucao de um recorrente semanal (dia + hora + paridade de semana).
// Hoje conta se ainda nao disparou (inclui o catch-up de horario ja passado).
export function nextRun(r, now = new Date()) {
  const [hh, mm] = String(r.recur_time ?? '00:00').split(':').map(Number);
  const today = localDate(now);
  for (let i = 0; i < 400; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm);
    if (d.getDay() !== r.recur_dow || !weekAllows(r, d)) continue;
    if (i === 0 && r.last_run_at === today) continue;
    return d.toISOString();
  }
  return null;
}

// 'YYYY-MM-DD' + 'HH:MM' locais -> ISO.
const localIso = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = String(time ?? '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0).toISOString();
};

const DOW = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const recurLabel = (r) =>
  `Toda ${DOW[r.recur_dow] ?? '?'} às ${r.recur_time ?? '?'}` +
  (r.recur_week_mod === 2 ? (r.recur_week_rem === 1 ? ' (semanas ímpares)' : ' (semanas pares)') : '');

function safeJson(s, fallback) {
  try {
    return JSON.parse(s ?? '') ?? fallback;
  } catch {
    return fallback;
  }
}

export function createActivity(db) {
  const groupName = (jid) =>
    db.prepare('SELECT name FROM targets WHERE jid = ? AND name IS NOT NULL LIMIT 1').get(jid)?.name ?? jid?.split('@')[0] ?? '';
  const chipLabels = () => new Map(db.prepare('SELECT id, label FROM accounts').all().map((a) => [a.id, a.label]));

  function list() {
    const rows = [];
    const today = localDate(new Date());

    // --- Agendamentos de mensagem: unicos + disparo atual dos recorrentes ---
    const scheds = db
      .prepare(
        `SELECT s.*,
                SUM(st.status = 'sent') AS ok, SUM(st.status = 'failed') AS failed,
                SUM(st.status LIKE 'skipped%' OR st.status = 'canceled') AS skipped,
                SUM(st.status = 'pending') AS pending, COUNT(st.id) AS total
           FROM schedules s LEFT JOIN schedule_targets st ON st.schedule_id = s.id
          GROUP BY s.id`
      )
      .all();
    for (const s of scheds) {
      const name = s.name || `Agendamento #${s.id}`;
      const c = { ok: s.ok ?? 0, failed: s.failed ?? 0, skipped: s.skipped ?? 0, total: s.total ?? 0 };
      if (s.kind !== 'recurring') {
        let status;
        if (s.status === 'canceled') status = 'canceled';
        else if (s.status === 'sending') status = 'running';
        else if (s.status === 'pending') status = c.ok + c.failed > 0 ? 'running' : 'scheduled'; // retomada pendente
        else status = s.status === 'sent' ? 'done' : s.status; // partial | failed
        rows.push({ key: `s:${s.id}`, kind: 'message', title: name, sub: 'Mensagem agendada', status, at: s.scheduled_at, ...c });
        continue;
      }
      // Recorrente: o disparo mais recente vive em schedule_targets.
      if (s.recur_fired_at) {
        const running = s.recur_fired_at === today && s.status === 'active' && s.pending > 0;
        rows.push({
          key: `s:${s.id}`,
          kind: 'message',
          title: name,
          sub: `Recorrente · ${recurLabel(s)}`,
          status: runStatus({ ...c, pending: s.pending ?? 0 }, running),
          at: localIso(s.recur_fired_at, s.recur_time),
          ...c,
        });
      }
      if (s.status === 'active') {
        rows.push({
          key: `sn:${s.id}`,
          kind: 'message',
          title: name,
          sub: `Recorrente · ${recurLabel(s)}`,
          status: 'scheduled',
          at: nextRun(s),
          ok: 0, failed: 0, skipped: 0, total: c.total,
        });
      }
    }

    // --- Disparos passados dos recorrentes (arquivados) ---
    const runs = db
      .prepare(
        `SELECT r.schedule_id, r.run_date, s.name, s.recur_time, s.recur_dow, s.recur_week_mod, s.recur_week_rem,
                SUM(r.status = 'sent') AS ok, SUM(r.status = 'failed') AS failed,
                SUM(r.status LIKE 'skipped%' OR r.status = 'canceled') AS skipped,
                SUM(r.status = 'pending') AS pending, COUNT(*) AS total
           FROM schedule_run_items r JOIN schedules s ON s.id = r.schedule_id
          GROUP BY r.schedule_id, r.run_date
          ORDER BY r.run_date DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT);
    for (const r of runs) {
      rows.push({
        key: `sr:${r.schedule_id}:${r.run_date}`,
        kind: 'message',
        title: r.name || `Agendamento #${r.schedule_id}`,
        sub: `Recorrente · ${recurLabel(r)}`,
        status: runStatus(r, false),
        at: localIso(r.run_date, r.recur_time),
        ok: r.ok ?? 0, failed: r.failed ?? 0, skipped: r.skipped ?? 0, total: r.total,
      });
    }

    // --- Acoes em massa (inclui cada execucao das edicoes recorrentes) ---
    const jobs = db
      .prepare(
        `SELECT j.*, r.name AS rec_name FROM bulk_jobs j LEFT JOIN bulk_recurring r ON r.id = j.recurring_id
          ORDER BY j.id DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT);
    for (const j of jobs) {
      const status =
        j.status === 'scheduled' ? 'scheduled'
        : j.status === 'running' ? 'running'
        : j.status === 'canceled' ? 'canceled'
        : runStatus({ ok: j.ok, failed: j.failed }, false);
      rows.push({
        key: `b:${j.id}`,
        kind: 'bulk',
        op: j.op,
        title: null,
        sub: j.rec_name ? `Edição recorrente · ${j.rec_name}` : j.recurring_id ? 'Edição recorrente' : 'Ação em massa',
        status,
        at: j.status === 'scheduled' ? j.run_at : j.created_at,
        ok: j.ok, failed: j.failed, skipped: j.skipped, total: j.total, done: j.done,
      });
    }
    for (const r of db.prepare("SELECT * FROM bulk_recurring WHERE status = 'active'").all()) {
      rows.push({
        key: `bn:${r.id}`,
        kind: 'bulk',
        op: r.op,
        title: null,
        sub: `Edição recorrente${r.name ? ` · ${r.name}` : ''} · ${recurLabel(r)}`,
        status: 'scheduled',
        at: nextRun(r),
        ok: 0, failed: 0, skipped: 0, total: safeJson(r.groups_json, []).length,
      });
    }

    // --- Automacoes disparadas ---
    const logs = db
      .prepare(
        `SELECT l.*, r.name AS rule_name FROM automation_logs l LEFT JOIN automation_rules r ON r.id = l.rule_id
          ORDER BY l.id DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT);
    for (const l of logs) {
      const acts = String(l.actions_taken ?? '').split(',').filter(Boolean).map((a) => AUTO_ACTION[a]?.[0] ?? 'ok');
      const ok = acts.filter((a) => a === 'ok').length;
      const failed = acts.filter((a) => a === 'failed').length;
      rows.push({
        key: `a:${l.id}`,
        kind: 'automation',
        title: `Automação: ${l.rule_name ?? `regra #${l.rule_id}`}`,
        sub: groupName(l.target_jid),
        status: acts.length === 0 ? 'done' : runStatus({ ok, failed }, false),
        at: l.created_at,
        ok, failed, skipped: acts.length - ok - failed, total: acts.length,
      });
    }

    // --- Planos (isiplan / MCP) ---
    for (const p of db
      .prepare('SELECT id, name, plan_id, status, total_steps, created_at FROM plan_runs ORDER BY id DESC LIMIT ?')
      .all(HISTORY_LIMIT)) {
      const c = db
        .prepare(
          `SELECT SUM(status IN ('done','ok')) AS ok, SUM(status = 'failed') AS failed,
                  SUM(status IN ('skipped','canceled')) AS skipped FROM plan_steps WHERE run_id = ?`
        )
        .get(p.id);
      rows.push({
        key: `p:${p.id}`,
        kind: 'plan',
        title: `Plano: ${p.name || p.plan_id || `#${p.id}`}`,
        sub: 'Planos & IA',
        status: p.status === 'done' ? runStatus({ ok: c.ok ?? 0, failed: c.failed ?? 0 }, false) : p.status,
        at: p.created_at,
        ok: c.ok ?? 0, failed: c.failed ?? 0, skipped: c.skipped ?? 0, total: p.total_steps,
      });
    }

    // --- Redirecionamento isiLink (cada aviso enviado ao isiLink) ---
    for (const e of db
      .prepare(
        `SELECT e.*, l.name AS link_name FROM isilink_events e LEFT JOIN isilink_links l ON l.id = e.link_id
          ORDER BY e.id DESC LIMIT ?`
      )
      .all(HISTORY_LIMIT)) {
      const failed = e.result === 'erro' || !!e.error;
      const what = e.result === 'created' ? 'Grupo criado' : e.ativo === 'sim' ? 'Grupo aberto' : 'Grupo fechado';
      rows.push({
        key: `i:${e.id}`,
        kind: 'isilink',
        title: `isiLink: ${e.link_name ?? `link #${e.link_id}`}`,
        sub: `${what} · ${groupName(e.jid)}`,
        status: failed ? 'failed' : 'done',
        at: e.created_at,
        ok: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, total: 1,
      });
    }

    // Em curso primeiro; depois agendadas (mais proxima primeiro); depois historico (mais recente primeiro).
    const rank = (r) => (r.status === 'running' ? 0 : r.status === 'scheduled' ? 1 : 2);
    rows.sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d) return d;
      const ta = Date.parse(a.at ?? '') || 0;
      const tb = Date.parse(b.at ?? '') || 0;
      return rank(a) === 1 ? ta - tb : tb - ta;
    });
    return rows;
  }

  // Itens de um disparo de schedule_targets / schedule_run_items.
  function targetItems(rows) {
    const chips = chipLabels();
    return rows.map((r) => {
      const [status, why] = TARGET_STATUS[r.status] ?? ['pending', r.status];
      const when = r.sent_at ? new Date(r.sent_at).toLocaleString('pt-BR') : null;
      const progress = r.status === 'pending' && r.seq_step > 0 ? `passo ${r.seq_step} enviado` : null;
      return {
        name: r.name ?? r.group_name ?? r.jid ?? r.group_jid,
        sub: chips.get(r.account_id) ?? null,
        status,
        detail: r.error || why || progress || when || (status === 'pending' ? 'aguardando' : null),
      };
    });
  }

  function detail(key) {
    const [k, a, b] = String(key ?? '').split(':');
    const id = Number(a);
    switch (k) {
      case 's':
      case 'sn': {
        const rows = db
          .prepare(
            `SELECT st.status, st.sent_at, st.error, st.account_id, st.seq_step, t.name, t.jid
               FROM schedule_targets st JOIN targets t ON t.id = st.target_id WHERE st.schedule_id = ? ORDER BY st.id`
          )
          .all(id);
        // Proxima execucao: so a lista de grupos que vao receber.
        if (k === 'sn') return { items: targetItems(rows).map((it) => ({ ...it, status: 'pending', detail: 'na próxima execução' })) };
        return { items: targetItems(rows) };
      }
      case 'sr':
        return {
          items: targetItems(
            db
              .prepare('SELECT * FROM schedule_run_items WHERE schedule_id = ? AND run_date = ? ORDER BY id')
              .all(id, b)
          ),
        };
      case 'b': {
        const chips = chipLabels();
        const items = db
          .prepare('SELECT group_jid, group_name, contact, status, detail, account_id FROM bulk_job_items WHERE job_id = ? ORDER BY id')
          .all(id)
          .map((it) => ({
            name: it.group_name ?? it.group_jid.split('@')[0],
            phone: it.contact ?? null,
            sub: chips.get(it.account_id) ?? null,
            status: it.status === 'ok' ? 'ok' : it.status === 'failed' ? 'failed' : it.status === 'skipped' ? 'skipped' : 'pending',
            detail: it.detail ?? (it.status === 'pending' ? 'aguardando' : null),
          }));
        return { items };
      }
      case 'bn': {
        const r = db.prepare('SELECT groups_json FROM bulk_recurring WHERE id = ?').get(id);
        return {
          items: safeJson(r?.groups_json, []).map((g) => ({
            name: g.name ?? g.jid,
            sub: null,
            status: 'pending',
            detail: 'na próxima execução',
          })),
        };
      }
      case 'a': {
        const l = db.prepare('SELECT * FROM automation_logs WHERE id = ?').get(id);
        if (!l) return { items: [] };
        return {
          info: `${groupName(l.target_jid)}${l.matched_text ? ` — "${l.matched_text}"` : ''}`,
          phone: l.sender_e164 ?? null,
          items: String(l.actions_taken ?? '')
            .split(',')
            .filter(Boolean)
            .map((act) => {
              const [status, label] = AUTO_ACTION[act] ?? ['ok', act];
              return { name: label, sub: null, status, detail: null };
            }),
        };
      }
      case 'p':
        return {
          items: db
            .prepare('SELECT order_index, action_type, status, detail FROM plan_steps WHERE run_id = ? ORDER BY order_index')
            .all(id)
            .map((s) => ({
              name: `${s.order_index + 1}. ${s.action_type}`,
              sub: null,
              status: PLAN_STEP[s.status] ?? 'pending',
              detail: s.detail ?? s.status,
            })),
        };
      case 'i': {
        const e = db.prepare('SELECT * FROM isilink_events WHERE id = ?').get(id);
        if (!e) return { items: [] };
        const failed = e.result === 'erro' || !!e.error;
        return {
          items: [
            {
              name: groupName(e.jid),
              sub: e.member_count != null ? `${e.member_count} membros` : null,
              status: failed ? 'failed' : 'ok',
              detail: [`ativo: ${e.ativo ?? '-'}`, e.result, e.http_status ? `HTTP ${e.http_status}` : null, e.error]
                .filter(Boolean)
                .join(' · '),
            },
          ],
        };
      }
      default:
        return null;
    }
  }

  return { list, detail };
}
