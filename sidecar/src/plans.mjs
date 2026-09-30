// Planos de acao (isiplan) — importacao declarativa gerada por IA.
//
// Um plano e um JSON versionado com uma lista ORDENADA de acoes (criar grupos,
// membros em massa, editar grupos, agendar, regras de automacao, selecoes).
// Contêiner: .isiplan/.zip (plan.json + media/) ou .json solto (midia so
// imagem pequena em base64). Fluxo: validate (staging + previa) -> apply
// (plan_runs/plan_steps) -> worker persistente executa em ordem.
//
// Pontos-chave:
//  * Seletores de grupo: {ref} (grupos criados por acao anterior), {names}
//    (nome exato, resolucao unica) e {match} (glob). O plano nunca traz jids.
//  * Acoes assincronas: create/members/edit viram jobs da fila BULK; o passo
//    fica 'waiting' ate o job terminar (dependencias via "ref").
//  * Tudo delega para os subsistemas existentes (bulk, /schedules,
//    /automation/rules via self-HTTP) — nenhum limite anti-flood e contornado.
//  * Guarda de reimportacao por hash: reaplicar exige confirmacao explicita.

import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve as pathResolve, relative as pathRelative, isAbsolute as pathIsAbsolute } from 'node:path';
import { unzipSync } from 'fflate';
import { saveUpload } from './media.mjs';

const PLAN_VERSION = 1;
const MAX_ACTIONS = 50;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const STAGING_TTL_MS = 30 * 60 * 1000;
const TICK_MS = 4000;

const ACTION_TYPES = new Set([
  'create_groups', 'add_members', 'remove_members', 'promote', 'demote',
  'edit_groups', 'schedule', 'automation_rule', 'save_selection',
  // Tipos usados pela EXPORTACAO da configuracao (ver exporter.mjs). Existem
  // para que o arquivo exportado seja um isiplan valido — exportar e importar
  // passam pela mesma validacao de sempre, sem um segundo formato.
  'ai_agent', 'ai_binding', 'bulk_recurring', 'account_settings',
]);
const MEMBER_OPS = new Set(['add_members', 'remove_members', 'promote', 'demote']);
const DOW = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

export function createPlans(db, wa, bulk, { mediaDir, appVersion, editionState }) {
  let self = null; // { port, token } — para self-HTTP (schedules/rules/selections)
  let timer = null;
  let draining = false;
  const staging = new Map(); // staged_id -> { plan, hash, planId, preview, warnings, mediaPaths, createdAt, applied }
  const syncedRuns = new Set(); // runs que ja sincronizaram os grupos nesta sessao

  function setSelf(info) {
    self = info;
  }

  function start() {
    timer = setInterval(() => drain().catch((e) => console.error('[plans] drain:', e?.message)), TICK_MS);
    drain().catch((e) => console.error('[plans] drain:', e?.message));
  }
  function stop() {
    if (timer) clearInterval(timer);
  }

  // ==========================================================================
  //  VALIDACAO + STAGING
  // ==========================================================================

  // Recebe o buffer bruto do upload (.isiplan/.zip/.json). Retorna
  // { staged_id, preview, warnings, already_applied? } ou { error }.
  async function validate(buffer, filename) {
    pruneStaging();
    let planText;
    let files = null; // Map<path, Buffer> (conteudo do zip)

    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      // Contêiner zip: plan.json na raiz (tolera uma pasta de topo) + media/.
      let entries;
      try {
        entries = unzipSync(new Uint8Array(buffer));
      } catch (e) {
        return { error: `não foi possível abrir o pacote: ${e?.message ?? 'zip inválido'}` };
      }
      files = new Map();
      let planEntry = null;
      for (const [rawPath, data] of Object.entries(entries)) {
        const p = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!p || p.endsWith('/')) continue;
        files.set(p, Buffer.from(data));
        const base = p.split('/');
        if (base[base.length - 1] === 'plan.json' && (planEntry == null || base.length < planEntry.depth)) {
          planEntry = { path: p, depth: base.length };
        }
      }
      if (!planEntry) return { error: 'o pacote não contém um plan.json' };
      // Normaliza os caminhos relativos ao diretorio do plan.json.
      const prefix = planEntry.path.slice(0, planEntry.path.length - 'plan.json'.length);
      if (prefix) {
        const rebased = new Map();
        for (const [p, buf] of files) {
          if (p.startsWith(prefix)) rebased.set(p.slice(prefix.length), buf);
        }
        files = rebased;
      }
      planText = files.get('plan.json').toString('utf8');
    } else {
      planText = buffer.toString('utf8');
    }

    if (Buffer.byteLength(planText) > MAX_JSON_BYTES) {
      return { error: 'plan.json acima de 10 MB' };
    }

    let raw;
    try {
      raw = JSON.parse(planText);
    } catch (e) {
      return { error: `JSON inválido: ${e?.message ?? 'erro de sintaxe'}` };
    }

    const hash = createHash('sha256').update(planText).digest('hex');
    const norm = await normalizePlan(raw, files);
    if (norm.error) {
      // Midia ja staged e descartada junto com a falha.
      for (const p of norm.mediaPaths ?? []) rmSync(p, { force: true });
      return { error: norm.error };
    }

    const preview = buildPreview(norm.plan);
    const warnings = [...norm.warnings, ...preview.warnings];

    const stagedId = randomBytes(8).toString('hex');
    staging.set(stagedId, {
      plan: norm.plan,
      hash,
      planId: norm.plan.plan_id ?? null,
      preview,
      warnings,
      mediaPaths: norm.mediaPaths,
      createdAt: Date.now(),
      applied: false,
      filename: filename ?? null,
    });

    const applied = findApplied(hash, norm.plan.plan_id);
    return {
      staged_id: stagedId,
      name: norm.plan.name,
      preview: { ...preview, warnings: undefined },
      warnings,
      already_applied: applied,
    };
  }

  // Reaplicar o mesmo plano exige confirmacao explicita (pausa/avisa/pergunta).
  function findApplied(hash, planId) {
    const byHash = db
      .prepare("SELECT id, name, status, created_at FROM plan_runs WHERE plan_hash = ? AND status <> 'canceled' ORDER BY id DESC LIMIT 1")
      .get(hash);
    if (byHash) return { run_id: byHash.id, name: byHash.name, status: byHash.status, at: byHash.created_at };
    if (planId) {
      const byId = db
        .prepare("SELECT id, name, status, created_at FROM plan_runs WHERE plan_id = ? AND status <> 'canceled' ORDER BY id DESC LIMIT 1")
        .get(String(planId));
      if (byId) return { run_id: byId.id, name: byId.name, status: byId.status, at: byId.created_at };
    }
    return null;
  }

  function pruneStaging() {
    const now = Date.now();
    for (const [id, s] of staging) {
      if (now - s.createdAt > STAGING_TTL_MS) {
        if (!s.applied) for (const p of s.mediaPaths) rmSync(p, { force: true });
        staging.delete(id);
      }
    }
  }

  // ==========================================================================
  //  APPLY — cria o run e dispara o worker
  // ==========================================================================

  function apply(stagedId, { confirmReapply = false, source = 'import' } = {}) {
    pruneStaging();
    const staged = staging.get(stagedId);
    if (!staged) return { error: 'staging expirado ou inexistente — valide o arquivo novamente' };

    const applied = findApplied(staged.hash, staged.planId);
    if (applied && !confirmReapply) {
      return { error: 'already_applied', already_applied: applied };
    }

    const now = new Date().toISOString();
    db.exec('BEGIN;');
    let runId;
    try {
      const r = db
        .prepare(
          `INSERT INTO plan_runs (plan_hash, plan_id, name, status, source, plan_json, total_steps, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(staged.hash, staged.planId, staged.plan.name, 'running', source,
          JSON.stringify(staged.plan), staged.plan.actions.length, now);
      runId = r.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO plan_steps (run_id, order_index, action_id, action_type, params_json, status)
         VALUES (?,?,?,?,?,?)`
      );
      staged.plan.actions.forEach((a, idx) =>
        ins.run(runId, idx, a.id ?? null, a.type, JSON.stringify({ ...a.params, on_error: a.on_error }), 'pending')
      );
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      return { error: e?.message ?? 'erro ao criar o run' };
    }

    staged.applied = true; // a midia agora pertence ao run (schedules/bulk referenciam)
    staging.delete(stagedId);
    logIntegration(source === 'mcp' ? 'mcp' : 'plan', 'apply_plan', `plano "${staged.plan.name}" aplicado (run ${runId})`, null, 'ok');
    drain().catch((e) => console.error('[plans] drain:', e?.message));
    return { run_id: runId };
  }

  function list() {
    return db
      .prepare('SELECT id, plan_id, name, status, source, total_steps, created_at, finished_at, report_json FROM plan_runs ORDER BY id DESC LIMIT 50')
      .all()
      .map((r) => ({ ...r, report: safeObj(r.report_json), report_json: undefined }));
  }

  function detail(id) {
    const run = db.prepare('SELECT * FROM plan_runs WHERE id = ?').get(id);
    if (!run) return null;
    const steps = db
      .prepare('SELECT order_index, action_id, action_type, params_json, status, detail, result_json FROM plan_steps WHERE run_id = ? ORDER BY order_index')
      .all(id)
      .map((s) => ({
        order_index: s.order_index,
        action_id: s.action_id,
        action_type: s.action_type,
        status: s.status,
        detail: s.detail,
        summary: summarizeAction({ type: s.action_type, params: safeObj(s.params_json) }),
        result: safeObj(s.result_json),
      }));
    return {
      run: { ...run, plan_json: undefined, report: safeObj(run.report_json), report_json: undefined },
      steps,
    };
  }

  function cancel(id) {
    const run = db.prepare('SELECT status FROM plan_runs WHERE id = ?').get(id);
    if (!run) return { error: 'not_found' };
    if (run.status !== 'running') return { ok: true };
    db.prepare("UPDATE plan_runs SET status = 'canceled' WHERE id = ?").run(id);
    // Cancela o job bulk do passo em espera, se houver.
    const waiting = db
      .prepare("SELECT waits_bulk_job_id FROM plan_steps WHERE run_id = ? AND status = 'waiting' AND waits_bulk_job_id IS NOT NULL")
      .all(id);
    for (const w of waiting) bulk.cancel(w.waits_bulk_job_id);
    const now = new Date().toISOString();
    db.prepare("UPDATE plan_steps SET status = 'skipped', detail = 'cancelado', finished_at = ? WHERE run_id = ? AND status IN ('pending','running','waiting')")
      .run(now, id);
    finalizeRun(id, 'canceled');
    return { ok: true };
  }

  // ==========================================================================
  //  WORKER
  // ==========================================================================

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const run = db.prepare("SELECT id FROM plan_runs WHERE status = 'running' ORDER BY id LIMIT 1").get();
        if (!run) break;
        const progressed = await processRun(run.id);
        // Sem progresso possivel agora (passo aguardando job bulk) -> espera o tick.
        if (!progressed) break;
      }
    } finally {
      draining = false;
    }
  }

  const runStatus = (id) => db.prepare('SELECT status FROM plan_runs WHERE id = ?').get(id)?.status;

  // Processa o run ate travar num passo 'waiting' ou terminar.
  // Retorna false quando ficou aguardando (o tick volta depois).
  async function processRun(runId) {
    for (;;) {
      if (runStatus(runId) !== 'running') return true;
      const step = db
        .prepare("SELECT * FROM plan_steps WHERE run_id = ? AND status IN ('pending','running','waiting') ORDER BY order_index LIMIT 1")
        .get(runId);
      if (!step) {
        finalizeRun(runId, 'done');
        return true;
      }

      if (step.status === 'waiting') {
        const settled = collectBulkResult(runId, step);
        if (!settled) return false; // job bulk ainda rodando
        continue;
      }

      db.prepare("UPDATE plan_steps SET status = 'running' WHERE id = ?").run(step.id);
      try {
        await executeStep(runId, step);
      } catch (e) {
        failStep(runId, step, e?.message ?? 'erro');
      }
    }
  }

  async function executeStep(runId, step) {
    const params = safeObj(step.params_json);

    if (step.action_type === 'create_groups') {
      const acct = resolveChip(params.chip);
      if (!acct.ok) return failStep(runId, step, acct.error);
      const r = bulk.enqueue({
        op: 'create_groups',
        params: {
          account_id: acct.id,
          name: params.name,
          quantity: params.quantity,
          start: params.start,
          description: params.description || undefined,
          media_path: params.image?.stored_path,
          admins: params.admins,
          members: params.members,
          pace: params.pace,
        },
      });
      if (r.error) return failStep(runId, step, r.error);
      db.prepare("UPDATE plan_steps SET status = 'waiting', waits_bulk_job_id = ? WHERE id = ?").run(r.id, step.id);
      return;
    }

    if (MEMBER_OPS.has(step.action_type) || step.action_type === 'edit_groups') {
      const sel = await resolveSelector(runId, params.groups);
      if (sel.groups.length === 0) {
        return failStep(runId, step, sel.notes.length ? sel.notes.join('; ') : 'nenhum grupo resolvido', true);
      }
      const op = step.action_type === 'edit_groups' ? 'set_group' : step.action_type;
      const p = { pace: params.pace };
      if (op === 'set_group') {
        if (typeof params.name === 'string') p.name = params.name;
        if (typeof params.description === 'string') p.description = params.description;
        if (params.image?.stored_path) p.media_path = params.image.stored_path;
        if (params.settings) p.settings = params.settings;
      }
      const r = bulk.enqueue({ op, groups: sel.groups, contacts: params.contacts, params: p });
      if (r.error) return failStep(runId, step, r.error);
      const note = sel.notes.length ? `${sel.notes.join('; ')} · ` : '';
      db.prepare("UPDATE plan_steps SET status = 'waiting', waits_bulk_job_id = ?, detail = ? WHERE id = ?")
        .run(r.id, note ? note.slice(0, -3) : null, step.id);
      return;
    }

    if (step.action_type === 'schedule') {
      const result = await executeSchedule(runId, step, params);
      if (result.error) return failStep(runId, step, result.error, !!result.soft);
      return doneStep(runId, step, result.detail, result.result);
    }

    if (step.action_type === 'automation_rule') {
      const sel = await resolveSelector(runId, params.scope);
      if (sel.groups.length === 0) {
        return failStep(runId, step, sel.notes.length ? sel.notes.join('; ') : 'nenhum grupo resolvido', true);
      }
      const pool = resolveChipPool(params.chips);
      if (pool.error) return failStep(runId, step, pool.error);
      const body = {
        name: params.name,
        trigger_type: params.trigger_type,
        match_type: params.match_type,
        pattern: params.pattern,
        case_sensitive: !!params.case_sensitive,
        scope: sel.groups.map((g) => g.jid),
        account_ids: pool.ids ?? undefined,
        actions: params.actions,
      };
      const res = await selfFetch('POST', '/automation/rules', body);
      return doneStep(runId, step, `regra criada (${sel.groups.length} grupo(s))`, { rule_id: res.id });
    }

    if (step.action_type === 'save_selection') {
      const sel = await resolveSelector(runId, params.groups);
      if (sel.groups.length === 0) {
        return failStep(runId, step, sel.notes.length ? sel.notes.join('; ') : 'nenhum grupo resolvido', true);
      }
      const res = await selfFetch('POST', '/selections', { name: params.name, jids: sel.groups.map((g) => g.jid) });
      return doneStep(runId, step, `seleção "${params.name}" salva (${sel.groups.length} grupo(s))`, { selection_id: res.id });
    }

    // --- Tipos da EXPORTACAO de configuracao ---
    // Todos executam via selfFetch nos endpoints do proprio app: a importacao
    // passa pela MESMA validacao que a tela usa, sem caminho paralelo.

    if (step.action_type === 'ai_agent') {
      const r = await selfFetch('POST', '/ai/agents', {
        name: params.name, description: params.description, system_prompt: params.system_prompt,
        model: params.model, keywords: params.keywords, min_similarity: params.min_similarity,
        use_in_triage: params.use_in_triage, enabled: params.enabled,
      });
      if (!r?.id) return failStep(runId, step, r?.message ?? 'falha ao criar o agente');

      // Conhecimento: indexado em segundo plano pelo proprio endpoint. Sem
      // chave da OpenAI o documento entra e fica com erro visivel na tela —
      // melhor que perder o texto na importacao.
      let ok = 0;
      const falhas = [];
      for (const k of params.knowledge ?? []) {
        try {
          const d = await selfFetch('POST', `/ai/agents/${r.id}/documents`, {
            source: 'text', title: k.title, content: k.content,
          });
          if (d?.id) ok++;
          else falhas.push(k.title || '(sem título)');
        } catch (e) {
          // selfFetch lanca em 4xx/5xx. O caso comum e nao haver chave da
          // OpenAI nesta maquina: o agente ja foi criado e o passo NAO pode
          // falhar por isso — falhar aqui descartaria o texto do conhecimento
          // sem o usuario perceber.
          falhas.push(`${k.title || '(sem título)'}: ${e?.message ?? 'erro'}`);
        }
      }
      const aviso = falhas.length ? ` — ${falhas.length} bloco(s) não entraram: ${falhas[0]}` : '';
      return doneStep(runId, step, `agente "${params.name}" criado com ${ok} bloco(s)${aviso}`, { agent_id: r.id });
    }

    if (step.action_type === 'ai_binding') {
      const sel = await resolveSelector(runId, params.groups);
      if (sel.groups.length === 0) {
        return failStep(runId, step, sel.notes.length ? sel.notes.join('; ') : 'nenhum grupo resolvido', true);
      }
      // agent_ref -> id real do agente criado antes neste mesmo plano.
      let agentId = null;
      if (params.agent_ref) {
        const row = db
          .prepare("SELECT result_json FROM plan_steps WHERE run_id = ? AND action_id = ? ORDER BY order_index LIMIT 1")
          .get(runId, String(params.agent_ref));
        agentId = safeObj(row?.result_json).agent_id ?? null;
        if (!agentId) return failStep(runId, step, `agente de "${params.agent_ref}" não foi criado`);
      }
      // Um vinculo por grupo (a tabela guarda um jid por linha).
      const criados = [];
      for (const g of sel.groups) {
        const r = await selfFetch('POST', '/ai/bindings', {
          target_jid: g.jid, mode: params.mode, agent_id: agentId ?? undefined,
          trigger_mode: params.trigger_mode, match_type: params.match_type, pattern: params.pattern,
          case_sensitive: params.case_sensitive, max_hops: params.max_hops, enabled: params.enabled,
        });
        if (r?.id) criados.push(g.name);
      }
      if (criados.length === 0) return failStep(runId, step, 'nenhum vínculo criado');
      return doneStep(runId, step, `IA ativada em ${criados.length} grupo(s)`, { groups: sel.groups });
    }

    if (step.action_type === 'bulk_recurring') {
      const sel = await resolveSelector(runId, params.groups);
      if (sel.groups.length === 0) {
        return failStep(runId, step, sel.notes.length ? sel.notes.join('; ') : 'nenhum grupo resolvido', true);
      }
      const edicao = { pace: params.pace };
      if (params.set_name != null) edicao.name = params.set_name;
      if (params.set_description != null) edicao.description = params.set_description;
      if (params.settings) edicao.settings = params.settings;
      if (params.image?.stored_path) edicao.media_path = params.image.stored_path;

      const r = await selfFetch('POST', '/bulk/recurring', {
        name: params.name, op: 'set_group',
        groups: sel.groups.map((g) => ({ jid: g.jid, name: g.name })),
        params: edicao,
        recur_dow: params.recur_dow, recur_time: params.recur_time,
        recur_week_parity: params.recur_week_parity,
      });
      if (!r?.id) return failStep(runId, step, r?.message ?? 'falha ao criar a edição recorrente');
      // Importado como pausado quando o plano dizia desativado.
      if (params.enabled === false) await selfFetch('POST', `/bulk/recurring/${r.id}/status`, { status: 'paused' });
      return doneStep(runId, step, `edição recorrente em ${sel.groups.length} grupo(s)`, { recurring_id: r.id });
    }

    if (step.action_type === 'account_settings') {
      // Casa pelo ROTULO: o id do chip na maquina de origem nao vale aqui.
      // Sem correspondencia, nao cria chip nenhum — conectar exige QR.
      const alvo = db.prepare('SELECT id FROM accounts WHERE label = ? LIMIT 1').get(params.label);
      if (!alvo) {
        return doneStep(runId, step, `nenhum chip chamado "${params.label}" nesta máquina — configuração ignorada`);
      }
      // So o proxy tem rota (POST /accounts/:id/proxy). O rotulo ja casou —
      // e por ele que encontramos o chip —, entao nada a renomear.
      await selfFetch('POST', `/accounts/${alvo.id}/proxy`, {
        proxy_url: params.proxy_url, proxy_enabled: params.proxy_enabled,
      });
      const comProxy = params.proxy_url ? ` com proxy ${params.proxy_enabled ? 'ativo' : 'desativado'}` : ' sem proxy';
      return doneStep(runId, step, `chip "${params.label}" configurado${comProxy}`);
    }

    return failStep(runId, step, `tipo de ação desconhecido: ${step.action_type}`);
  }

  // Agendamento: resolve alvos + roteia por chip (round-robin no pool) e
  // cria via self-HTTP no endpoint /schedules (mesma validacao da UI).
  async function executeSchedule(runId, step, params) {
    const sel = await resolveSelector(runId, params.targets);
    if (sel.groups.length === 0) {
      // Seletor vazio e falha "branda" (vira skipped), como nas demais acoes.
      return { error: sel.notes.length ? sel.notes.join('; ') : 'nenhum grupo resolvido', soft: true };
    }
    const pool = resolveChipPool(params.chips);
    if (pool.error) return { error: pool.error };
    if (pool.ids && pool.ids.length > 1 && editionState.edition !== 'pro') {
      return { error: 'agendamento multi-chip é recurso Pro' };
    }

    const connected = new Set(wa.connectedAccountIds());
    let rr = 0;
    const targets = [];
    let skipped = 0;
    for (const g of sel.groups) {
      const covering = db.prepare('SELECT account_id, id FROM targets WHERE jid = ? ORDER BY account_id').all(g.jid)
        .filter((r) => r.account_id != null);
      const inPool = pool.ids ? covering.filter((r) => pool.ids.includes(r.account_id)) : covering;
      const perMsg = params.content_mode === 'per_target' ? { message: perTargetMessage(params, g.name) } : {};
      if (inPool.length === 0) {
        if (covering[0]) targets.push({ target_id: covering[0].id, account_id: null, skipped: true, ...perMsg });
        skipped++;
        continue;
      }
      // Prefere chip conectado; round-robin dentro do pool coberto.
      const conn = inPool.filter((r) => connected.has(r.account_id));
      const pickFrom = conn.length ? conn : inPool;
      const row = pickFrom[rr % pickFrom.length];
      rr++;
      targets.push({ target_id: row.id, account_id: row.account_id, ...perMsg });
    }

    const body = {
      name: params.name,
      kind: params.kind,
      scheduled_at: params.kind === 'once' ? params.scheduled_at : undefined,
      recur_dow: params.kind === 'recurring' ? params.recur_dow : undefined,
      recur_time: params.kind === 'recurring' ? params.recur_time : undefined,
      recur_week_parity: params.kind === 'recurring' ? params.recur_week_parity : undefined,
      content_mode: params.content_mode === 'per_target' ? 'per_target' : 'broadcast',
      payload_type: 'text',
      default_text: params.content_mode === 'per_target' ? '' : undefined,
      steps: params.content_mode === 'per_target' ? undefined : params.steps,
      step_min_s: params.step_min_s,
      step_max_s: params.step_max_s,
      account_ids: pool.ids ?? undefined,
      targets,
    };
    const res = await selfFetch('POST', '/schedules', body);
    const parts = [`agendamento criado (${targets.length - skipped} grupo(s)`];
    const detail = parts[0] + (skipped ? `, ${skipped} sem cobertura)` : ')') + (sel.notes.length ? ` · ${sel.notes.join('; ')}` : '');
    return { result: { schedule_id: res.id }, detail };
  }

  function perTargetMessage(params, groupName) {
    const key = norm(groupName);
    for (const [k, v] of Object.entries(params.messages ?? {})) {
      if (norm(k) === key) return String(v);
    }
    return '';
  }

  // Passo 'waiting': verifica o job bulk. Retorna true quando o passo foi
  // finalizado (done/failed), false quando o job ainda esta rodando.
  function collectBulkResult(runId, step) {
    const d = bulk.detail(step.waits_bulk_job_id);
    if (!d) {
      failStep(runId, step, 'job bulk desapareceu');
      return true;
    }
    const st = d.job.status;
    if (st === 'running' || st === 'scheduled') return false;

    if (step.action_type === 'create_groups') {
      const okItems = d.items.filter((it) => it.status === 'ok' && it.group_jid?.endsWith('@g.us'));
      const groups = okItems.map((it) => ({ jid: it.group_jid, name: it.group_name }));
      const total = d.items.length;
      if (groups.length === 0) {
        const first = d.items.find((it) => it.detail);
        failStep(runId, step, `nenhum grupo criado (${first?.detail ?? 'ver execução em Ações em massa'})`, false, { groups: [] });
      } else {
        const detail = groups.length === total
          ? `${groups.length} grupo(s) criado(s)`
          : `${groups.length}/${total} grupo(s) criado(s) — o restante falhou (ver Ações em massa)`;
        doneStep(runId, step, detail, { groups, bulk_job_id: d.job.id });
      }
      return true;
    }

    // Acoes de membro / edicao: resume os contadores do job.
    const { ok, failed, skipped } = d.job;
    const summary = `${ok} ok · ${failed} falha(s) · ${skipped} pulado(s)`;
    if (ok === 0 && failed + skipped > 0) failStep(runId, step, summary, false, { bulk_job_id: d.job.id });
    else doneStep(runId, step, summary, { bulk_job_id: d.job.id });
    return true;
  }

  function doneStep(runId, step, detail, result) {
    const prev = db.prepare('SELECT detail FROM plan_steps WHERE id = ?').get(step.id)?.detail;
    const full = prev && detail ? `${prev} · ${detail}` : detail ?? prev ?? null;
    db.prepare("UPDATE plan_steps SET status = 'done', detail = ?, result_json = ?, finished_at = ? WHERE id = ?")
      .run(full, result ? JSON.stringify(result) : null, new Date().toISOString(), step.id);
  }

  // asSkip: falha "branda" (ex.: seletor vazio) vira 'skipped' em vez de 'failed'.
  function failStep(runId, step, detail, asSkip = false, result = null) {
    db.prepare("UPDATE plan_steps SET status = ?, detail = ?, result_json = ?, finished_at = ? WHERE id = ?")
      .run(asSkip ? 'skipped' : 'failed', detail ?? 'erro', result ? JSON.stringify(result) : null, new Date().toISOString(), step.id);
    const params = safeObj(step.params_json);
    if (!asSkip && params.on_error === 'abort') {
      const now = new Date().toISOString();
      db.prepare("UPDATE plan_steps SET status = 'skipped', detail = 'plano interrompido (on_error: abort)', finished_at = ? WHERE run_id = ? AND status IN ('pending','waiting','running') AND id <> ?")
        .run(now, runId, step.id);
      finalizeRun(runId, 'failed');
    }
  }

  function finalizeRun(runId, status) {
    const steps = db
      .prepare('SELECT order_index, action_type, status, detail FROM plan_steps WHERE run_id = ? ORDER BY order_index')
      .all(runId);
    const counts = { done: 0, failed: 0, skipped: 0 };
    for (const s of steps) if (counts[s.status] != null) counts[s.status]++;
    const report = { counts, steps };
    db.prepare("UPDATE plan_runs SET status = ?, report_json = ?, finished_at = ? WHERE id = ? AND status IN ('running','canceled')")
      .run(status, JSON.stringify(report), new Date().toISOString(), runId);
    syncedRuns.delete(runId);
    console.error(`[plans] run ${runId} finalizado: ${status} (${counts.done} ok, ${counts.failed} falhas, ${counts.skipped} pulados)`);
  }

  // ==========================================================================
  //  RESOLUCAO DE SELETORES / CHIPS
  // ==========================================================================

  // Resolve um seletor de grupos NA EXECUCAO. Retorna { groups: [{jid,name}], notes: [] }.
  async function resolveSelector(runId, selector) {
    const parts = Array.isArray(selector) ? selector : [selector];
    const out = new Map(); // jid -> {jid,name}
    const notes = [];

    // Nomes/padroes dependem do cache de grupos: sincroniza uma vez por run.
    const needsSync = parts.some((p) => p?.names || p?.match);
    if (needsSync && !syncedRuns.has(runId)) {
      syncedRuns.add(runId);
      try {
        await wa.syncAllTargets();
      } catch (e) {
        notes.push(`sincronização indisponível (${e?.message ?? 'sem chip conectado'}) — usando o cache local`);
      }
    }

    const all = needsSync ? allTargets() : [];

    for (const p of parts) {
      if (p?.ref) {
        const row = db
          .prepare("SELECT result_json, status FROM plan_steps WHERE run_id = ? AND action_id = ? ORDER BY order_index LIMIT 1")
          .get(runId, String(p.ref));
        const groups = safeObj(row?.result_json).groups ?? [];
        const picked = Array.isArray(p.indices) ? p.indices.map((i) => groups[i]).filter(Boolean) : groups;
        if (picked.length === 0) notes.push(`ref "${p.ref}" não produziu grupos`);
        for (const g of picked) out.set(g.jid, g);
      } else if (p?.names) {
        for (const nameRaw of p.names) {
          const matches = all.filter((t) => norm(t.name) === norm(nameRaw));
          const jids = [...new Set(matches.map((m) => m.jid))];
          if (jids.length === 0) notes.push(`grupo "${nameRaw}" não encontrado`);
          else if (jids.length > 1) notes.push(`grupo "${nameRaw}" é ambíguo (${jids.length} grupos com esse nome)`);
          else out.set(jids[0], { jid: jids[0], name: matches[0].name });
        }
      } else if (p?.match) {
        const re = globToRegex(String(p.match));
        const seen = new Set();
        for (const t of all) {
          if (re.test(t.name) && !seen.has(t.jid)) {
            seen.add(t.jid);
            out.set(t.jid, { jid: t.jid, name: t.name });
          }
        }
        if (seen.size === 0) notes.push(`nenhum grupo casa com "${p.match}"`);
      }
    }
    return { groups: [...out.values()], notes };
  }

  // Chip unico ('auto' = menor chip conectado) — usado por create_groups.
  function resolveChip(chip) {
    if (chip && chip !== 'auto' && chip.label) {
      const row = db.prepare('SELECT id FROM accounts WHERE LOWER(TRIM(label)) = ? ORDER BY id LIMIT 1').get(norm(chip.label));
      if (!row) return { ok: false, error: `chip "${chip.label}" não encontrado` };
      if (!wa.isAccountConnected(row.id)) return { ok: false, error: `chip "${chip.label}" não está conectado` };
      return { ok: true, id: row.id };
    }
    const ids = wa.connectedAccountIds().sort((a, b) => a - b);
    if (ids.length === 0) return { ok: false, error: 'nenhum chip conectado' };
    return { ok: true, id: ids[0] };
  }

  // Pool de chips por rotulo (agendamento/regras). null = automatico.
  function resolveChipPool(chips) {
    if (!Array.isArray(chips) || chips.length === 0) return { ids: null };
    const ids = [];
    for (const label of chips) {
      const row = db.prepare('SELECT id FROM accounts WHERE LOWER(TRIM(label)) = ? ORDER BY id LIMIT 1').get(norm(label));
      if (!row) return { error: `chip "${label}" não encontrado` };
      ids.push(row.id);
    }
    return { ids: [...new Set(ids)] };
  }

  // Grupos conhecidos, deduplicados por jid (linha sincronizada mais recente).
  function allTargets() {
    const rows = db
      .prepare("SELECT jid, name, last_synced_at FROM targets WHERE name IS NOT NULL ORDER BY last_synced_at DESC")
      .all();
    const byJid = new Map();
    for (const r of rows) if (!byJid.has(r.jid)) byJid.set(r.jid, r);
    return [...byJid.values()];
  }

  // ==========================================================================
  //  NORMALIZACAO / VALIDACAO DO PLANO
  // ==========================================================================

  async function normalizePlan(raw, files) {
    const warnings = [];
    const mediaPaths = [];
    const fail = (msg) => ({ error: msg, mediaPaths });

    if (raw?.isigroup_plan !== PLAN_VERSION) {
      return fail(`versão do plano não suportada (esperado "isigroup_plan": ${PLAN_VERSION}) — atualize o isigroup ou o plano`);
    }
    if (raw.requires?.app) {
      const min = String(raw.requires.app).replace(/^[>=\s]+/, '');
      if (compareVersions(appVersion, min) < 0) {
        return fail(`este plano exige o isigroup ${raw.requires.app} (instalado: ${appVersion}) — atualize o app`);
      }
    }
    if (raw.requires?.edition === 'pro' && editionState.edition !== 'pro') {
      return fail('este plano exige o plano Pro do isigroup');
    }
    if (!Array.isArray(raw.actions) || raw.actions.length === 0) return fail('o plano não tem ações');
    if (raw.actions.length > MAX_ACTIONS) return fail(`no máximo ${MAX_ACTIONS} ações por plano`);

    const defaults = {
      pace: ['slow', 'normal', 'fast'].includes(raw.defaults?.pace) ? raw.defaults.pace : 'normal',
      chip: raw.defaults?.chip ?? 'auto',
      on_error: raw.defaults?.on_error === 'abort' ? 'abort' : 'continue',
    };

    // Carrega uma referencia de midia para o pipeline de upload (transcodifica
    // audio p/ PTT etc.). kinds = tipos aceitos nesta posicao.
    async function stageMedia(ref, kinds, where) {
      if (!ref || typeof ref !== 'object') throw new Error(`${where}: referência de mídia inválida`);
      if (ref.stored_path) {
        // Midia ja enviada pelo proprio app (fluxo MCP: upload_media). So aceita
        // caminho DENTRO do diretorio de midia — nunca um arquivo arbitrario.
        // path.relative evita o falso-positivo de prefixo (ex.: "media-evil").
        const p = pathResolve(String(ref.stored_path));
        const rel = pathRelative(pathResolve(mediaDir), p);
        if (!rel || rel.startsWith('..') || pathIsAbsolute(rel)) {
          throw new Error(`${where}: caminho de mídia fora da área do app`);
        }
        return { stored_path: p, mimetype: ref.mimetype ?? 'application/octet-stream', kind: ref.kind ?? kinds[0], duration_seconds: ref.duration_seconds ?? null, waveform_json: ref.waveform_json ?? null };
      }
      let buf;
      let mime;
      let name;
      if (ref.file) {
        if (!files) throw new Error(`${where}: mídia por arquivo exige o pacote .isiplan/.zip`);
        const path = String(ref.file).replace(/\\/g, '/').replace(/^\.?\//, '');
        buf = files.get(path);
        if (!buf) throw new Error(`${where}: arquivo "${ref.file}" não está no pacote`);
        name = path.split('/').pop();
        mime = MIME_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()];
        if (!mime) throw new Error(`${where}: extensão de mídia não suportada em "${name}"`);
      } else if (ref.base64) {
        mime = String(ref.mime ?? '');
        if (!mime.startsWith('image/')) throw new Error(`${where}: base64 inline só é aceito para imagens — use o pacote .isiplan para áudio/vídeo`);
        buf = Buffer.from(String(ref.base64), 'base64');
        if (buf.length > MAX_INLINE_IMAGE_BYTES) throw new Error(`${where}: imagem inline acima de 2 MB — use o pacote .isiplan`);
        name = ref.name ?? 'imagem.png';
      } else {
        throw new Error(`${where}: mídia precisa de "file" (pacote) ou "base64" (imagem)`);
      }
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'video';
      if (!kinds.includes(kind)) throw new Error(`${where}: esperado ${kinds.join('/')} — recebido ${kind}`);
      const media = await saveUpload(mediaDir, buf, mime, name);
      mediaPaths.push(media.stored_path);
      return media;
    }

    const ids = new Set();
    // Ids referenciaveis: grupos criados (create_groups, via {"ref"}) e agentes
    // criados (ai_agent, via agent_ref). Os dois resolvem pelo result_json do
    // passo, entao compartilham o mesmo conjunto.
    const createIds = new Set();
    const actions = [];

    for (let i = 0; i < raw.actions.length; i++) {
      const a = raw.actions[i];
      const where = `ação ${i + 1}`;
      if (!a || !ACTION_TYPES.has(a.type)) {
        return fail(`${where}: tipo inválido "${a?.type}" — tipos aceitos: ${[...ACTION_TYPES].join(', ')}`);
      }
      const id = a.id != null ? String(a.id) : null;
      if (id) {
        if (ids.has(id)) return fail(`${where}: id "${id}" duplicado`);
        ids.add(id);
      }
      const p = a.params ?? {};
      const on_error = a.on_error === 'abort' ? 'abort' : a.on_error === 'continue' ? 'continue' : defaults.on_error;
      const pace = ['slow', 'normal', 'fast'].includes(p.pace) ? p.pace : defaults.pace;

      // Valida o seletor de grupos (estrutura + refs para acoes anteriores).
      const checkSelector = (sel, label) => {
        const parts = Array.isArray(sel) ? sel : [sel];
        if (parts.length === 0) return `${where}: ${label} vazio`;
        for (const s of parts) {
          if (!s || typeof s !== 'object') return `${where}: ${label} inválido`;
          const keys = ['ref', 'names', 'match'].filter((k) => s[k] != null);
          if (keys.length !== 1) return `${where}: ${label} deve ter exatamente um de ref/names/match`;
          if (s.ref != null && !createIds.has(String(s.ref))) {
            return `${where}: ${label} referencia "${s.ref}", que não é o id de uma ação create_groups anterior`;
          }
          if (s.names != null && (!Array.isArray(s.names) || s.names.length === 0 || !s.names.every((n) => typeof n === 'string' && n.trim()))) {
            return `${where}: ${label}.names deve ser uma lista de nomes de grupo`;
          }
          if (s.match != null && (typeof s.match !== 'string' || !s.match.trim())) {
            return `${where}: ${label}.match deve ser um padrão de texto (ex: "Turma *")`;
          }
        }
        return null;
      };

      try {
        if (a.type === 'create_groups') {
          const name = String(p.name ?? '').trim().slice(0, 100);
          if (!name) return fail(`${where}: informe o nome do grupo`);
          const quantity = Number(p.quantity ?? 1);
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 30) return fail(`${where}: quantity deve ser 1–30`);
          if (quantity > 1 && !/\{x\}/i.test(name)) return fail(`${where}: para criar vários grupos use {x} no nome`);
          const start = Number(p.start ?? 1);
          if (!Number.isInteger(start) || start < 0) return fail(`${where}: start inválido`);
          const chip = p.chip ?? defaults.chip;
          if (chip !== 'auto' && (typeof chip !== 'object' || !chip.label)) return fail(`${where}: chip deve ser "auto" ou {"label": "…"}`);
          const params = {
            name, quantity, start, pace, chip,
            description: typeof p.description === 'string' ? p.description.slice(0, 2000) : '',
            admins: normalizePhones(p.admins),
            members: normalizePhones(p.members),
          };
          if (p.image) params.image = await stageMedia(p.image, ['image'], where);
          if (id) createIds.add(id);
          actions.push({ id, type: a.type, on_error, params });
        } else if (MEMBER_OPS.has(a.type)) {
          const selErr = checkSelector(p.groups, 'groups');
          if (selErr) return fail(selErr);
          const contacts = normalizePhones(p.contacts);
          if (contacts.length === 0) return fail(`${where}: informe ao menos um contato válido (DDI+DDD+número)`);
          actions.push({ id, type: a.type, on_error, params: { groups: p.groups, contacts, pace } });
        } else if (a.type === 'edit_groups') {
          const selErr = checkSelector(p.groups, 'groups');
          if (selErr) return fail(selErr);
          const params = { groups: p.groups, pace };
          if (typeof p.name === 'string') {
            params.name = p.name.trim().slice(0, 100);
            if (!params.name) return fail(`${where}: o novo nome não pode ser vazio`);
          }
          if (typeof p.description === 'string') params.description = p.description.slice(0, 2000);
          if (p.image) params.image = await stageMedia(p.image, ['image'], where);
          if (p.settings) {
            const s = {};
            if (['all', 'admins'].includes(p.settings.announce)) s.announce = p.settings.announce;
            if (['all', 'admins'].includes(p.settings.edit)) s.edit = p.settings.edit;
            if (['all', 'admins'].includes(p.settings.add)) s.add = p.settings.add;
            if (['on', 'off'].includes(p.settings.approval)) s.approval = p.settings.approval;
            if (Object.keys(s).length) params.settings = s;
          }
          if (params.name == null && params.description == null && !params.image && !params.settings) {
            return fail(`${where}: edit_groups precisa de ao menos uma alteração (name, description, image ou settings)`);
          }
          actions.push({ id, type: a.type, on_error, params });
        } else if (a.type === 'schedule') {
          const selErr = checkSelector(p.targets, 'targets');
          if (selErr) return fail(selErr);
          const kind = p.kind === 'recurring' ? 'recurring' : 'once';
          const params = { targets: p.targets, kind, name: typeof p.name === 'string' ? p.name.slice(0, 120) : undefined };
          if (kind === 'once') {
            const t = new Date(p.scheduled_at ?? '');
            if (isNaN(t.getTime())) return fail(`${where}: scheduled_at inválido — use ISO 8601 com fuso (ex: 2026-10-01T09:00:00-03:00)`);
            if (t.getTime() < Date.now()) warnings.push(`${where}: scheduled_at está no passado — o envio dispara imediatamente ao aplicar`);
            params.scheduled_at = t.toISOString();
          } else {
            if (!Number.isInteger(p.recur_dow) || p.recur_dow < 0 || p.recur_dow > 6) return fail(`${where}: recur_dow deve ser 0 (domingo) a 6 (sábado)`);
            if (typeof p.recur_time !== 'string' || !/^\d{2}:\d{2}$/.test(p.recur_time)) return fail(`${where}: recur_time deve ser HH:MM`);
            if (p.recur_week_parity != null && !['odd', 'even'].includes(p.recur_week_parity)) {
              return fail(`${where}: recur_week_parity deve ser "odd" (semanas ímpares), "even" (pares) ou ausente (todas)`);
            }
            params.recur_dow = p.recur_dow;
            params.recur_time = p.recur_time;
            params.recur_week_parity = p.recur_week_parity ?? undefined;
          }
          if (p.content_mode === 'per_target') {
            if (!p.messages || typeof p.messages !== 'object' || Object.keys(p.messages).length === 0) {
              return fail(`${where}: content_mode per_target exige "messages" ({"nome do grupo": "texto"})`);
            }
            params.content_mode = 'per_target';
            params.messages = p.messages;
          } else {
            if (!Array.isArray(p.steps) || p.steps.length === 0) return fail(`${where}: informe steps (ao menos uma mensagem)`);
            params.steps = [];
            for (const [si, rs] of p.steps.entries()) {
              params.steps.push(await normalizeContentStep(rs, `${where}, passo ${si + 1}`, stageMedia));
            }
            if (params.steps.length > 1) {
              params.step_min_s = Number.isInteger(p.step_min_s) && p.step_min_s >= 0 ? p.step_min_s : 5;
              params.step_max_s = Number.isInteger(p.step_max_s) && p.step_max_s >= params.step_min_s ? p.step_max_s : params.step_min_s;
            }
          }
          if (p.chips != null) {
            if (!Array.isArray(p.chips) || !p.chips.every((c) => typeof c === 'string' && c.trim())) {
              return fail(`${where}: chips deve ser uma lista de rótulos de chip`);
            }
            params.chips = p.chips;
            if (p.chips.length > 1 && editionState.edition !== 'pro') {
              warnings.push(`${where}: multi-chip é recurso Pro — o passo vai falhar na edição atual`);
            }
          }
          actions.push({ id, type: a.type, on_error, params });
        } else if (a.type === 'automation_rule') {
          const name = String(p.name ?? '').trim();
          if (!name) return fail(`${where}: informe o nome da regra`);
          const trigger = ['message', 'message_link', 'join', 'leave'].includes(p.trigger_type) ? p.trigger_type : null;
          if (!trigger) return fail(`${where}: trigger_type deve ser message, message_link, join ou leave`);
          const selErr = checkSelector(p.scope, 'scope');
          if (selErr) return fail(selErr);
          const params = { name, trigger_type: trigger, scope: p.scope, case_sensitive: !!p.case_sensitive };
          if (trigger === 'message') {
            if (!['starts_with', 'contains', 'ends_with', 'exact'].includes(p.match_type) || !String(p.pattern ?? '').trim()) {
              return fail(`${where}: gatilho message exige match_type (starts_with/contains/ends_with/exact) e pattern`);
            }
            params.match_type = p.match_type;
            params.pattern = String(p.pattern);
          }
          if (!Array.isArray(p.actions) || p.actions.length === 0) return fail(`${where}: informe as ações da regra`);
          params.actions = [];
          for (const [ai, ra] of p.actions.entries()) {
            const aw = `${where}, ação da regra ${ai + 1}`;
            const type = ['group_message', 'dm', 'remove', 'webhook', 'delete_message'].includes(ra?.type) ? ra.type : null;
            if (!type) return fail(`${aw}: tipo inválido (group_message/dm/remove/webhook/delete_message)`);
            const na = { type };
            if (type === 'group_message' || type === 'dm') {
              if (!Array.isArray(ra.steps) || ra.steps.length === 0) return fail(`${aw}: informe steps`);
              na.steps = [];
              for (const [si, rs] of ra.steps.entries()) na.steps.push(await normalizeContentStep(rs, `${aw}, passo ${si + 1}`, stageMedia));
              if (na.steps.length > 1) {
                na.step_min_s = Number.isInteger(ra.step_min_s) && ra.step_min_s >= 0 ? ra.step_min_s : 5;
                na.step_max_s = Number.isInteger(ra.step_max_s) && ra.step_max_s >= na.step_min_s ? ra.step_max_s : na.step_min_s;
              }
            } else if (type === 'webhook') {
              if (!/^https?:\/\//i.test(String(ra.url ?? ''))) return fail(`${aw}: webhook exige url http(s)`);
              na.url = String(ra.url);
              na.secret = String(ra.secret ?? '');
            } else if (type === 'delete_message' && trigger !== 'message' && trigger !== 'message_link') {
              return fail(`${aw}: delete_message só vale para gatilhos de mensagem`);
            }
            if (Number.isInteger(ra?.delay_min_s) && ra.delay_min_s >= 0) {
              na.delay_min_s = ra.delay_min_s;
              na.delay_max_s = Number.isInteger(ra.delay_max_s) && ra.delay_max_s >= ra.delay_min_s ? ra.delay_max_s : ra.delay_min_s;
            }
            params.actions.push(na);
          }
          if (p.chips != null) {
            if (!Array.isArray(p.chips) || !p.chips.every((c) => typeof c === 'string' && c.trim())) {
              return fail(`${where}: chips deve ser uma lista de rótulos de chip`);
            }
            params.chips = p.chips;
          }
          actions.push({ id, type: a.type, on_error, params });
        } else if (a.type === 'save_selection') {
          const name = String(p.name ?? '').trim().slice(0, 80);
          if (!name) return fail(`${where}: informe o nome da seleção`);
          const selErr = checkSelector(p.groups, 'groups');
          if (selErr) return fail(selErr);
          actions.push({ id, type: a.type, on_error, params: { name, groups: p.groups } });
        } else if (a.type === 'ai_agent') {
          const name = String(p.name ?? '').trim();
          if (!name) return fail(`${where}: informe o nome do agente`);
          if (id) createIds.add(id);
          const conhecimento = Array.isArray(p.knowledge) ? p.knowledge : [];
          for (const [ki, k] of conhecimento.entries()) {
            if (!String(k?.content ?? '').trim()) return fail(`${where}, conhecimento ${ki + 1}: conteúdo vazio`);
          }
          actions.push({
            id, type: a.type, on_error,
            params: {
              name,
              description: String(p.description ?? ''),
              system_prompt: String(p.system_prompt ?? ''),
              model: p.model || undefined,
              keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
              min_similarity: Number.isFinite(Number(p.min_similarity)) ? Number(p.min_similarity) : undefined,
              use_in_triage: !!p.use_in_triage,
              enabled: p.enabled !== false,
              knowledge: conhecimento.map((k) => ({
                title: String(k.title ?? ''),
                content: String(k.content),
              })),
            },
          });
        } else if (a.type === 'ai_binding') {
          const selErr = checkSelector(p.groups, 'groups');
          if (selErr) return fail(selErr);
          const mode = p.mode === 'triage' ? 'triage' : 'agent';
          if (mode === 'agent' && !p.agent_ref) {
            return fail(`${where}: modo "agent" exige agent_ref apontando para uma ação ai_agent do plano`);
          }
          if (p.agent_ref && !createIds.has(String(p.agent_ref))) {
            return fail(`${where}: agent_ref "${p.agent_ref}" não é o id de uma ação ai_agent anterior`);
          }
          const trigger = ['mention', 'match', 'always'].includes(p.trigger_mode) ? p.trigger_mode : 'mention';
          if (trigger === 'match' && !String(p.pattern ?? '').trim()) {
            return fail(`${where}: gatilho "match" exige pattern`);
          }
          actions.push({
            id, type: a.type, on_error,
            params: {
              groups: p.groups, mode, agent_ref: p.agent_ref ?? null, trigger_mode: trigger,
              match_type: trigger === 'match' ? (p.match_type ?? 'contains') : undefined,
              pattern: trigger === 'match' ? String(p.pattern) : undefined,
              case_sensitive: !!p.case_sensitive,
              max_hops: Number.isInteger(p.max_hops) ? p.max_hops : 2,
              enabled: p.enabled !== false,
            },
          });
        } else if (a.type === 'bulk_recurring') {
          const selErr = checkSelector(p.groups, 'groups');
          if (selErr) return fail(selErr);
          if (!Number.isInteger(p.recur_dow) || p.recur_dow < 0 || p.recur_dow > 6) {
            return fail(`${where}: recur_dow deve ser 0 (domingo) a 6 (sábado)`);
          }
          if (typeof p.recur_time !== 'string' || !/^\d{2}:\d{2}$/.test(p.recur_time)) {
            return fail(`${where}: recur_time deve ser HH:MM`);
          }
          if (p.recur_week_parity != null && !['odd', 'even'].includes(p.recur_week_parity)) {
            return fail(`${where}: recur_week_parity deve ser "odd", "even" ou ausente`);
          }
          const mudou = ['set_name', 'set_description', 'settings', 'image'].some((k) => p[k] != null);
          if (!mudou) return fail(`${where}: informe ao menos uma alteração (set_name, set_description, settings ou image)`);
          const params = {
            groups: p.groups, name: p.name ?? undefined,
            recur_dow: p.recur_dow, recur_time: p.recur_time,
            recur_week_parity: p.recur_week_parity ?? undefined,
            pace: p.pace ?? 'normal', enabled: p.enabled !== false,
          };
          if (typeof p.set_name === 'string') params.set_name = p.set_name;
          if (typeof p.set_description === 'string') params.set_description = p.set_description;
          if (p.settings) params.settings = p.settings;
          if (p.image) params.image = await stageMedia(p.image, ['image'], `${where}, imagem`);
          actions.push({ id, type: a.type, on_error, params });
        } else if (a.type === 'account_settings') {
          const label = String(p.label ?? '').trim();
          if (!label) return fail(`${where}: informe o rótulo do chip`);
          actions.push({
            id, type: a.type, on_error,
            params: { label, proxy_url: p.proxy_url ?? null, proxy_enabled: !!p.proxy_enabled },
          });
        }
      } catch (e) {
        return fail(e?.message ?? `${where}: erro de validação`);
      }
    }

    return {
      plan: {
        version: PLAN_VERSION,
        plan_id: raw.plan_id != null ? String(raw.plan_id) : null,
        name: String(raw.name ?? 'Plano sem nome').slice(0, 120),
        defaults,
        actions,
      },
      warnings,
      mediaPaths,
    };
  }

  // Passo de conteudo (schedule / group_message / dm): text|image|audio|video|poll.
  async function normalizeContentStep(rs, where, stageMedia) {
    const type = ['text', 'image', 'audio', 'video', 'poll'].includes(rs?.type) ? rs.type : null;
    if (!type) throw new Error(`${where}: tipo de passo inválido (text/image/audio/video/poll)`);
    if (type === 'text') {
      const text = String(rs.text ?? '').trim();
      if (!text) throw new Error(`${where}: texto vazio`);
      return { type, text };
    }
    if (type === 'poll') {
      const values = Array.isArray(rs.poll?.values) ? rs.poll.values.map((v) => String(v).trim()).filter(Boolean) : [];
      if (!String(rs.poll?.name ?? '').trim() || values.length < 2) {
        throw new Error(`${where}: enquete precisa de pergunta e 2+ opções`);
      }
      const selectableCount = Number.isInteger(rs.poll.selectableCount) && rs.poll.selectableCount >= 1
        ? Math.min(rs.poll.selectableCount, values.length) : 1;
      return { type, poll: { name: String(rs.poll.name).trim(), values, selectableCount } };
    }
    const media = await stageMedia(rs.media, [type], where);
    const step = { type, media };
    if (type !== 'audio' && typeof rs.text === 'string') step.text = rs.text;
    return step;
  }

  // ==========================================================================
  //  PREVIA
  // ==========================================================================

  function buildPreview(plan) {
    const warnings = [];
    const totals = { create_groups: 0, member_adds: 0, member_removes: 0, promotes: 0, demotes: 0, edits: 0, schedules: 0, rules: 0, selections: 0 };
    const webhooks = [];
    const known = allTargets();

    const items = plan.actions.map((a, idx) => {
      const p = a.params;
      const resolution = describeSelectorResolution(a, known);
      if (resolution?.problems?.length) warnings.push(...resolution.problems.map((m) => `ação ${idx + 1}: ${m}`));

      if (a.type === 'create_groups') {
        totals.create_groups += p.quantity;
        totals.member_adds += p.quantity * (p.admins.length + p.members.length);
      } else if (a.type === 'add_members') {
        totals.member_adds += p.contacts.length * (resolution?.count ?? 1);
      } else if (a.type === 'remove_members') totals.member_removes += p.contacts.length * (resolution?.count ?? 1);
      else if (a.type === 'promote') totals.promotes += p.contacts.length;
      else if (a.type === 'demote') totals.demotes += p.contacts.length;
      else if (a.type === 'edit_groups') totals.edits += resolution?.count ?? 1;
      else if (a.type === 'schedule') totals.schedules += 1;
      else if (a.type === 'automation_rule') {
        totals.rules += 1;
        for (const ra of p.actions) if (ra.type === 'webhook') webhooks.push(ra.url);
      } else if (a.type === 'save_selection') totals.selections += 1;
      else if (a.type === 'ai_agent') totals.agents = (totals.agents ?? 0) + 1;
      else if (a.type === 'ai_binding') totals.bindings = (totals.bindings ?? 0) + 1;
      else if (a.type === 'bulk_recurring') totals.bulk_recurring = (totals.bulk_recurring ?? 0) + 1;
      else if (a.type === 'account_settings') totals.chips = (totals.chips ?? 0) + 1;

      return {
        order_index: idx,
        id: a.id,
        type: a.type,
        summary: summarizeAction(a),
        resolution: resolution ? { count: resolution.count, notes: resolution.notes } : null,
      };
    });

    if (totals.member_adds > 0) {
      warnings.push(`o plano adiciona ~${totals.member_adds} pessoa(s) a grupos — adição é a ação com maior risco de banimento (quem não pediu costuma denunciar)`);
    }
    for (const url of webhooks) warnings.push(`o plano cria webhook para: ${url}`);
    if (wa.connectedAccountIds().length === 0) {
      warnings.push('nenhum chip conectado agora — os passos vão falhar/pular até um chip conectar');
    }

    return { items, totals, webhooks, warnings };
  }

  // Previa da resolucao de names/match contra o cache atual (best-effort — a
  // resolucao definitiva acontece na execucao, apos sync).
  function describeSelectorResolution(a, known) {
    const sel = a.params.groups ?? a.params.targets ?? a.params.scope;
    if (!sel) return null;
    const parts = Array.isArray(sel) ? sel : [sel];
    let count = 0;
    const notes = [];
    const problems = [];
    for (const p of parts) {
      if (p.ref) {
        notes.push(`grupos da ação "${p.ref}" (resolvido na execução)`);
        count += Array.isArray(p.indices) ? p.indices.length : 0;
      } else if (p.names) {
        for (const n of p.names) {
          const matches = [...new Set(known.filter((t) => norm(t.name) === norm(n)).map((t) => t.jid))];
          if (matches.length === 1) count += 1;
          else if (matches.length === 0) problems.push(`grupo "${n}" não encontrado nos grupos sincronizados`);
          else problems.push(`grupo "${n}" é ambíguo (${matches.length} grupos com esse nome)`);
        }
      } else if (p.match) {
        const re = globToRegex(p.match);
        const m = new Set(known.filter((t) => re.test(t.name)).map((t) => t.jid));
        count += m.size;
        notes.push(`"${p.match}" casa com ${m.size} grupo(s) hoje`);
      }
    }
    return { count, notes, problems };
  }

  function summarizeAction(a) {
    const p = a.params;
    const selDesc = (sel) => {
      const parts = Array.isArray(sel) ? sel : [sel];
      return parts
        .map((s) =>
          s.ref ? `grupos de "${s.ref}"` : s.names ? s.names.map((n) => `"${n}"`).join(', ') : `padrão "${s.match}"`
        )
        .join(' + ');
    };
    switch (a.type) {
      case 'create_groups': {
        const range = p.quantity > 1 ? ` (números ${p.start}–${p.start + p.quantity - 1})` : '';
        const extras = [
          p.description && 'descrição',
          p.image && 'imagem',
          p.admins.length && `${p.admins.length} admin(s)`,
          p.members.length && `${p.members.length} membro(s)`,
        ].filter(Boolean).join(', ');
        return `Criar ${p.quantity} grupo(s) "${p.name}"${range}${extras ? ` — ${extras}` : ''}`;
      }
      case 'add_members': return `Adicionar ${p.contacts.length} contato(s) em ${selDesc(p.groups)}`;
      case 'remove_members': return `Remover ${p.contacts.length} contato(s) de ${selDesc(p.groups)}`;
      case 'promote': return `Promover ${p.contacts.length} contato(s) a admin em ${selDesc(p.groups)}`;
      case 'demote': return `Rebaixar ${p.contacts.length} admin(s) em ${selDesc(p.groups)}`;
      case 'edit_groups': {
        const ch = [p.name != null && 'nome', p.description != null && 'descrição', p.image && 'imagem', p.settings && 'configurações'].filter(Boolean).join(', ');
        return `Editar ${selDesc(p.groups)} — ${ch}`;
      }
      case 'schedule': {
        const semana = p.recur_week_parity === 'odd' ? ' de semanas ímpares'
          : p.recur_week_parity === 'even' ? ' de semanas pares' : '';
        const when = p.kind === 'recurring'
          ? `${semana ? `${DOW[p.recur_dow]}${semana}` : `toda ${DOW[p.recur_dow]}`} às ${p.recur_time}`
          : `em ${new Date(p.scheduled_at).toLocaleString('pt-BR')}`;
        const content = p.content_mode === 'per_target'
          ? 'mensagem por grupo'
          : `${p.steps.length} passo(s): ${p.steps.map((s) => s.type).join(' → ')}`;
        return `Agendar ${when} → ${selDesc(p.targets)} (${content})${p.chips ? ` · chips: ${p.chips.join(', ')}` : ''}`;
      }
      case 'automation_rule': {
        const trg = { message: `mensagem ${p.match_type} "${p.pattern}"`, message_link: 'mensagem com link', join: 'entrou no grupo', leave: 'saiu do grupo' }[p.trigger_type];
        return `Regra "${p.name}" — quando ${trg} em ${selDesc(p.scope)} → ${p.actions.map((x) => x.type).join(', ')}`;
      }
      case 'save_selection': return `Salvar seleção "${p.name}" com ${selDesc(p.groups)}`;
      case 'ai_agent': {
        const k = Array.isArray(p.knowledge) ? p.knowledge.length : 0;
        return `Criar agente de IA "${p.name}"${p.use_in_triage ? ' (disponível para triagem)' : ''}` +
               ` — ${k} bloco(s) de conhecimento`;
      }
      case 'ai_binding': {
        const quem = p.mode === 'triage' ? 'Triagem' : `Agente de "${p.agent_ref}"`;
        const gatilho = p.trigger_mode === 'always' ? 'toda mensagem'
          : p.trigger_mode === 'match' ? `quando contiver "${p.pattern}"`
          : 'quando mencionarem o chip';
        return `${quem} responde em ${selDesc(p.groups)} — ${gatilho}`;
      }
      case 'bulk_recurring': {
        const semana = p.recur_week_parity === 'odd' ? ' de semanas ímpares'
          : p.recur_week_parity === 'even' ? ' de semanas pares' : '';
        const muda = [p.set_name != null && 'nome', p.set_description != null && 'descrição',
                      p.image && 'imagem', p.settings && 'configurações'].filter(Boolean).join(', ');
        return `Editar ${selDesc(p.groups)} toda ${DOW[p.recur_dow]}${semana} às ${p.recur_time} — ${muda}`;
      }
      case 'account_settings':
        return `Configurar chip "${p.label}"${p.proxy_enabled ? ' (com proxy)' : ''}`;
      default: return a.type;
    }
  }

  // ==========================================================================
  //  Self-HTTP + util
  // ==========================================================================

  async function selfFetch(method, path, body) {
    if (!self) throw new Error('endpoint interno ainda não disponível');
    const res = await fetch(`http://127.0.0.1:${self.port}${path}`, {
      method,
      headers: { 'x-isi-token': self.token, 'content-type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    return data;
  }

  function logIntegration(source, tool, summary, approvalId, result) {
    try {
      db.prepare('INSERT INTO integration_log (source, tool, summary, approval_id, result, created_at) VALUES (?,?,?,?,?,?)')
        .run(source, tool, summary ?? null, approvalId ?? null, result ?? null, new Date().toISOString());
    } catch (e) {
      console.error('[plans] log:', e?.message);
    }
  }

  return { setSelf, start, stop, validate, apply, list, detail, cancel, schemaDoc, logIntegration };
}

// ============================================================================
//  Helpers de modulo
// ============================================================================

const norm = (s) => String(s ?? '').trim().toLowerCase();

function normalizePhones(list) {
  let arr = [];
  if (Array.isArray(list)) arr = list;
  else if (typeof list === 'string') arr = list.split(/[\s,;]+/);
  const out = [];
  const seen = new Set();
  for (const c of arr) {
    const d = String(c ?? '').split('@')[0].replace(/\D/g, '');
    if (d && d.length >= 8 && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function globToRegex(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

function safeObj(s) {
  try {
    const v = JSON.parse(s ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// ============================================================================
//  Documentacao do formato (GET /plans/schema) — fonte unica para o botao
//  "Copiar instruções para a IA" e para a tool MCP get_plan_schema.
// ============================================================================

export function schemaDoc() {
  return {
    format: 'isiplan',
    version: PLAN_VERSION,
    container: {
      canonical: '.isiplan ou .zip contendo plan.json na raiz + pasta media/ com os arquivos referenciados',
      alternative: '.json solto (sem mídia, ou apenas imagens pequenas inline em base64, ≤ 2 MB)',
      limits: { max_actions: MAX_ACTIONS, max_json_mb: 10, max_package_mb: 200 },
    },
    root_fields: {
      isigroup_plan: 'obrigatório, sempre 1',
      name: 'nome do plano (exibido na importação)',
      plan_id: 'opcional — identidade para a guarda de reimportação',
      requires: 'opcional — {"app": ">=0.1.15", "edition": "pro"}',
      defaults: 'opcional — {"pace": "slow|normal|fast", "chip": "auto", "on_error": "continue|abort"}',
      actions: 'lista ORDENADA de ações (máx. 50)',
    },
    selectors: {
      description: 'Grupos NUNCA são endereçados por jid — o plano é escrito fora da máquina do app. Use um destes (ou uma lista deles):',
      ref: '{"ref": "id-de-acao-create_groups-anterior"} — opcional "indices": [0,1] para um subconjunto',
      names: '{"names": ["Nome Exato Do Grupo"]} — cada nome deve resolver para exatamente 1 grupo já sincronizado',
      match: '{"match": "Turma *"} — padrão glob (* e ?) sobre os nomes; zero resultados = passo pulado com aviso',
    },
    chips: 'Chips (contas WhatsApp) são endereçados por rótulo: "chip": "auto" (padrão) ou {"label": "Chip vendas"}. Agendamentos aceitam "chips": ["A","B"] (pool multi-chip, recurso Pro).',
    media: 'Referências de mídia: {"file": "media/arquivo.ext"} (dentro do pacote) ou {"base64": "...", "mime": "image/png", "name": "x.png"} (só imagem). Áudio é transcodificado para nota de voz (PTT) automaticamente.',
    actions: {
      create_groups: {
        params: { name: 'com {x} = número sequencial', quantity: '1–30', start: 'primeiro número', description: 'opcional', image: 'mídia opcional', admins: '["55DDDNÚMERO"] promovidos após criar', members: '["55DDDNÚMERO"]', chip: '"auto" | {"label": "..."}', pace: 'slow|normal|fast' },
        example: { id: 'turmas', type: 'create_groups', params: { name: 'Turma {x}', quantity: 3, start: 10, description: 'Avisos da turma', admins: ['5511999998888'], members: ['5521988887777'] } },
      },
      add_members: { params: { groups: 'seletor', contacts: '["55..."]', pace: 'opcional' }, note: 'máx. 30 adições (grupos × contatos) por ação — regra anti-banimento do app' },
      remove_members: { params: { groups: 'seletor', contacts: '["55..."]' } },
      promote: { params: { groups: 'seletor', contacts: '["55..."]' } },
      demote: { params: { groups: 'seletor', contacts: '["55..."]' } },
      edit_groups: { params: { groups: 'seletor', name: 'opcional', description: 'opcional (vazio = limpar)', image: 'mídia opcional', settings: '{"announce": "all|admins", "edit": "all|admins", "add": "all|admins", "approval": "on|off"}' } },
      schedule: {
        params: {
          targets: 'seletor', kind: 'once|recurring',
          scheduled_at: 'once: ISO 8601 com fuso (ex: 2026-10-01T09:00:00-03:00)',
          recur_dow: 'recurring: 0 (domingo) a 6 (sábado)', recur_time: 'recurring: "HH:MM" (hora local do app)',
          recur_week_parity: 'recurring, opcional: "odd" (só semanas ímpares) | "even" (só pares). Ausente = todas as semanas. Semana = ISO-8601, igual ao Google Agenda',
          steps: '[{type: "text", text}, {type: "image|video", media, text?}, {type: "audio", media}, {type: "poll", poll: {name, values, selectableCount}}]',
          step_min_s: 'intervalo entre passos (s)', step_max_s: 'intervalo máx (s)',
          chips: 'opcional, pool de rótulos (Pro)',
          content_mode: 'opcional "per_target" + messages: {"nome do grupo": "texto"}',
        },
      },
      automation_rule: {
        params: {
          name: 'obrigatório', trigger_type: 'message|message_link|join|leave',
          match_type: 'message: starts_with|contains|ends_with|exact', pattern: 'message: texto',
          scope: 'seletor', case_sensitive: 'bool',
          actions: '[{type: "group_message"|"dm", steps: [...]}, {type: "remove"}, {type: "webhook", url, secret}, {type: "delete_message"}] — cada uma aceita delay_min_s/delay_max_s',
        },
      },
      save_selection: { params: { name: 'nome da seleção salva', groups: 'seletor' } },
    },
    example: {
      isigroup_plan: 1,
      name: 'Setup turmas de outubro',
      defaults: { pace: 'slow', on_error: 'continue' },
      actions: [
        { id: 'turmas', type: 'create_groups', params: { name: 'Turma {x}', quantity: 3, start: 10, description: 'Avisos da turma. Regras fixadas.', image: { file: 'media/capa.png' }, admins: ['5511999998888'] } },
        { type: 'schedule', params: { targets: { ref: 'turmas' }, kind: 'recurring', recur_dow: 1, recur_time: '09:00', steps: [{ type: 'text', text: 'Bom dia! Agenda da semana 👇' }, { type: 'audio', media: { file: 'media/bomdia.mp3' } }] } },
        { type: 'automation_rule', params: { name: 'Boas-vindas', trigger_type: 'join', scope: { ref: 'turmas' }, actions: [{ type: 'dm', steps: [{ type: 'text', text: 'Bem-vindo! Leia as regras fixadas.' }] }] } },
      ],
    },
    notes: [
      'A importação SEMPRE mostra uma prévia e exige confirmação humana antes de executar.',
      'Reaplicar um plano já aplicado exige confirmação extra (guarda por hash).',
      'Os limites anti-banimento do app valem por construção (máx. 30 criações e 30 adições por disparo, ritmo aleatório entre operações).',
      'Datas "once" usam ISO 8601 com offset de fuso; recorrência usa a hora local da máquina do isigroup.',
    ],
  };
}
