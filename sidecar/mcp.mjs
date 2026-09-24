#!/usr/bin/env node
// isigroup — ponte MCP (Model Context Protocol) para IAs locais (Claude Code).
//
// Servidor MCP por STDIO (JSON-RPC 2.0, uma mensagem por linha), implementado
// a mao (sem SDK) para nao adicionar dependencia. E uma PONTE FINA: cada tool
// vira uma chamada a API HTTP local do sidecar (127.0.0.1 + token), descoberta
// pelo arquivo integration.json que o app grava quando a opcao "Permitir
// controle por IA (MCP)" esta ligada.
//
// Seguranca:
//  * So funciona na MESMA maquina, com o isigroup ABERTO e a integracao ligada.
//  * Toda acao de RISCO (criar grupos, membros, agendar, regras, aplicar plano)
//    NAO executa direto: vira uma pendencia que o usuario aprova/recusa no app.
//    A tool aguarda a decisao (ate ~110 s) e retorna o resultado real.
//  * Acoes de escrita passam pelo motor de planos (isiplan) — mesmas validacoes,
//    mesma previa e mesmos limites anti-banimento da importacao manual.
//
// Registro no Claude Code:
//   claude mcp add isigroup -- node "<caminho>/mcp.mjs"

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { integrationFilePath } from './src/integration.mjs';

const SERVER_INFO = { name: 'isigroup', version: '1.0.0' };

const INSTRUCTIONS = `Ponte de controle do isigroup (automação de grupos de WhatsApp) rodando NESTA máquina.
Fluxo recomendado: get_status → sync_groups → list_groups → montar a ação → executar.
Ações de risco (create_groups, bulk_members, edit_groups, create_schedule, regras, apply_plan) exigem aprovação do usuário DENTRO do app isigroup: a tool fica aguardando a decisão e retorna o resultado. Se voltar "pending", use wait_approval.
Para planos completos (várias ações com dependências), monte um isiplan (veja get_plan_schema), valide com validate_plan e aplique com apply_plan; acompanhe com get_plan_run.
Grupos são endereçados por NOME (seletores {"names": [...]} ou {"match": "padrão *"}), nunca por jid inventado. Telefones sempre com DDI+DDD (ex: 5511999998888).
Nunca dispare adições de membros em massa sem o usuário pedir explicitamente — é a ação com maior risco de banimento do chip.`;

// ============================================================================
//  Cliente da API local (descoberta via integration.json)
// ============================================================================

let cfg = null;

function readConfig(force = false) {
  if (cfg && !force) return cfg;
  const path = integrationFilePath();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      'isigroup não encontrado: abra o app isigroup nesta máquina e ative "Permitir controle por IA (MCP)" na aba Planos & IA.'
    );
  }
  const parsed = JSON.parse(raw);
  if (!parsed?.port || !parsed?.token) throw new Error('integration.json inválido — desligue e ligue a integração no isigroup.');
  cfg = parsed;
  return cfg;
}

async function api(method, path, body, opts = {}) {
  let attempt = 0;
  for (;;) {
    const c = readConfig(attempt > 0);
    try {
      const headers = { 'x-isi-token': c.token, ...(opts.headers ?? {}) };
      let payload;
      if (opts.binary) {
        payload = opts.binary;
      } else if (body != null) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(`http://127.0.0.1:${c.port}${path}`, { method, headers, body: payload });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.message || data?.error || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.data = data;
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      // Porta antiga (app reiniciou): rele o arquivo de descoberta uma vez.
      const connErr = e?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(e?.message ?? '');
      if (connErr && attempt === 0) {
        attempt++;
        continue;
      }
      if (connErr) {
        throw new Error('não foi possível falar com o isigroup — o app está aberto e com a integração ligada?');
      }
      throw e;
    }
  }
}

// ============================================================================
//  Aprovacao humana (acoes de risco)
// ============================================================================

async function approveAndRun(tool, summary, payload) {
  const req = await api('POST', '/integration/request', { tool, summary, payload });
  const res = await api('GET', `/integration/approvals/${req.id}/wait?timeout_s=110`);
  if (res.status === 'approved') {
    return { approved: true, result: res.result };
  }
  if (res.status === 'denied') {
    return { approved: false, message: 'O usuário RECUSOU esta ação no isigroup. Não repita sem falar com ele.' };
  }
  if (res.status === 'expired') {
    return { approved: false, message: 'O pedido expirou sem decisão do usuário (10 min).' };
  }
  return {
    pending: true,
    approval_id: req.id,
    message: 'Aguardando o usuário aprovar no isigroup — chame wait_approval com este approval_id para continuar aguardando.',
  };
}

// Acao de risco individual = plano isiplan de UMA acao: mesmas validacoes,
// previa (vira o resumo da aprovacao) e limites da importacao manual.
async function runPlanAction(tool, planName, action) {
  const plan = { isigroup_plan: 1, name: planName, actions: [action] };
  const v = await api('POST', '/plans/validate', plan);
  const summary = buildSummary(v);
  const out = await approveAndRun(tool, summary, {
    method: 'POST',
    path: '/plans/apply',
    body: { staged_id: v.staged_id, confirm_reapply: true, source: 'mcp' },
  });
  if (out.approved) {
    return {
      ...out.result,
      note: 'Plano em execução — acompanhe com get_plan_run(run_id). Avisos da validação: ' + (v.warnings?.join(' | ') || 'nenhum'),
    };
  }
  return out;
}

function buildSummary(validation) {
  const items = validation.preview?.items ?? [];
  let s = items.map((i) => i.summary).join(' · ');
  if (validation.warnings?.length) s += ` ⚠ ${validation.warnings.join(' ⚠ ')}`;
  return s.slice(0, 480) || 'ação via MCP';
}

// Seletor de grupos a partir dos args da tool ({names} e/ou {match}).
function sel(g, label = 'groups') {
  const out = [];
  if (g && Array.isArray(g.names) && g.names.length) out.push({ names: g.names.map(String) });
  if (g && typeof g.match === 'string' && g.match.trim()) out.push({ match: g.match });
  if (out.length === 0) throw new Error(`${label} precisa de {"names": ["Nome do grupo"]} e/ou {"match": "padrão *"}`);
  return out.length === 1 ? out[0] : out;
}

const GROUPS_SCHEMA = {
  type: 'object',
  description: 'Seletor de grupos por nome: {"names": ["Nome Exato"]} e/ou {"match": "padrão com *"}',
  properties: {
    names: { type: 'array', items: { type: 'string' }, description: 'Nomes exatos de grupos já sincronizados' },
    match: { type: 'string', description: 'Padrão glob sobre os nomes (ex: "Turma *")' },
  },
};

const STEPS_SCHEMA = {
  type: 'array',
  description: 'Passos da mensagem, em ordem',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['text', 'image', 'audio', 'video', 'poll'] },
      text: { type: 'string', description: 'texto da mensagem ou legenda (image/video)' },
      media: { type: 'object', description: 'objeto retornado por upload_media (image/audio/video)' },
      poll: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
          selectableCount: { type: 'number' },
        },
      },
    },
    required: ['type'],
  },
};

// ============================================================================
//  Tools
// ============================================================================

const TOOLS = [
  // --- Leitura ---
  {
    name: 'get_status',
    description: 'Estado geral do isigroup: versão, edição (free/pro), chips (contas WhatsApp) e conexão de cada um.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [health, accounts] = await Promise.all([api('GET', '/health'), api('GET', '/accounts')]);
      return { app_version: health.version, edition: accounts.edition, chips: accounts.accounts.map(chipView) };
    },
  },
  {
    name: 'list_chips',
    description: 'Lista os chips (contas WhatsApp) com rótulo, status de conexão e contagem de grupos.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/accounts')).accounts.map(chipView),
  },
  {
    name: 'list_groups',
    description: 'Lista os grupos/comunidades sincronizados (nome, jid, se o chip é admin). Rode sync_groups antes se a lista parecer desatualizada.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/targets')).targets,
  },
  {
    name: 'list_schedules',
    description: 'Lista os agendamentos de mensagem (únicos e recorrentes) com status e contadores.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/schedules')).schedules,
  },
  {
    name: 'get_schedule',
    description: 'Detalhe de um agendamento (passos, grupos-alvo, status por grupo).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (a) => api('GET', `/schedules/${Number(a.id)}`),
  },
  {
    name: 'list_rules',
    description: 'Lista as regras de automação (gatilhos de mensagem/entrada/saída e suas ações).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/automation/rules')).rules,
  },
  {
    name: 'list_automation_logs',
    description: 'Últimos disparos das regras de automação.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/automation/logs')).logs,
  },
  {
    name: 'list_bulk_jobs',
    description: 'Lista as ações em massa (criação de grupos, membros, edição) com progresso.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/bulk')).jobs,
  },
  {
    name: 'get_bulk_job',
    description: 'Detalhe de uma ação em massa, item a item.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (a) => api('GET', `/bulk/${Number(a.id)}`),
  },
  {
    name: 'list_selections',
    description: 'Lista as seleções de grupos salvas.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/selections')).selections,
  },
  {
    name: 'list_plan_runs',
    description: 'Lista as execuções de planos (isiplan) com status.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await api('GET', '/plans/runs')).runs,
  },
  {
    name: 'get_plan_run',
    description: 'Detalhe de uma execução de plano: passo a passo com status e resultados. Use para acompanhar um apply_plan.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'number' } }, required: ['run_id'] },
    handler: async (a) => api('GET', `/plans/runs/${Number(a.run_id)}`),
  },
  {
    name: 'get_plan_schema',
    description: 'Documentação completa do formato de planos isiplan (ações, seletores, mídia, exemplo). Leia antes de montar um plano para apply_plan.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => api('GET', '/plans/schema'),
  },

  // --- Escrita leve (sem aprovação) ---
  {
    name: 'sync_groups',
    description: 'Sincroniza a lista de grupos de todos os chips conectados (atualiza nomes e admin).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => api('POST', '/targets/sync'),
  },
  {
    name: 'save_selection',
    description: 'Salva uma seleção de grupos (atalho do agendador). Passe os jids obtidos em list_groups.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, jids: { type: 'array', items: { type: 'string' } } },
      required: ['name', 'jids'],
    },
    handler: async (a) => api('POST', '/selections', { name: a.name, jids: a.jids }),
  },
  {
    name: 'upload_media',
    description: 'Envia uma mídia (imagem/áudio/vídeo) em base64 para o isigroup e retorna o objeto media para usar em passos de mensagem/planos. Áudio vira nota de voz (PTT) automaticamente.',
    inputSchema: {
      type: 'object',
      properties: {
        base64: { type: 'string' },
        mime: { type: 'string', description: 'ex: image/png, audio/mpeg, video/mp4' },
        filename: { type: 'string' },
      },
      required: ['base64', 'mime'],
    },
    handler: async (a) => {
      const buf = Buffer.from(String(a.base64), 'base64');
      if (buf.length === 0) throw new Error('base64 vazio');
      const r = await api('POST', '/media/upload', null, {
        binary: buf,
        headers: { 'content-type': a.mime, 'x-filename': encodeURIComponent(a.filename ?? 'arquivo') },
      });
      return r.media;
    },
  },
  {
    name: 'validate_plan',
    description: 'Valida um plano isiplan (objeto JSON) SEM executar: retorna a prévia, avisos e se já foi aplicado antes. Use sempre antes de apply_plan.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' } }, required: ['plan'] },
    handler: async (a) => {
      const v = await api('POST', '/plans/validate', a.plan);
      return { staged_id: v.staged_id, name: v.name, preview: v.preview, warnings: v.warnings, already_applied: v.already_applied };
    },
  },

  // --- Escrita de risco (aprovação do usuário no app) ---
  {
    name: 'apply_plan',
    description: 'Aplica um plano isiplan completo (várias ações com dependências). EXIGE aprovação do usuário no app. Se o plano já foi aplicado antes, pergunte ao usuário e repita com confirm_reapply=true. Retorna run_id — acompanhe com get_plan_run.',
    inputSchema: {
      type: 'object',
      properties: { plan: { type: 'object' }, confirm_reapply: { type: 'boolean' } },
      required: ['plan'],
    },
    handler: async (a) => {
      const v = await api('POST', '/plans/validate', a.plan);
      if (v.already_applied && !a.confirm_reapply) {
        return {
          already_applied: v.already_applied,
          preview: v.preview,
          warnings: v.warnings,
          message:
            `Este plano JÁ FOI APLICADO em ${v.already_applied.at} (run ${v.already_applied.run_id}). ` +
            'Pergunte ao usuário se tem certeza de que quer reaplicar; em caso afirmativo, chame apply_plan de novo com confirm_reapply=true.',
        };
      }
      let summary = `Plano "${v.name}": ${buildSummary(v)}`;
      if (v.already_applied) summary = `⚠ REAPLICAÇÃO (já aplicado em ${v.already_applied.at}) · ${summary}`;
      const out = await approveAndRun('apply_plan', summary.slice(0, 480), {
        method: 'POST',
        path: '/plans/apply',
        body: { staged_id: v.staged_id, confirm_reapply: !!a.confirm_reapply || !v.already_applied, source: 'mcp' },
      });
      if (out.approved) return { ...out.result, note: 'Plano em execução — acompanhe com get_plan_run(run_id).' };
      return out;
    },
  },
  {
    name: 'create_groups',
    description: 'Cria grupos de WhatsApp (1–30). Use {x} no nome para numeração sequencial a partir de "start". EXIGE aprovação do usuário no app.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'nome do grupo; {x} vira o número sequencial' },
        quantity: { type: 'number' },
        start: { type: 'number', description: 'primeiro número da sequência (padrão 1)' },
        description: { type: 'string' },
        image: { type: 'object', description: 'objeto media de upload_media (imagem)' },
        admins: { type: 'array', items: { type: 'string' }, description: 'telefones DDI+DDD promovidos a admin' },
        members: { type: 'array', items: { type: 'string' } },
        chip_label: { type: 'string', description: 'rótulo do chip criador (padrão: automático)' },
        pace: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
      required: ['name'],
    },
    handler: async (a) =>
      runPlanAction('create_groups', `MCP: criar grupos`, {
        id: 'novos',
        type: 'create_groups',
        params: {
          name: a.name,
          quantity: a.quantity ?? 1,
          start: a.start ?? 1,
          description: a.description,
          image: a.image,
          admins: a.admins,
          members: a.members,
          chip: a.chip_label ? { label: a.chip_label } : 'auto',
          pace: a.pace,
        },
      }),
  },
  {
    name: 'bulk_members',
    description: 'Ação em massa de membros: add (adicionar — ALTO risco de banimento, máx. 30 adições), remove, promote ou demote. EXIGE aprovação do usuário no app.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'remove', 'promote', 'demote'] },
        groups: GROUPS_SCHEMA,
        contacts: { type: 'array', items: { type: 'string' }, description: 'telefones DDI+DDD' },
        pace: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
      required: ['op', 'groups', 'contacts'],
    },
    handler: async (a) => {
      const type = { add: 'add_members', remove: 'remove_members', promote: 'promote', demote: 'demote' }[a.op];
      if (!type) throw new Error('op deve ser add, remove, promote ou demote');
      return runPlanAction('bulk_members', `MCP: ${type}`, {
        type,
        params: { groups: sel(a.groups), contacts: a.contacts, pace: a.pace },
      });
    },
  },
  {
    name: 'edit_groups',
    description: 'Edita grupos existentes (nome, descrição, imagem, configurações). EXIGE aprovação do usuário no app.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: GROUPS_SCHEMA,
        name: { type: 'string' },
        description: { type: 'string', description: 'vazio limpa a descrição' },
        image: { type: 'object', description: 'objeto media de upload_media (imagem)' },
        settings: {
          type: 'object',
          properties: {
            announce: { type: 'string', enum: ['all', 'admins'] },
            edit: { type: 'string', enum: ['all', 'admins'] },
            add: { type: 'string', enum: ['all', 'admins'] },
            approval: { type: 'string', enum: ['on', 'off'] },
          },
        },
        pace: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
      required: ['groups'],
    },
    handler: async (a) =>
      runPlanAction('edit_groups', 'MCP: editar grupos', {
        type: 'edit_groups',
        params: { groups: sel(a.groups), name: a.name, description: a.description, image: a.image, settings: a.settings, pace: a.pace },
      }),
  },
  {
    name: 'create_schedule',
    description: 'Agenda mensagens (única ou recorrente) para grupos, com sequência de passos (texto/imagem/áudio/vídeo/enquete). EXIGE aprovação do usuário no app.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: GROUPS_SCHEMA,
        name: { type: 'string' },
        kind: { type: 'string', enum: ['once', 'recurring'] },
        scheduled_at: { type: 'string', description: 'once: ISO 8601 com fuso (ex: 2026-10-01T09:00:00-03:00)' },
        recur_dow: { type: 'number', description: 'recurring: 0 (domingo) a 6 (sábado)' },
        recur_time: { type: 'string', description: 'recurring: HH:MM (hora local do app)' },
        recur_week_parity: {
          type: 'string',
          enum: ['odd', 'even'],
          description: 'recurring, opcional: "odd" = só semanas ímpares, "even" = só pares. Omitir = todas as semanas. Semana ISO-8601 (igual ao Google Agenda)',
        },
        steps: STEPS_SCHEMA,
        step_min_s: { type: 'number' },
        step_max_s: { type: 'number' },
        chips: { type: 'array', items: { type: 'string' }, description: 'pool de rótulos de chips (Pro)' },
      },
      required: ['targets', 'kind', 'steps'],
    },
    handler: async (a) =>
      runPlanAction('create_schedule', 'MCP: agendar mensagem', {
        type: 'schedule',
        params: {
          targets: sel(a.targets, 'targets'),
          name: a.name,
          kind: a.kind,
          scheduled_at: a.scheduled_at,
          recur_dow: a.recur_dow,
          recur_time: a.recur_time,
          recur_week_parity: a.recur_week_parity,
          steps: a.steps,
          step_min_s: a.step_min_s,
          step_max_s: a.step_max_s,
          chips: a.chips,
        },
      }),
  },
  {
    name: 'cancel_schedule',
    description: 'Cancela um agendamento pendente/ativo. EXIGE aprovação do usuário no app.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (a) =>
      approveAndRun('cancel_schedule', `Cancelar o agendamento #${a.id}`, {
        method: 'POST',
        path: `/schedules/${Number(a.id)}/cancel`,
      }),
  },
  {
    name: 'create_rule',
    description: 'Cria uma regra de automação (gatilho: mensagem/link/entrada/saída → responder no grupo, DM, remover, webhook, apagar mensagem). EXIGE aprovação do usuário no app.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        trigger_type: { type: 'string', enum: ['message', 'message_link', 'join', 'leave'] },
        match_type: { type: 'string', enum: ['starts_with', 'contains', 'ends_with', 'exact'], description: 'só para trigger message' },
        pattern: { type: 'string', description: 'só para trigger message' },
        case_sensitive: { type: 'boolean' },
        scope: GROUPS_SCHEMA,
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['group_message', 'dm', 'remove', 'webhook', 'delete_message'] },
              steps: STEPS_SCHEMA,
              url: { type: 'string' },
              secret: { type: 'string' },
              delay_min_s: { type: 'number' },
              delay_max_s: { type: 'number' },
            },
            required: ['type'],
          },
        },
      },
      required: ['name', 'trigger_type', 'scope', 'actions'],
    },
    handler: async (a) =>
      runPlanAction('create_rule', 'MCP: criar regra', {
        type: 'automation_rule',
        params: {
          name: a.name,
          trigger_type: a.trigger_type,
          match_type: a.match_type,
          pattern: a.pattern,
          case_sensitive: a.case_sensitive,
          scope: sel(a.scope, 'scope'),
          actions: a.actions,
        },
      }),
  },
  {
    name: 'update_rule',
    description: 'Substitui uma regra de automação existente (corpo completo no formato de list_rules, com scope em jids). EXIGE aprovação do usuário no app.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, rule: { type: 'object', description: 'corpo completo: name, trigger_type, match_type, pattern, case_sensitive, scope (jids), actions' } },
      required: ['id', 'rule'],
    },
    handler: async (a) =>
      approveAndRun('update_rule', `Editar a regra #${a.id} ("${a.rule?.name ?? '?'}")`, {
        method: 'PUT',
        path: `/automation/rules/${Number(a.id)}`,
        body: a.rule,
      }),
  },
  {
    name: 'toggle_rule',
    description: 'Ativa/desativa uma regra de automação. EXIGE aprovação do usuário no app.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (a) =>
      approveAndRun('toggle_rule', `Ativar/desativar a regra #${a.id}`, {
        method: 'POST',
        path: `/automation/rules/${Number(a.id)}/toggle`,
      }),
  },
  {
    name: 'delete_rule',
    description: 'Apaga uma regra de automação. EXIGE aprovação do usuário no app.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async (a) =>
      approveAndRun('delete_rule', `APAGAR a regra #${a.id}`, {
        method: 'DELETE',
        path: `/automation/rules/${Number(a.id)}`,
      }),
  },
  {
    name: 'wait_approval',
    description: 'Continua aguardando a decisão do usuário sobre uma aprovação pendente (retornada por uma ação de risco como {pending: true}).',
    inputSchema: {
      type: 'object',
      properties: { approval_id: { type: 'number' }, timeout_s: { type: 'number', description: 'máx 110' } },
      required: ['approval_id'],
    },
    handler: async (a) => {
      const r = await api('GET', `/integration/approvals/${Number(a.approval_id)}/wait?timeout_s=${Math.min(Number(a.timeout_s ?? 110), 110)}`);
      if (r.status === 'approved') return { approved: true, result: r.result };
      if (r.status === 'denied') return { approved: false, message: 'O usuário RECUSOU a ação.' };
      if (r.status === 'expired') return { approved: false, message: 'O pedido expirou sem decisão.' };
      return { pending: true, approval_id: a.approval_id, message: 'Ainda aguardando — chame wait_approval novamente.' };
    },
  },
];

function chipView(a) {
  return { id: a.id, label: a.label, status: a.status, jid: a.jid, groups: a.groups, admin_groups: a.admin_groups };
}

// ============================================================================
//  Loop JSON-RPC (stdio, uma mensagem por linha)
// ============================================================================

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return replyError(id, -32602, `tool desconhecida: ${params?.name}`);
    try {
      const result = await tool.handler(params?.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result ?? {}, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Erro: ${e?.message ?? 'falha desconhecida'}` }], isError: true });
    }
  }
  // Notificacoes (sem id) e metodos desconhecidos.
  if (id != null) replyError(id, -32601, `método não suportado: ${method}`);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // linha invalida — ignora
  }
  handle(msg).catch((e) => {
    if (msg?.id != null) replyError(msg.id, -32603, e?.message ?? 'erro interno');
  });
});
rl.on('close', () => process.exit(0));
