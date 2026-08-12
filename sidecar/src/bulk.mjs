// Acoes em massa (bulk) — operacoes de alto risco aplicadas a varios grupos.
//
// Dois grupos de operacoes:
//   * membros: add_members | remove_members | promote | demote  (usa lista de contatos)
//   * grupo:   set_name | set_description | set_picture | set_settings  (so grupos)
//
// A fila vive no SQLite (fonte de verdade), como no scheduler: o worker processa
// os itens 'pending' com espacamento aleatorio (anti-flood, NUNCA para evadir
// deteccao) e e resumivel — se o app cair, jobs 'running' retomam no arranque.
// Cada acao exige um chip ADMIN conectado do grupo (regra do WhatsApp).

import { readFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min));

const MEMBER_OPS = new Set(['add_members', 'remove_members', 'promote', 'demote']);
// set_group = acao combinada (nome/descricao/imagem/config numa so passada).
// As ops individuais seguem aceitas (compat), mas a UI usa set_group.
const GROUP_OPS = new Set(['set_name', 'set_description', 'set_picture', 'set_settings', 'set_group']);

// Ritmo entre operacoes (min..max ms). Mais rapido = mais risco de banimento.
const PACE = {
  slow: [8000, 15000],
  normal: [4000, 8000],
  fast: [2000, 4000],
};

const TICK_MS = 5000; // frequencia do tick de agendamento

export function createBulk(db, wa) {
  let draining = false;
  let timer = null;

  // Tick periodico: promove jobs agendados vencidos e processa a fila. Tambem
  // retoma jobs que ficaram 'running' (app caiu no meio) — o drain reprocessa
  // apenas os itens ainda 'pending'.
  function start() {
    tick();
    timer = setInterval(tick, TICK_MS);
  }
  function stop() {
    if (timer) clearInterval(timer);
  }
  function tick() {
    const now = new Date().toISOString();
    const due = db
      .prepare("SELECT id FROM bulk_jobs WHERE status = 'scheduled' AND run_at IS NOT NULL AND run_at <= ? ORDER BY id")
      .all(now);
    for (const j of due) {
      db.prepare("UPDATE bulk_jobs SET status = 'running' WHERE id = ?").run(j.id);
      console.error(`[bulk] job ${j.id} agendado disparando`);
    }
    drain().catch((e) => console.error('[bulk] drain:', e?.message));
  }

  // --- API publica (chamada pelas rotas) ---

  function enqueue({ op, groups, contacts, params, run_at }) {
    if (!MEMBER_OPS.has(op) && !GROUP_OPS.has(op)) {
      return { error: 'operacao invalida' };
    }
    const grps = Array.isArray(groups)
      ? groups.filter((g) => g && typeof g.jid === 'string' && g.jid.endsWith('@g.us'))
      : [];
    if (grps.length === 0) return { error: 'selecione ao menos um grupo' };

    const p = { ...(params ?? {}) };
    p.pace = PACE[p.pace] ? p.pace : 'normal';

    let phones = [];
    if (MEMBER_OPS.has(op)) {
      phones = normalizeContacts(contacts);
      if (phones.length === 0) return { error: 'informe ao menos um contato' };
    } else if (op === 'set_name') {
      p.name = String(p.name ?? '').trim().slice(0, 100);
      if (!p.name) return { error: 'informe o novo nome do grupo' };
    } else if (op === 'set_description') {
      p.description = String(p.description ?? '').slice(0, 2000); // vazio = limpar descricao
    } else if (op === 'set_picture') {
      if (!p.media_path) return { error: 'envie a imagem' };
    } else if (op === 'set_settings') {
      p.settings = sanitizeSettings(p.settings);
      if (Object.keys(p.settings).length === 0) return { error: 'escolha ao menos uma configuracao' };
    } else if (op === 'set_group') {
      // Acao combinada: cada campo presente = uma alteracao a aplicar.
      // Campo ausente = nao mexe. Ao menos uma alteracao e obrigatoria.
      const changes = [];
      if (typeof p.name === 'string') {
        p.name = p.name.trim().slice(0, 100);
        if (!p.name) return { error: 'o novo nome nao pode ficar vazio' };
        changes.push('name');
      }
      if (typeof p.description === 'string') {
        p.description = p.description.slice(0, 2000); // vazio = limpar
        changes.push('description');
      }
      if (p.media_path) changes.push('picture');
      if (p.settings) {
        p.settings = sanitizeSettings(p.settings);
        if (Object.keys(p.settings).length) changes.push('settings');
        else delete p.settings;
      }
      if (changes.length === 0) {
        return { error: 'escolha ao menos uma alteracao (nome, descricao, imagem ou configuracoes)' };
      }
    }

    // Agendamento: run_at no futuro => job comeca 'scheduled'. Passado/ausente
    // (ou a menos de 5s) => executa agora.
    let runAt = null;
    let status = 'running';
    if (run_at) {
      const t = new Date(run_at);
      if (isNaN(t.getTime())) return { error: 'data/hora invalida' };
      // Margem curta: run_at praticamente "agora" (< 2s) executa imediato.
      if (t.getTime() > Date.now() + 2000) {
        runAt = t.toISOString();
        status = 'scheduled';
      }
    }

    const now = new Date().toISOString();
    // Um item por (grupo x contato) nas acoes de membro; por grupo nas de grupo.
    const items = [];
    for (const g of grps) {
      if (MEMBER_OPS.has(op)) {
        for (const phone of phones) items.push({ jid: g.jid, name: g.name ?? null, contact: phone });
      } else {
        items.push({ jid: g.jid, name: g.name ?? null, contact: null });
      }
    }

    db.exec('BEGIN;');
    let jobId;
    try {
      const r = db
        .prepare(
          'INSERT INTO bulk_jobs (op, status, params_json, total, run_at, created_at) VALUES (?,?,?,?,?,?)'
        )
        .run(op, status, JSON.stringify(p), items.length, runAt, now);
      jobId = r.lastInsertRowid;
      const ins = db.prepare(
        'INSERT INTO bulk_job_items (job_id, group_jid, group_name, contact, status, created_at) VALUES (?,?,?,?,?,?)'
      );
      for (const it of items) ins.run(jobId, it.jid, it.name, it.contact, 'pending', now);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      return { error: e?.message ?? 'erro ao criar' };
    }

    // Agendado: o tick dispara na hora. Imediato: processa agora.
    if (status === 'running') drain().catch((e) => console.error('[bulk] drain:', e?.message));
    return { id: jobId, scheduled: status === 'scheduled', run_at: runAt };
  }

  function list() {
    return db
      .prepare('SELECT * FROM bulk_jobs ORDER BY id DESC LIMIT 50')
      .all()
      .map((j) => ({ ...j, params: safeObj(j.params_json), params_json: undefined }));
  }

  function detail(id) {
    const job = db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(id);
    if (!job) return null;
    const items = db
      .prepare('SELECT group_jid, group_name, contact, status, detail, account_id FROM bulk_job_items WHERE job_id = ? ORDER BY id')
      .all(id);
    return { job: { ...job, params: safeObj(job.params_json), params_json: undefined }, items };
  }

  function cancel(id) {
    const job = db.prepare('SELECT status, total FROM bulk_jobs WHERE id = ?').get(id);
    if (!job) return { error: 'not_found' };
    if (job.status === 'scheduled') {
      // Nunca chegou a rodar: fecha o job e os itens de uma vez.
      const now = new Date().toISOString();
      db.prepare("UPDATE bulk_job_items SET status = 'skipped', detail = 'cancelado' WHERE job_id = ? AND status = 'pending'").run(id);
      db.prepare("UPDATE bulk_jobs SET status = 'canceled', finished_at = ?, skipped = total WHERE id = ?").run(now, id);
      return { ok: true };
    }
    if (job.status !== 'running') return { ok: true };
    // O worker detecta o cancelamento entre itens (drain checa antes de cada item).
    db.prepare("UPDATE bulk_jobs SET status = 'canceled' WHERE id = ?").run(id);
    return { ok: true };
  }

  // --- Worker ---

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const job = db
          .prepare("SELECT id FROM bulk_jobs WHERE status = 'running' ORDER BY id LIMIT 1")
          .get();
        if (!job) break;
        await processJob(job.id);
        // processJob sempre finaliza o job (done/canceled), entao o proximo loop
        // pega outro job 'running' — sem risco de laco infinito.
      }
    } finally {
      draining = false;
    }
  }

  const isCanceled = (id) =>
    db.prepare('SELECT status FROM bulk_jobs WHERE id = ?').get(id)?.status === 'canceled';

  async function processJob(jobId) {
    const job = db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(jobId);
    if (!job || job.status !== 'running') return;
    const params = safeObj(job.params_json);
    const [imin, imax] = PACE[params.pace] ?? PACE.normal;

    // Agrupa itens pendentes por grupo (1 fetch de metadata por grupo nas acoes
    // de membro que precisam mapear telefone -> id do participante).
    const pending = db
      .prepare("SELECT * FROM bulk_job_items WHERE job_id = ? AND status = 'pending' ORDER BY id")
      .all(jobId);
    const byGroup = new Map();
    for (const it of pending) {
      if (!byGroup.has(it.group_jid)) byGroup.set(it.group_jid, []);
      byGroup.get(it.group_jid).push(it);
    }

    let pictureBuf = null; // lido do disco uma vez (set_picture)

    let firstAction = true;
    for (const [jid, items] of byGroup) {
      if (isCanceled(jobId)) break;

      const acct = wa.adminAccountForGroup(jid);
      if (!acct) {
        for (const it of items) record(jobId, it.id, null, 'skipped', 'nenhum chip admin conectado neste grupo');
        continue;
      }

      if (MEMBER_OPS.has(job.op)) {
        // Para remover/promover/rebaixar: mapeia telefone -> id do participante
        // (resolvedor contorna o @lid do Baileys 7 via PN->LID).
        let byPhone = null;
        if (job.op !== 'add_members') {
          try {
            byPhone = await wa.accountResolveGroupMembers(acct, jid, items.map((it) => it.contact));
          } catch (e) {
            for (const it of items) record(jobId, it.id, acct, 'failed', `falha ao ler o grupo: ${e?.message ?? 'erro'}`);
            continue;
          }
        }
        for (const it of items) {
          if (isCanceled(jobId)) break;
          if (!firstAction) await sleep(jitter(imin, imax));
          firstAction = false;
          await runMemberItem(jobId, job.op, acct, jid, it, byPhone);
        }
      } else {
        // Acao de grupo: 1 item por grupo.
        const it = items[0];
        if (!firstAction) await sleep(jitter(imin, imax));
        firstAction = false;
        const needsPicture = job.op === 'set_picture' || (job.op === 'set_group' && params.media_path);
        if (needsPicture && pictureBuf === null) {
          try {
            pictureBuf = readFileSync(params.media_path);
          } catch (e) {
            pictureBuf = false; // marca falha permanente de leitura
            console.error('[bulk] imagem ausente:', e?.message);
          }
        }
        await runGroupItem(jobId, job.op, acct, jid, it, params, pictureBuf);
      }
    }

    finalizeJob(jobId);
  }

  async function runMemberItem(jobId, op, acct, jid, it, byPhone) {
    try {
      if (op === 'add_members') {
        const res = await wa.accountAddParticipants(acct, jid, [`${it.contact}@s.whatsapp.net`]);
        const r = interpretAddStatus(res?.[0]?.status);
        record(jobId, it.id, acct, r.status, r.detail);
        return;
      }
      // remove/promote/demote: precisa do id do participante dentro do grupo.
      const pid = byPhone?.[it.contact];
      if (!pid) {
        record(jobId, it.id, acct, 'skipped', 'não está no grupo');
        return;
      }
      if (op === 'remove_members') {
        await wa.accountRemoveParticipant(acct, jid, pid);
        record(jobId, it.id, acct, 'ok', 'removido');
      } else if (op === 'promote') {
        await wa.accountPromoteParticipants(acct, jid, [pid]);
        record(jobId, it.id, acct, 'ok', 'promovido a admin');
      } else if (op === 'demote') {
        await wa.accountDemoteParticipants(acct, jid, [pid]);
        record(jobId, it.id, acct, 'ok', 'rebaixado');
      }
    } catch (e) {
      record(jobId, it.id, acct, 'failed', e?.message ?? 'erro');
    }
  }

  async function runGroupItem(jobId, op, acct, jid, it, params, pictureBuf) {
    try {
      if (op === 'set_name') {
        await wa.accountSetSubject(acct, jid, params.name);
        renameLocalTarget(jid, params.name); // reflete no cache local (picker)
        record(jobId, it.id, acct, 'ok', 'nome alterado');
      } else if (op === 'set_description') {
        await wa.accountSetDescription(acct, jid, params.description);
        record(jobId, it.id, acct, 'ok', 'descrição alterada');
      } else if (op === 'set_picture') {
        if (!pictureBuf) {
          record(jobId, it.id, acct, 'failed', 'imagem indisponível');
          return;
        }
        await wa.accountSetGroupPicture(acct, jid, pictureBuf);
        record(jobId, it.id, acct, 'ok', 'imagem alterada');
      } else if (op === 'set_settings') {
        await applySettings(acct, jid, params.settings);
        record(jobId, it.id, acct, 'ok', 'configurações alteradas');
      } else if (op === 'set_group') {
        // Acao combinada: aplica cada alteracao presente, com pausa curta entre
        // elas (mesmo grupo). Resultado agrega o que deu certo e o que falhou.
        const done = [];
        const fail = [];
        const step = async (label, fn) => {
          try {
            await fn();
            done.push(label);
          } catch (e) {
            fail.push(`${label}: ${e?.message ?? 'erro'}`);
          }
          await sleep(jitter(900, 2000));
        };
        if (typeof params.name === 'string') {
          await step('nome', () => wa.accountSetSubject(acct, jid, params.name));
          if (done.includes('nome')) renameLocalTarget(jid, params.name);
        }
        if (typeof params.description === 'string') await step('descrição', () => wa.accountSetDescription(acct, jid, params.description));
        if (params.media_path) {
          if (!pictureBuf) fail.push('imagem: indisponível');
          else await step('imagem', () => wa.accountSetGroupPicture(acct, jid, pictureBuf));
        }
        if (params.settings && Object.keys(params.settings).length) {
          await step('configurações', () => applySettings(acct, jid, params.settings));
        }
        if (fail.length === 0) record(jobId, it.id, acct, 'ok', `${done.join(', ')} ✓`);
        else if (done.length === 0) record(jobId, it.id, acct, 'failed', fail.join('; '));
        else record(jobId, it.id, acct, 'failed', `✓ ${done.join(', ')} · ✗ ${fail.join('; ')}`);
      }
    } catch (e) {
      record(jobId, it.id, acct, 'failed', e?.message ?? 'erro');
    }
  }

  // Atualiza o nome no cache local (tabela targets) apos renomear o grupo, para
  // o picker refletir na hora — sem exigir "Sincronizar grupos" de novo.
  function renameLocalTarget(jid, name) {
    try {
      db.prepare('UPDATE targets SET name = ? WHERE jid = ?').run(name, jid);
    } catch (e) {
      console.error('[bulk] falha ao atualizar nome local:', e?.message);
    }
  }

  // Aplica cada configuracao escolhida (a que falhar propaga o erro do item).
  async function applySettings(acct, jid, s) {
    if (s.announce) await wa.accountSetGroupSetting(acct, jid, s.announce === 'admins' ? 'announcement' : 'not_announcement');
    if (s.edit) await wa.accountSetGroupSetting(acct, jid, s.edit === 'admins' ? 'locked' : 'unlocked');
    if (s.add) await wa.accountSetMemberAddMode(acct, jid, s.add === 'admins' ? 'admin_add' : 'all_member_add');
    if (s.approval) await wa.accountSetJoinApproval(acct, jid, s.approval === 'on' ? 'on' : 'off');
  }

  // Grava o resultado de um item e atualiza os contadores do job (atomico,
  // sem await no meio — o worker so cede o controle fora daqui).
  function record(jobId, itemId, acct, status, detail) {
    const col = status === 'ok' ? 'ok' : status === 'failed' ? 'failed' : 'skipped';
    db.exec('BEGIN;');
    try {
      db.prepare('UPDATE bulk_job_items SET status = ?, detail = ?, account_id = ? WHERE id = ?')
        .run(status, detail ?? null, acct ?? null, itemId);
      db.prepare(`UPDATE bulk_jobs SET done = done + 1, ${col} = ${col} + 1 WHERE id = ?`).run(jobId);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      console.error('[bulk] record falhou:', e?.message);
    }
  }

  function finalizeJob(jobId) {
    const canceled = isCanceled(jobId);
    // Itens ainda pendentes (cancelamento ou chip caiu) viram 'skipped'.
    const leftover = db
      .prepare("SELECT id FROM bulk_job_items WHERE job_id = ? AND status = 'pending'")
      .all(jobId);
    for (const it of leftover) {
      record(jobId, it.id, null, 'skipped', canceled ? 'cancelado' : 'não processado');
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE bulk_jobs SET status = ?, finished_at = ? WHERE id = ?")
      .run(canceled ? 'canceled' : 'done', now, jobId);
  }

  return { enqueue, list, detail, cancel, start, stop };
}

// --- Helpers ---

// Normaliza a lista de contatos: extrai digitos, remove vazios/duplicados.
// Aceita array de strings ou texto colado (uma por linha / separado por virgula).
function normalizeContacts(contacts) {
  let arr = [];
  if (Array.isArray(contacts)) arr = contacts;
  else if (typeof contacts === 'string') arr = contacts.split(/[\s,;]+/);
  const out = [];
  const seen = new Set();
  for (const c of arr) {
    const d = digits(c);
    if (d && d.length >= 8 && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function digits(x) {
  if (x == null) return null;
  const s = String(x).split('@')[0].split(':')[0];
  const d = s.replace(/\D/g, '');
  return d || null;
}

// Interpreta o status da Baileys ao adicionar participante.
function interpretAddStatus(status) {
  switch (String(status)) {
    case '200':
      return { status: 'ok', detail: 'adicionado' };
    case '403':
      return { status: 'ok', detail: 'convite enviado (privacidade do contato)' };
    case '409':
      return { status: 'skipped', detail: 'já está no grupo' };
    case '408':
      return { status: 'failed', detail: 'saiu recentemente — tente mais tarde' };
    case '401':
      return { status: 'failed', detail: 'bloqueado pelo contato' };
    case '400':
      return { status: 'failed', detail: 'número inválido' };
    default:
      return status
        ? { status: 'failed', detail: `erro ${status}` }
        : { status: 'failed', detail: 'número sem WhatsApp' };
  }
}

// Mantem so as chaves validas de configuracao com valores validos.
function sanitizeSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  if (s.announce === 'all' || s.announce === 'admins') out.announce = s.announce;
  if (s.edit === 'all' || s.edit === 'admins') out.edit = s.edit;
  if (s.add === 'all' || s.add === 'admins') out.add = s.add;
  if (s.approval === 'on' || s.approval === 'off') out.approval = s.approval;
  return out;
}

function safeObj(s) {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
}
