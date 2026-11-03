// Redirecionamento isiLink (metodo isiGroup do isiLink).
//
// Cada link do isiLink tem uma fila ordenada de grupos; o clique vai para o
// primeiro grupo ATIVO. O isiGroup mantem essa fila em dia pelo webhook do
// isiLink (`POST {grupo, ativo, semana?}`):
//
//  * o grupo chegou a `max_members`        -> "ativo": "não" (lotou)
//  * o grupo caiu para `reopen_at` ou menos -> "ativo": "sim" (reabre)
//  * entre os dois                          -> mantem o ultimo status (histerese:
//    sem ela o grupo abriria e fecharia a cada entrada/saida perto do limite)
//
// O grupo e identificado pela URL de CONVITE (o isiLink nao conhece jid), que
// so um chip admin consegue ler. Se o convite for redefinido no WhatsApp, a URL
// antiga recebe "não" e a nova entra no fim da fila do isiLink.
//
// So avisa quando o status MUDA (`last_status` = ultimo status aceito pelo
// isiLink). Envios de um mesmo link sao serializados: a ordem importa, porque
// grupo novo entra no FIM da fila do isiLink.
//
// "semana" (par | ímpar | ambas) vem da classificacao do grupo (group_info.week);
// grupo nao classificado omite o campo (o isiLink mantem o que tinha). Mudou so
// a semana: reenvia o mesmo "ativo" e o isiLink responde "updated".
//
// Criacao automatica (link com chip criador): quando TODOS os grupos de uma
// subcategoria (categoria + semana) do link passam de 60% do maximo, o chip
// cria o proximo grupo da numeracao dela (ver groupclone.mjs), que entra no
// fim da fila. So a subcategoria cheia cresce: impares lotando nao criam par.
//
// Recurso Pro: gate no motor (aqui) e nas rotas (/isilink/* no index.mjs).

import { saveMemberCount } from './whatsapp.mjs';
import { cloneGroup, groupNumber, nextGroupName } from './groupclone.mjs';

const MAX_ATTEMPTS = 3;
const DEBOUNCE_MS = 3000; // agrupa a rajada de entradas (e os N chips do grupo)
const RECONCILE_MS = 5 * 60_000; // conferencia periodica: contagem real + convite
export const MAX_GROUP_SIZE = 1024; // teto do WhatsApp
const GROW_AT = 0.6; // todos da subcategoria acima disto -> cria o proximo
const MAX_CREATES_PER_DAY = 5; // por link: trava contra configuracao errada
const CREATE_RETRY_MS = 10 * 60_000; // apos falha, espera antes de tentar de novo

export function createIsilink(db, wa, editionState, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const isPro = () => editionState?.edition === 'pro';

  // --- Fila de envio por link (serializa: a ordem define a fila do isiLink) ---
  const chains = new Map(); // link_id -> Promise
  function enqueue(linkId, fn) {
    const prev = chains.get(linkId) ?? Promise.resolve();
    const next = prev.then(fn).catch((e) => console.error(`[isilink] link ${linkId}:`, e?.message));
    chains.set(linkId, next);
    next.finally(() => { if (chains.get(linkId) === next) chains.delete(linkId); });
    return next;
  }

  // --- Leitura do WhatsApp ---------------------------------------------------

  // Tamanho atual do grupo, lido de qualquer chip membro conectado.
  async function refreshCount(jid) {
    const acc = wa.memberAccountForGroup(jid);
    if (!acc) return null;
    const md = await wa.accountGroupMetadata(acc, jid);
    const n = Array.isArray(md?.participants) ? md.participants.length : Number.isInteger(md?.size) ? md.size : null;
    if (n != null) saveMemberCount(db, jid, n);
    return n;
  }

  // Codigo de convite atual (exige chip admin conectado).
  async function refreshInvite(jid) {
    const acc = wa.adminAccountForGroup(jid);
    if (!acc) return null;
    const code = await wa.accountGroupInviteCode(acc, jid);
    if (code) {
      db.prepare(
        `INSERT INTO group_info (jid, invite_code, invite_at) VALUES (?,?,?)
         ON CONFLICT(jid) DO UPDATE SET invite_code = excluded.invite_code, invite_at = excluded.invite_at`
      ).run(jid, code, new Date().toISOString());
    }
    return code ?? null;
  }

  const info = (jid) => db.prepare('SELECT member_count, invite_code, week, category FROM group_info WHERE jid = ?').get(jid) ?? {};

  // --- Decisao ----------------------------------------------------------------

  // Status desejado para o grupo, ou null se ainda nao da para decidir.
  function desiredStatus(link, count, last) {
    if (count == null) return null;
    if (count >= link.max_members) return 'nao';
    if (count <= link.reopen_at) return 'sim';
    // Faixa de histerese: mantem o que ja foi enviado. Nunca enviado: aberto.
    return last ?? 'sim';
  }

  // Avalia um grupo de um link: avisa o isiLink se o status mudou e cria o
  // proximo grupo se a subcategoria dele encheu.
  async function evaluate(linkId, jid, opts = {}) {
    await evaluateStatus(linkId, jid, opts);
    await maybeGrow(linkId, jid);
  }

  // opts.refresh = le contagem e convite no WhatsApp antes (senao usa o banco).
  async function evaluateStatus(linkId, jid, opts = {}) {
    if (!isPro()) return;
    const link = db.prepare('SELECT * FROM isilink_links WHERE id = ?').get(linkId);
    if (!link || !link.enabled) return;
    const row = db.prepare('SELECT * FROM isilink_groups WHERE link_id = ? AND jid = ?').get(linkId, jid);
    if (!row) return;

    let { member_count: count, invite_code: code, week } = info(jid);
    if (opts.refresh || count == null) {
      try { count = (await refreshCount(jid)) ?? count; } catch (e) { console.error(`[isilink] contagem de ${jid}:`, e?.message); }
    }
    if (opts.refresh || !code) {
      try { code = (await refreshInvite(jid)) ?? code; } catch (e) { console.error(`[isilink] convite de ${jid}:`, e?.message); }
    }
    if (!code) {
      return setResult(row.id, 'erro', 'sem link de convite: nenhum chip admin conectado neste grupo');
    }
    const url = inviteUrl(code);

    // Convite redefinido no WhatsApp: a URL antiga sai da fila ("não") e a nova
    // entra no fim (o isiLink trata como grupo novo).
    let last = row.last_status;
    if (row.invite_url && row.invite_url !== url) {
      if (last) {
        const r = await send(link, jid, row.invite_url, 'nao', count);
        if (!r.ok) return setResult(row.id, r.result, `convite mudou; falha ao desativar a URL antiga: ${r.error}`);
      }
      db.prepare('UPDATE isilink_groups SET invite_url = ?, last_status = NULL, last_week = NULL WHERE id = ?').run(url, row.id);
      last = null;
      row.last_week = null;
      console.error(`[isilink] "${link.name}": convite de ${jid} mudou — URL nova entra no fim da fila`);
    }

    const want = desiredStatus(link, count, last);
    if (!want) return setResult(row.id, 'erro', 'tamanho do grupo desconhecido: nenhum chip conectado neste grupo');
    // Sem semana (nao classificado) nao ha o que reenviar: omitir nao apaga no isiLink.
    const weekSent = !week || week === row.last_week;
    if (want === last && weekSent && row.invite_url === url && row.last_result !== 'ignored') return; // nada mudou

    const r = await send(link, jid, url, want, count);
    const accepted = r.ok && r.result !== 'ignored';
    db.prepare(
      `UPDATE isilink_groups SET invite_url = ?, last_status = ?, last_week = ?, last_result = ?, last_error = ?, last_sent_at = ? WHERE id = ?`
    ).run(
      url,
      // `ignored` (limite do plano): o grupo NAO entrou na fila — continua
      // "nunca enviado", para a proxima conferencia tentar de novo.
      accepted ? want : last,
      accepted ? week ?? row.last_week : row.last_week,
      r.result,
      r.error ?? (r.result === 'ignored' ? 'fila do isiLink cheia (limite do plano)' : null),
      new Date().toISOString(),
      row.id
    );
  }

  // --- Criacao automatica ----------------------------------------------------
  const lastFail = new Map(); // `${link}|${categoria}|${semana}` -> ms da ultima falha

  async function maybeGrow(linkId, jid) {
    if (!isPro()) return;
    const link = db.prepare('SELECT * FROM isilink_links WHERE id = ?').get(linkId);
    if (!link?.enabled || !link.creator_account_id) return;
    const { week, category } = info(jid);
    if (!week) return; // sem subcategoria, nao ha numeracao para seguir

    const subs = db
      .prepare(
        `SELECT g.jid, i.member_count FROM isilink_groups g JOIN group_info i ON i.jid = g.jid
          WHERE g.link_id = ? AND i.week = ? AND i.category IS ?`
      )
      .all(linkId, week, category ?? null);
    const limit = Math.ceil(link.max_members * GROW_AT);
    // Contagem desconhecida nao decide; um grupo abaixo de 60% ainda tem vaga.
    if (subs.some((g) => g.member_count == null || g.member_count < limit)) return;

    const key = `${linkId}|${category ?? ''}|${week}`;
    if (Date.now() - (lastFail.get(key) ?? 0) < CREATE_RETRY_MS) return;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const today = db
      .prepare("SELECT COUNT(*) AS n FROM isilink_events WHERE link_id = ? AND result = 'created' AND created_at >= ?")
      .get(linkId, since.toISOString()).n;
    if (today >= MAX_CREATES_PER_DAY) return;

    const fail = (error, at = jid) => {
      lastFail.set(key, Date.now());
      logEvent(link.id, at, null, null, null, 'create_failed', error);
      console.error(`[isilink] "${link.name}": nao criou grupo (${category ?? 'sem categoria'}/${week}): ${error}`);
    };
    const named = subs.map((g) => ({ jid: g.jid, name: groupName(g.jid) })).filter((g) => g.name);
    const template = named.sort((a, b) => groupNumber(b.name) - groupNumber(a.name))[0];
    const name = template && nextGroupName(template.name, week);
    if (!name) return fail('o nome dos grupos da subcategoria nao tem numero para seguir a sequencia');
    if (!wa.isAccountConnected(link.creator_account_id)) return fail('chip criador nao conectado');

    let r;
    try {
      r = await cloneGroup(db, wa, {
        templateJid: template.jid, subJids: subs.map((g) => g.jid), name,
        accountId: link.creator_account_id, category, week,
      });
    } catch (e) {
      return fail(`falha ao criar "${name}": ${e?.message ?? 'erro'}`, template.jid);
    }
    lastFail.delete(key);
    const order = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM isilink_groups WHERE link_id = ?').get(linkId).n;
    db.prepare('INSERT INTO isilink_groups (link_id, jid, order_index) VALUES (?,?,?)').run(linkId, r.jid, order);
    const detail = `"${name}": ${r.done.join(', ')}${r.fail.length ? ` · ✗ ${r.fail.join('; ')}` : ''}`;
    logEvent(link.id, r.jid, null, null, r.count, 'created', detail);
    console.error(`[isilink] "${link.name}": criou ${detail}`);
    await evaluateStatus(linkId, r.jid, { refresh: true }); // entra no fim da fila do isiLink
  }

  function groupName(jid) {
    return db.prepare("SELECT name FROM targets WHERE jid = ? AND name <> '' ORDER BY account_id LIMIT 1").get(jid)?.name ?? null;
  }

  function setResult(rowId, result, error) {
    db.prepare('UPDATE isilink_groups SET last_result = ?, last_error = ? WHERE id = ?').run(result, error, rowId);
  }

  // Avalia todos os grupos de um link, NA ORDEM da fila.
  function reconcileLink(linkId, opts = {}) {
    return enqueue(linkId, async () => {
      const rows = db.prepare('SELECT jid FROM isilink_groups WHERE link_id = ? ORDER BY order_index').all(linkId);
      for (const r of rows) await evaluate(linkId, r.jid, opts);
    });
  }

  function reconcileAll(opts = {}) {
    if (!isPro()) return;
    for (const l of db.prepare('SELECT id FROM isilink_links WHERE enabled = 1').all()) reconcileLink(l.id, opts);
  }

  // --- Envio --------------------------------------------------------------------

  async function send(link, jid, url, ativo, count) {
    const r = await postIsilink(link.webhook_url, link.secret, url, ativo, info(jid).week);
    logEvent(link.id, jid, url, ativo, count, r.result, r.error, r.http);
    console.error(`[isilink] "${link.name}" ${ativo} ${url} (${count ?? '?'} membros): ${r.result}${r.error ? ` — ${r.error}` : ''}`);
    return r;
  }

  function logEvent(linkId, jid, url, ativo, count, result, error, http = null) {
    db.prepare(
      `INSERT INTO isilink_events (link_id, jid, invite_url, ativo, member_count, http_status, result, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(linkId, jid, url, ativo, count ?? null, http, result, error ?? null, new Date().toISOString());
    // Poda: guarda as ultimas 500 chamadas por link.
    db.prepare(
      `DELETE FROM isilink_events WHERE link_id = ? AND id NOT IN
         (SELECT id FROM isilink_events WHERE link_id = ? ORDER BY id DESC LIMIT 500)`
    ).run(linkId, linkId);
  }

  // --- Eventos de entrada/saida --------------------------------------------------
  // Cada chip membro recebe o mesmo evento; a rajada de entradas de um link
  // divulgado e grande. Junta tudo por grupo numa janela curta e le o tamanho
  // REAL no fim (em vez de somar +1/-1, que deriva com evento perdido).
  const pending = new Map(); // jid -> { timer, seen:Set, delta }
  function onMembership(eventType, ev) {
    if (!isPro() || !ev?.jid) return;
    const inLinks = db
      .prepare('SELECT 1 FROM isilink_groups g JOIN isilink_links l ON l.id = g.link_id WHERE g.jid = ? AND l.enabled = 1 LIMIT 1')
      .get(ev.jid);
    if (!inLinks) return;
    let p = pending.get(ev.jid);
    if (!p) {
      p = { seen: new Set(), delta: 0, timer: null };
      pending.set(ev.jid, p);
    }
    const key = `${eventType}:${ev.sender}`;
    if (!p.seen.has(key)) {
      p.seen.add(key);
      p.delta += eventType === 'join' ? 1 : eventType === 'leave' ? -1 : 0;
    }
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flush(ev.jid), debounceMs);
  }

  async function flush(jid) {
    const p = pending.get(jid);
    pending.delete(jid);
    if (!p) return;
    let ok = false;
    try { ok = (await refreshCount(jid)) != null; } catch (e) { console.error(`[isilink] contagem de ${jid}:`, e?.message); }
    if (!ok) {
      // Sem leitura do WhatsApp: aplica o saldo dos eventos (a conferencia
      // periodica corrige qualquer desvio).
      const cur = info(jid).member_count;
      if (cur != null) saveMemberCount(db, jid, Math.max(0, cur + p.delta));
    }
    const links = db
      .prepare('SELECT g.link_id FROM isilink_groups g JOIN isilink_links l ON l.id = g.link_id WHERE g.jid = ? AND l.enabled = 1')
      .all(jid);
    for (const l of links) enqueue(l.link_id, () => evaluate(l.link_id, jid));
  }

  // Classificacao do grupo mudou (tela Grupos): reenvia a semana nos links dele.
  function onClassified(jid) {
    if (!isPro()) return;
    const links = db
      .prepare('SELECT g.link_id FROM isilink_groups g JOIN isilink_links l ON l.id = g.link_id WHERE g.jid = ? AND l.enabled = 1')
      .all(jid);
    for (const l of links) enqueue(l.link_id, () => evaluate(l.link_id, jid));
  }

  // --- CRUD (rotas /isilink/*) ---------------------------------------------------

  function list() {
    const names = new Map(
      db.prepare("SELECT jid, name FROM targets WHERE name <> '' ORDER BY account_id").all().reverse().map((r) => [r.jid, r.name])
    );
    return db.prepare('SELECT * FROM isilink_links ORDER BY id DESC').all().map((l) => ({
      ...l,
      enabled: !!l.enabled,
      groups: db
        .prepare(
          `SELECT g.*, i.member_count, i.count_at, i.category, i.week FROM isilink_groups g
             LEFT JOIN group_info i ON i.jid = g.jid
            WHERE g.link_id = ? ORDER BY g.order_index`
        )
        .all(l.id)
        .map((g) => ({
          jid: g.jid,
          name: names.get(g.jid) ?? null,
          order_index: g.order_index,
          member_count: g.member_count ?? null,
          count_at: g.count_at ?? null,
          category: g.category ?? null,
          week: g.week ?? null,
          invite_url: g.invite_url,
          status: g.last_status,
          last_result: g.last_result,
          last_error: g.last_error,
          last_sent_at: g.last_sent_at,
        })),
    }));
  }

  function events(linkId) {
    return db
      .prepare('SELECT * FROM isilink_events WHERE link_id = ? ORDER BY id DESC LIMIT 50')
      .all(linkId);
  }

  // Valida o corpo de create/update. Retorna { error } ou os campos prontos.
  function validate(body) {
    const name = String(body?.name ?? '').trim();
    const url = String(body?.webhook_url ?? '').trim();
    const secret = String(body?.secret ?? '');
    const max = Number(body?.max_members);
    const reopen = Number(body?.reopen_at);
    const groups = Array.isArray(body?.groups) ? [...new Set(body.groups.map(String))] : [];
    if (!name) return { error: 'nome obrigatorio' };
    if (!/^https?:\/\/\S+$/i.test(url)) return { error: 'informe a URL do webhook do isiLink (http/https)' };
    if (!Number.isInteger(max) || max < 2 || max > MAX_GROUP_SIZE) {
      return { error: `maximo de membros deve ser um inteiro entre 2 e ${MAX_GROUP_SIZE}` };
    }
    if (!Number.isInteger(reopen) || reopen < 0 || reopen >= max) {
      return { error: '"reabre com" deve ser um inteiro menor que o maximo de membros' };
    }
    if (groups.length === 0) return { error: 'selecione ao menos um grupo' };
    const creator = body?.creator_account_id == null || body.creator_account_id === '' ? null : Number(body.creator_account_id);
    if (creator !== null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(creator)) {
      return { error: 'chip criador nao encontrado' };
    }
    const semAdmin = groups.filter(
      (jid) => !db.prepare('SELECT 1 FROM targets WHERE jid = ? AND is_admin = 1 LIMIT 1').get(jid)
    );
    if (semAdmin.length) {
      return { error: `${semAdmin.length} grupo(s) sem chip admin: o link de convite so pode ser lido por um admin` };
    }
    return { name, url, secret, max, reopen, groups, creator };
  }

  function create(body) {
    const v = validate(body);
    if (v.error) return v;
    db.exec('BEGIN;');
    let id;
    try {
      id = db
        .prepare(
          `INSERT INTO isilink_links (name, webhook_url, secret, max_members, reopen_at, creator_account_id, enabled, created_at)
           VALUES (?,?,?,?,?,?,1,?)`
        )
        .run(v.name, v.url, v.secret || null, v.max, v.reopen, v.creator, new Date().toISOString()).lastInsertRowid;
      const ins = db.prepare('INSERT INTO isilink_groups (link_id, jid, order_index) VALUES (?,?,?)');
      v.groups.forEach((jid, i) => ins.run(id, jid, i));
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
    // Primeiro envio: o status de TODOS os grupos, na ordem da fila — os que o
    // isiLink ainda nao tem entram no fim, na ordem certa.
    reconcileLink(id, { refresh: true });
    return { id: Number(id) };
  }

  function update(id, body) {
    const link = db.prepare('SELECT * FROM isilink_links WHERE id = ?').get(id);
    if (!link) return { error: 'not_found', status: 404 };
    const v = validate(body);
    if (v.error) return v;
    const current = db.prepare('SELECT * FROM isilink_groups WHERE link_id = ?').all(id);
    const keep = new Set(v.groups);
    const removed = current.filter((g) => !keep.has(g.jid));
    db.exec('BEGIN;');
    try {
      db.prepare('UPDATE isilink_links SET name=?, webhook_url=?, secret=?, max_members=?, reopen_at=?, creator_account_id=? WHERE id=?')
        .run(v.name, v.url, v.secret || null, v.max, v.reopen, v.creator, id);
      for (const g of removed) db.prepare('DELETE FROM isilink_groups WHERE id = ?').run(g.id);
      const upd = db.prepare('UPDATE isilink_groups SET order_index = ? WHERE link_id = ? AND jid = ?');
      const ins = db.prepare('INSERT INTO isilink_groups (link_id, jid, order_index) VALUES (?,?,?)');
      const known = new Set(current.map((g) => g.jid));
      v.groups.forEach((jid, i) => (known.has(jid) ? upd.run(i, id, jid) : ins.run(id, jid, i)));
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
    // Grupo retirado do link: so desativa no isiLink (nao ha rota de remover).
    // Usa a URL/segredo de ANTES da edicao — e la que o grupo esta.
    if (isPro()) {
      for (const g of removed) {
        if (g.invite_url && g.last_status) enqueue(id, () => send(link, g.jid, g.invite_url, 'nao', info(g.jid).member_count));
      }
    }
    reconcileLink(id, { refresh: true });
    return { ok: true };
  }

  function toggle(id) {
    const l = db.prepare('SELECT enabled FROM isilink_links WHERE id = ?').get(id);
    if (!l) return { error: 'not_found', status: 404 };
    const enabled = l.enabled ? 0 : 1;
    db.prepare('UPDATE isilink_links SET enabled = ? WHERE id = ?').run(enabled, id);
    // Reativado: o que mudou enquanto estava pausado vai agora.
    if (enabled) reconcileLink(id, { refresh: true });
    return { enabled: !!enabled };
  }

  // Apagar so para de acompanhar — nao mexe na fila do isiLink.
  function remove(id) {
    db.prepare('DELETE FROM isilink_links WHERE id = ?').run(id);
    return { ok: true };
  }

  async function resync(id) {
    const l = db.prepare('SELECT id FROM isilink_links WHERE id = ?').get(id);
    if (!l) return { error: 'not_found', status: 404 };
    await reconcileLink(id, { refresh: true });
    return { ok: true };
  }

  // --- Ciclo de vida --------------------------------------------------------------
  let timer = null;
  function start() {
    // 1a conferencia depois que os chips tiveram tempo de reconectar.
    setTimeout(() => reconcileAll({ refresh: true }), 30_000).unref?.();
    timer = setInterval(() => reconcileAll({ refresh: true }), RECONCILE_MS);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
  }

  return { start, stop, onMembership, onClassified, list, events, create, update, toggle, remove, resync, reconcileAll, _idle: () => Promise.all([...chains.values()]) };
}

export const GROUP_WEEKS = ['par', 'impar', 'ambas'];
const WEEK_WIRE = { par: 'par', impar: 'ímpar', ambas: 'ambas' };

export function inviteUrl(code) {
  return `https://chat.whatsapp.com/${code}`;
}

// Chamada ao webhook isiGroup do isiLink. Contrato:
//   200 { ok:true, action: activated|deactivated|added|unchanged|updated }
//       (updated = so a semana mudou; qualquer action com ok:true e sucesso)
//   200 { ok:false, action:'ignored', reason:'plan_limit' }
//   400 / 401 / 404 -> erro de configuracao: NAO re-tenta.
//   5xx / rede      -> re-tenta com backoff.
// Retorna { ok, http, result, error }.
// semana: 'par' | 'impar' | 'ambas' | null (null = omite o campo).
export async function postIsilink(webhookUrl, secret, grupo, ativo, semana = null) {
  const payload = { grupo, ativo: ativo === 'sim' ? 'sim' : 'não' };
  if (WEEK_WIRE[semana]) payload.semana = WEEK_WIRE[semana];
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['x-webhook-secret'] = secret;

  let last = { ok: false, http: null, result: 'erro', error: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      let data = null;
      try { data = await res.json(); } catch { /* corpo nao-JSON */ }
      if (res.ok) {
        if (data?.action === 'ignored') return { ok: true, http: res.status, result: 'ignored', error: null };
        const action = typeof data?.action === 'string' ? data.action : 'ok';
        return { ok: data?.ok !== false, http: res.status, result: action, error: data?.ok === false ? data?.reason ?? 'recusado' : null };
      }
      const msg = data?.message ?? data?.error ?? null;
      const why = { 400: 'pedido invalido', 401: 'secret errado ou ausente', 404: 'token nao existe ou o link deixou de ser isiGroup' }[res.status];
      last = { ok: false, http: res.status, result: 'erro', error: [`HTTP ${res.status}`, why, msg].filter(Boolean).join(' — ') };
      if (res.status < 500 && res.status !== 429) return last;
    } catch (e) {
      last = { ok: false, http: null, result: 'erro', error: e?.message ?? String(e) };
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return last;
}
