// Acoes em massa (bulk) — operacoes de alto risco aplicadas a varios grupos.
//
// Tres grupos de operacoes:
//   * membros: add_members | remove_members | promote | demote  (usa lista de contatos)
//   * grupo:   set_name | set_description | set_picture | set_settings  (so grupos)
//   * criar:   create_groups  (grupos novos em sequencia — nome com {x}, descricao,
//              imagem, admins e membros iniciais; o chip criador vem nos params)
//
// A fila vive no SQLite (fonte de verdade), como no scheduler: o worker processa
// os itens 'pending' com espacamento aleatorio (anti-flood, NUNCA para evadir
// deteccao) e e resumivel — se o app cair, jobs 'running' retomam no arranque.
// Cada acao exige um chip ADMIN conectado do grupo (regra do WhatsApp);
// create_groups exige apenas que o chip escolhido esteja conectado.

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

// Adicionar membro e a acao de maior risco de banimento (quem nao pediu pra
// entrar denuncia, e o WhatsApp derruba a sessao do chip). Limita o tamanho do
// disparo pra forcar lotes menores em vez de um unico job gigante.
const MAX_ADD_MEMBERS_ITEMS = 30;

// Criacao em serie tambem forca lotes menores (mesma logica anti-abuso acima:
// muitos grupos novos de uma vez com gente que nao pediu = denuncia = ban).
const MAX_CREATE_GROUPS = 30;

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
    if (!MEMBER_OPS.has(op) && !GROUP_OPS.has(op) && op !== 'create_groups') {
      return { error: 'operacao invalida' };
    }
    const grps = Array.isArray(groups)
      ? groups.filter((g) => g && typeof g.jid === 'string' && g.jid.endsWith('@g.us'))
      : [];
    if (op !== 'create_groups' && grps.length === 0) return { error: 'selecione ao menos um grupo' };

    const p = { ...(params ?? {}) };
    p.pace = PACE[p.pace] ? p.pace : 'normal';

    let phones = [];
    const createItems = []; // grupos a criar (so create_groups)
    if (MEMBER_OPS.has(op)) {
      phones = normalizeContacts(contacts);
      if (phones.length === 0) return { error: 'informe ao menos um contato' };
      if (op === 'add_members' && grps.length * phones.length > MAX_ADD_MEMBERS_ITEMS) {
        return {
          error:
            `adicionar é a ação de maior risco de banimento — no máximo ${MAX_ADD_MEMBERS_ITEMS} adições por disparo ` +
            `(grupos × contatos). Selecionado: ${grps.length} grupo(s) × ${phones.length} contato(s) = ` +
            `${grps.length * phones.length}. Divida em lotes menores.`,
        };
      }
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
    } else if (op === 'create_groups') {
      const err = prepareCreateGroups(p, createItems);
      if (err) return { error: err };
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
    // Um item por (grupo x contato) nas acoes de membro; por grupo nas de grupo;
    // no create_groups, um por grupo A CRIAR (jid placeholder ate a criacao).
    const items = op === 'create_groups' ? createItems : [];
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

    // Criacao de grupos: fluxo proprio — nao ha grupo existente nem chip admin
    // para resolver (o chip criador foi escolhido pelo usuario e vive nos params).
    if (job.op === 'create_groups') {
      await processCreateJob(jobId, params, pending, imin, imax);
      finalizeJob(jobId);
      return;
    }

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
        // currentAcct pode trocar em add_members: se o chip cair no meio do
        // grupo e existir OUTRO chip admin ainda conectado nesse grupo, o job
        // troca pra ele em vez de desistir do restante (multi-chip = menos
        // itens perdidos por causa de UM chip levar denuncia).
        let currentAcct = acct;
        for (let idx = 0; idx < items.length; idx++) {
          const it = items[idx];
          if (isCanceled(jobId)) break;
          if (!firstAction) await sleep(jitter(imin, imax));
          firstAction = false;
          await runMemberItem(jobId, job.op, currentAcct, jid, it, byPhone);
          if (job.op === 'add_members' && !wa.isAccountConnected(currentAcct)) {
            const next = wa.adminAccountForGroup(jid);
            if (next && next !== currentAcct) {
              console.error(`[bulk] chip ${currentAcct} caiu durante add_members no grupo ${jid} — trocando p/ chip ${next}`);
              currentAcct = next;
              continue;
            }
            // Sem outro chip admin conectado: nao adianta insistir nos contatos
            // restantes — encerra o grupo com um motivo claro em vez de repetir
            // "nao conectado" item a item.
            console.error(`[bulk] chip ${currentAcct} caiu durante add_members no grupo ${jid} — nenhum outro chip admin conectado, pausando o restante`);
            for (let j = idx + 1; j < items.length; j++) {
              record(
                jobId,
                items[j].id,
                currentAcct,
                'skipped',
                'chip desconectado pelo WhatsApp durante a adição (provável denúncia de quem foi adicionado) — reconecte antes de continuar'
              );
            }
            break;
          }
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
      const detail =
        op === 'add_members' && !wa.isAccountConnected(acct)
          ? 'chip desconectado pelo WhatsApp ao tentar adicionar (provável denúncia de quem foi adicionado sem pedir)'
          : e?.message ?? 'erro';
      record(jobId, it.id, acct, 'failed', detail);
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

  // Worker do create_groups: cria um grupo por item, no ritmo escolhido. Se o
  // chip criador cair no meio, o restante e pulado com motivo claro — sem
  // fallback: o usuario escolheu explicitamente qual chip cria.
  async function processCreateJob(jobId, params, pending, imin, imax) {
    const acct = Number(params.account_id);
    let pictureBuf = null; // lida do disco uma vez
    let firstAction = true;
    for (let idx = 0; idx < pending.length; idx++) {
      const it = pending[idx];
      if (isCanceled(jobId)) break;
      if (!wa.isAccountConnected(acct)) {
        for (let j = idx; j < pending.length; j++) {
          record(jobId, pending[j].id, acct, 'skipped', 'chip não conectado — conecte o chip e crie novamente');
        }
        break;
      }
      if (!firstAction) await sleep(jitter(imin, imax));
      firstAction = false;
      if (params.media_path && pictureBuf === null) {
        try {
          pictureBuf = readFileSync(params.media_path);
        } catch (e) {
          pictureBuf = false; // marca falha permanente de leitura
          console.error('[bulk] imagem ausente:', e?.message);
        }
      }
      await runCreateItem(jobId, acct, it, params, pictureBuf);
    }
  }

  // Cria UM grupo: groupCreate com os participantes iniciais (admins + membros),
  // depois descricao/imagem e promocao dos admins que de fato entraram. O jid
  // real substitui o placeholder do item e o grupo entra no cache local
  // (targets) para aparecer nos pickers sem exigir nova sincronizacao.
  async function runCreateItem(jobId, acct, it, params, pictureBuf) {
    const admins = params.admins ?? [];
    const phones = [...new Set([...admins, ...(params.members ?? [])])];
    let meta;
    try {
      meta = await wa.accountCreateGroup(acct, it.group_name, phones.map((d) => `${d}@s.whatsapp.net`));
    } catch (e) {
      record(jobId, it.id, acct, 'failed', `falha ao criar: ${e?.message ?? 'erro'}`);
      return;
    }
    const jid = meta?.id;
    if (!jid) {
      record(jobId, it.id, acct, 'failed', 'o WhatsApp não retornou o grupo criado');
      return;
    }
    db.prepare('UPDATE bulk_job_items SET group_jid = ? WHERE id = ?').run(jid, it.id);
    registerLocalTarget(acct, jid, it.group_name);

    // Quantos contatos de fato entraram (privacidade do contato pode barrar a
    // adicao direta na criacao — esses ficam de fora).
    const inGroup = Array.isArray(meta.participants) ? Math.max(0, meta.participants.length - 1) : null;
    const done = [phones.length && inGroup != null ? `criado (${inGroup}/${phones.length} contato(s) no grupo)` : 'criado'];
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

    if (params.description) await step('descrição', () => wa.accountSetDescription(acct, jid, params.description));
    if (params.media_path) {
      if (!pictureBuf) fail.push('imagem: indisponível');
      else await step('imagem', () => wa.accountSetGroupPicture(acct, jid, pictureBuf));
    }
    if (admins.length) {
      // Promove os admins que entraram (resolvedor contorna o @lid do Baileys 7).
      try {
        const byPhone = await wa.accountResolveGroupMembers(acct, jid, admins);
        const ids = admins.map((ph) => byPhone[ph]).filter(Boolean);
        if (ids.length) {
          await wa.accountPromoteParticipants(acct, jid, ids);
          done.push(`${ids.length} admin(s) promovido(s)`);
        }
        const missing = admins.length - ids.length;
        if (missing > 0) fail.push(`${missing} admin(s) não entraram no grupo (privacidade do contato) — promova manualmente`);
      } catch (e) {
        fail.push(`admins: ${e?.message ?? 'erro'}`);
      }
    }

    if (fail.length === 0) record(jobId, it.id, acct, 'ok', `${done.join(', ')} ✓`);
    else record(jobId, it.id, acct, 'failed', `✓ ${done.join(', ')} · ✗ ${fail.join('; ')}`);
  }

  // Grava o grupo recem-criado no cache local (tabela targets) — aparece nos
  // pickers imediatamente, sem exigir "Sincronizar grupos". O criador e admin.
  function registerLocalTarget(accountId, jid, name) {
    try {
      db.prepare(`
        INSERT INTO targets (account_id, jid, name, type, is_admin, announce, last_synced_at)
        VALUES (?, ?, ?, 'group', 1, 0, ?)
        ON CONFLICT(account_id, jid) DO UPDATE SET
          name = excluded.name, is_admin = 1, last_synced_at = excluded.last_synced_at
      `).run(accountId, jid, name, new Date().toISOString());
    } catch (e) {
      console.error('[bulk] falha ao registrar grupo criado:', e?.message);
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

// Valida/normaliza os params do create_groups e gera um item por grupo a criar.
// `{x}` no nome vira o numero sequencial a partir de `start` (definido pelo
// usuario): start=10 => 10, 11, 12… Muta `p` (os params normalizados sao os
// gravados no job) e enche `items`; retorna a mensagem de erro ou null.
function prepareCreateGroups(p, items) {
  const accountId = Number(p.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) return 'escolha o chip que vai criar os grupos';
  p.account_id = accountId;

  p.name = String(p.name ?? '').trim().slice(0, 100);
  if (!p.name) return 'informe o nome do grupo';

  const quantity = Number(p.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) return 'quantidade de grupos inválida';
  if (quantity > MAX_CREATE_GROUPS) {
    return `no máximo ${MAX_CREATE_GROUPS} grupos por disparo — divida em lotes menores`;
  }
  p.quantity = quantity;

  const hasSeq = /\{x\}/i.test(p.name);
  if (quantity > 1 && !hasSeq) {
    return 'para criar vários grupos, use {x} no nome — ele vira o número sequencial (ex: "Turma {x}")';
  }

  const start = Number(p.start ?? 1);
  if (!Number.isInteger(start) || start < 0) return 'primeiro número inválido';
  p.start = start;

  p.description = typeof p.description === 'string' ? p.description.slice(0, 2000) : '';
  p.admins = normalizeContacts(p.admins);
  // Admin ja entra como participante na criacao; nao duplica na lista de membros.
  p.members = normalizeContacts(p.members).filter((m) => !p.admins.includes(m));

  for (let i = 0; i < quantity; i++) {
    const name = (hasSeq ? p.name.replace(/\{x\}/gi, String(start + i)) : p.name).slice(0, 100);
    // jid placeholder (nao termina em @g.us) — trocado pelo jid real na criacao.
    items.push({ jid: `novo-${i + 1}`, name, contact: null });
  }
  return null;
}

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
