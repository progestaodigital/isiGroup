// Exportacao da configuracao do app como um plano isiplan.
//
// Decisao central: o arquivo exportado E um isiplan valido, importavel pela
// aba Planos & IA. Isso evita um segundo formato (e um segundo importador)
// e garante que exportar/importar passe pela MESMA validacao de sempre.
//
// O que sai: apenas CONFIGURACAO. Historico (logs de automacao, execucoes de
// acoes em massa, eventos de entrada/saida, perguntas aos agentes) fica de
// fora — e dado da maquina de origem e so sujaria a importacao.
//
// O que NUNCA sai: a sessao do WhatsApp (wa-session), a chave da licenca e a
// chave da OpenAI. As duas ultimas vivem no keyring do SO por decisao de
// projeto; exporta-las anularia isso.
//
// Grupos viram SELETOR POR NOME ({"names": [...]}), como o formato exige —
// jid nunca entra num plano, porque ele so vale na maquina que sincronizou.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Nao ha secao de "webhooks": a tabela homonima foi removida na migration 010.
// Webhook hoje e uma ACAO dentro de uma regra de automacao, entao ja sai
// junto com a secao `automations` (o segredo segue a escolha do usuario).
export const SECOES = ['schedules', 'automations', 'agents', 'bulk', 'selections', 'accounts'];

export function createExporter(db) {
  // --- jid -> nome do grupo (o plano nunca carrega jid) ---

  // Um jid pode ter varias linhas em `targets` (uma por chip). Fica o nome
  // sincronizado mais recentemente.
  function nomePorJid() {
    const mapa = new Map();
    for (const t of db.prepare('SELECT jid, name, last_synced_at FROM targets WHERE name IS NOT NULL').all()) {
      const cur = mapa.get(t.jid);
      if (!cur || (t.last_synced_at ?? '') > (cur.last_synced_at ?? '')) mapa.set(t.jid, t);
    }
    return new Map([...mapa].map(([jid, t]) => [jid, t.name]));
  }

  // Nomes repetidos entre grupos DIFERENTES: na importacao o seletor por nome
  // nao saberia qual escolher. Detectado aqui para avisar antes, em vez de
  // quebrar do outro lado.
  function nomesAmbiguos(nomes) {
    const porNome = new Map();
    for (const [jid, nome] of nomes) {
      const chave = nome.trim().toLowerCase();
      if (!porNome.has(chave)) porNome.set(chave, new Set());
      porNome.get(chave).add(jid);
    }
    return [...porNome.entries()].filter(([, jids]) => jids.size > 1).map(([nome]) => nome);
  }

  // Converte uma lista de jids no seletor do formato. Jids sem nome conhecido
  // (grupo saiu, nunca sincronizou) sao reportados como perdidos.
  function seletor(jids, nomes, perdidos) {
    const out = [];
    for (const jid of jids) {
      const nome = nomes.get(jid);
      if (nome) out.push(nome);
      else perdidos.push(jid);
    }
    return { names: [...new Set(out)] };
  }

  // --- Midia: vira {file: "media/<arquivo>"} + o byte no pacote ---

  function refMidia(caminho, midias) {
    if (!caminho) return null;
    const nome = basename(caminho);
    if (!midias.has(nome)) {
      try {
        midias.set(nome, readFileSync(caminho));
      } catch {
        return null; // arquivo sumiu do disco: o passo sai sem midia
      }
    }
    return { file: `media/${nome}` };
  }

  // Midias de um passo (rodizio): tabela filha, com fallback para a coluna
  // legada. Sem isso, exportar/importar descartaria as variacoes em silencio.
  function caminhosDoPasso(s) {
    if (s.id != null) {
      const rows = db
        .prepare('SELECT path FROM schedule_step_media WHERE step_id = ? ORDER BY order_index, id')
        .all(s.id);
      if (rows.length) return rows.map((r) => r.path);
    }
    if (Array.isArray(s.medias) && s.medias.length) return s.medias.map((m) => m.stored_path);
    const unico = s.media_path ?? s.media?.stored_path ?? null;
    return unico ? [unico] : [];
  }

  // Passo de conteudo (agendamento / acao de regra) no formato do plano.
  function passo(s, midias) {
    const tipo = s.payload_type ?? 'text';
    const corpo = safeObj(s.body_json);
    if (tipo === 'poll') return corpo.poll ? { type: 'poll', poll: corpo.poll } : null;
    if (tipo === 'text') {
      const texto = String(corpo.text ?? s.text ?? '').trim();
      return texto ? { type: 'text', text: texto } : null;
    }
    const refs = caminhosDoPasso(s).map((c) => refMidia(c, midias)).filter(Boolean);
    if (refs.length === 0) return null;
    // Uma midia sai como `media` (formato antigo); varias, como `medias`.
    const p = refs.length > 1 ? { type: tipo, medias: refs } : { type: tipo, media: refs[0] };
    // Audio vira nota de voz e nao aceita legenda.
    if (tipo !== 'audio' && corpo.caption) p.text = String(corpo.caption);
    return p;
  }

  // --- Contagem por secao (a tela mostra antes de exportar) ---

  function resumo() {
    const n = (sql) => db.prepare(sql).get().n;
    return {
      schedules: n('SELECT COUNT(*) n FROM schedules'),
      automations: n('SELECT COUNT(*) n FROM automation_rules'),
      agents: n('SELECT COUNT(*) n FROM ai_agents'),
      bulk: n('SELECT COUNT(*) n FROM bulk_recurring'),
      selections: n('SELECT COUNT(*) n FROM group_selections'),
      // Webhooks configurados dentro das regras — contados para a tela mostrar
      // que eles saem junto com as automacoes.
      webhooks_em_regras: n("SELECT COUNT(*) n FROM automation_actions WHERE action_type = 'webhook'"),
      accounts: n('SELECT COUNT(*) n FROM accounts'),
    };
  }

  // --- Construcao das acoes por secao ---

  function acoesAgendamentos(nomes, midias, perdidos) {
    const out = [];
    for (const s of db.prepare('SELECT * FROM schedules ORDER BY id').all()) {
      const jids = db
        .prepare('SELECT DISTINCT t.jid FROM schedule_targets st JOIN targets t ON t.id = st.target_id WHERE st.schedule_id = ?')
        .all(s.id).map((r) => r.jid);
      if (jids.length === 0) continue;

      const passos = db
        .prepare(
          `SELECT * FROM schedule_steps WHERE schedule_id = ?
            ORDER BY COALESCE(option_index, 0), order_index`
        )
        .all(s.id);

      // Passos agrupados por OPCAO (recorrente variavel). Sem agrupar, as
      // opcoes viriam concatenadas numa sequencia unica na reimportacao.
      const porOpcao = new Map();
      for (const p of passos) {
        const oi = p.option_index ?? 0;
        const conv = passo(p, midias);
        if (!conv) continue;
        if (!porOpcao.has(oi)) porOpcao.set(oi, []);
        porOpcao.get(oi).push(conv);
      }
      let opcoes = [...porOpcao.keys()].sort((a, b) => a - b).map((k) => porOpcao.get(k));

      // Agendamento legado (sem schedule_steps): reconstroi 1 passo a partir
      // de default_json + media_assets.
      if (opcoes.length === 0) {
        const corpo = safeObj(s.default_json);
        const unica = [];
        if (s.payload_type === 'poll' && corpo.poll) unica.push({ type: 'poll', poll: corpo.poll });
        else if (['image', 'video', 'audio'].includes(s.payload_type)) {
          const refs = db
            .prepare('SELECT path FROM media_assets WHERE schedule_id = ? ORDER BY COALESCE(order_index, 0), id')
            .all(s.id)
            .map((a) => refMidia(a.path, midias))
            .filter(Boolean);
          if (refs.length) {
            const p = refs.length > 1 ? { type: s.payload_type, medias: refs } : { type: s.payload_type, media: refs[0] };
            if (s.payload_type !== 'audio' && corpo.text) p.text = String(corpo.text);
            unica.push(p);
          }
        } else if (corpo.text) unica.push({ type: 'text', text: String(corpo.text) });
        if (unica.length) opcoes = [unica];
      }
      if (opcoes.length === 0) continue;

      const params = {
        targets: seletor(jids, nomes, perdidos),
        kind: s.kind === 'recurring' ? 'recurring' : 'once',
        name: s.name ?? undefined,
        steps: opcoes[0],
      };
      // Mais de uma opcao: exporta como recorrente variavel.
      if (opcoes.length > 1) {
        params.options = opcoes.map((steps) => ({ steps }));
        params.variant_mode = s.variant_mode === 'sequential' ? 'sequential' : 'random';
      }
      if (params.kind === 'once') {
        params.scheduled_at = s.scheduled_at;
      } else {
        params.recur_dow = s.recur_dow;
        params.recur_time = s.recur_time;
        // Paridade da semana (migration 016) — o que o usuario pediu para nao perder.
        if (s.recur_week_mod === 2) params.recur_week_parity = s.recur_week_rem === 1 ? 'odd' : 'even';
      }
      if (s.step_min_s != null) params.step_min_s = s.step_min_s;
      if (s.step_max_s != null) params.step_max_s = s.step_max_s;
      out.push({ type: 'schedule', params });
    }
    return out;
  }

  function acoesAutomacoes(nomes, midias, perdidos, comSegredos) {
    const out = [];
    for (const r of db.prepare('SELECT * FROM automation_rules ORDER BY id').all()) {
      const escopo = safeArr(r.scope_json);
      const acoes = [];
      for (const a of db.prepare('SELECT * FROM automation_actions WHERE rule_id = ? ORDER BY order_index').all(r.id)) {
        const cfg = safeObj(a.config_json);
        const na = { type: a.action_type };
        if (a.action_type === 'group_message' || a.action_type === 'dm') {
          na.steps = (cfg.steps ?? []).map((s) => passo(normalizaPassoCfg(s), midias)).filter(Boolean);
          if (na.steps.length === 0) continue;
          if (cfg.step_min_s != null) na.step_min_s = cfg.step_min_s;
          if (cfg.step_max_s != null) na.step_max_s = cfg.step_max_s;
        } else if (a.action_type === 'webhook') {
          if (!cfg.url) continue;
          na.url = cfg.url;
          if (comSegredos && cfg.secret) na.secret = cfg.secret;
        }
        if (cfg.delay_min_s != null) na.delay_min_s = cfg.delay_min_s;
        if (cfg.delay_max_s != null) na.delay_max_s = cfg.delay_max_s;
        acoes.push(na);
      }
      if (acoes.length === 0) continue;

      const params = {
        name: r.name,
        trigger_type: r.trigger_type ?? 'message',
        scope: escopo.length ? seletor(escopo, nomes, perdidos) : { match: '*' },
        case_sensitive: !!r.case_sensitive,
        actions: acoes,
      };
      if (params.trigger_type === 'message') {
        params.match_type = r.match_type ?? 'contains';
        params.pattern = r.pattern ?? '';
        // Gatilho message sem pattern nao passa na validacao do importador.
        if (!params.pattern) continue;
      }
      out.push({ type: 'automation_rule', params });
    }
    return out;
  }

  // Passo gravado na config de uma regra -> forma que `passo()` entende.
  const normalizaPassoCfg = (s) => ({
    payload_type: s.type ?? s.payload_type ?? 'text',
    body_json: JSON.stringify({ text: s.text, caption: s.text, poll: s.poll }),
    media_path: s.media?.stored_path ?? s.media_path ?? null,
    medias: Array.isArray(s.medias) && s.medias.length ? s.medias : undefined,
    text: s.text,
  });

  function acoesAgentes(nomes, perdidos) {
    const out = [];
    for (const a of db.prepare('SELECT * FROM ai_agents ORDER BY id').all()) {
      // Conhecimento vai como TEXTO. Os vetores sao derivados e caros; a
      // importacao reindexa com a chave de quem importou.
      const docs = db
        .prepare("SELECT title, source, source_ref, content FROM ai_documents WHERE agent_id = ? AND content != '' ORDER BY id")
        .all(a.id)
        .map((d) => ({ title: d.title, source: d.source, source_ref: d.source_ref ?? undefined, content: d.content }));

      out.push({
        id: `agente_${a.id}`, // referenciavel pelos vinculos abaixo
        type: 'ai_agent',
        params: {
          name: a.name,
          description: a.description,
          system_prompt: a.system_prompt,
          model: a.model,
          keywords: safeArr(a.keywords_json),
          min_similarity: a.min_similarity,
          use_in_triage: !!a.use_in_triage,
          enabled: !!a.enabled,
          knowledge: docs,
        },
      });
    }

    for (const b of db.prepare('SELECT * FROM ai_group_bindings ORDER BY id').all()) {
      const alvo = seletor([b.target_jid], nomes, perdidos);
      if (alvo.names.length === 0) continue;
      const params = {
        groups: alvo,
        mode: b.mode,
        trigger_mode: b.trigger_mode,
        case_sensitive: !!b.case_sensitive,
        max_hops: b.max_hops,
        enabled: !!b.enabled,
      };
      if (b.mode === 'agent' && b.agent_id) params.agent_ref = `agente_${b.agent_id}`;
      if (b.trigger_mode === 'match') {
        params.match_type = b.match_type;
        params.pattern = b.pattern;
      }
      out.push({ type: 'ai_binding', params });
    }
    return out;
  }

  function acoesBulk(nomes, midias, perdidos) {
    const out = [];
    for (const r of db.prepare("SELECT * FROM bulk_recurring WHERE status != 'canceled' ORDER BY id").all()) {
      const jids = safeArr(r.groups_json).map((g) => g?.jid).filter(Boolean);
      if (jids.length === 0) continue;
      const p = safeObj(r.params_json);
      const params = {
        groups: seletor(jids, nomes, perdidos),
        name: r.name ?? undefined,
        recur_dow: r.recur_dow,
        recur_time: r.recur_time,
        pace: p.pace ?? 'normal',
        enabled: r.status === 'active',
      };
      if (r.recur_week_mod === 2) params.recur_week_parity = r.recur_week_rem === 1 ? 'odd' : 'even';
      if (typeof p.name === 'string') params.set_name = p.name;
      if (typeof p.description === 'string') params.set_description = p.description;
      if (p.settings) params.settings = p.settings;
      const img = refMidia(p.media_path, midias);
      if (img) params.image = img;
      out.push({ type: 'bulk_recurring', params });
    }
    return out;
  }

  function acoesSelecoes(nomes, perdidos) {
    return db
      .prepare('SELECT * FROM group_selections ORDER BY id')
      .all()
      .map((s) => ({ type: 'save_selection', params: { name: s.name, groups: seletor(safeArr(s.jids_json), nomes, perdidos) } }))
      .filter((a) => a.params.groups.names.length > 0);
  }

  // Rotulo e proxy dos chips. A SESSAO do WhatsApp nunca sai — quem importar
  // conecta o proprio aparelho por QR.
  function acoesContas() {
    return db
      .prepare('SELECT * FROM accounts ORDER BY id')
      .all()
      .map((a) => ({
        type: 'account_settings',
        params: { label: a.label ?? `Chip ${a.id}`, proxy_url: a.proxy_url ?? undefined, proxy_enabled: !!a.proxy_enabled },
      }));
  }

  /**
   * Monta o plano.
   * @param secoes   quais secoes entram (subconjunto de SECOES)
   * @param comSegredos  inclui secrets de webhook (decisao do usuario na tela)
   * @returns { plan, midias: Map<nome, Buffer>, avisos, contagem }
   */
  function build({ secoes = SECOES, comSegredos = false, nome } = {}) {
    const ativas = SECOES.filter((s) => secoes.includes(s));
    const nomes = nomePorJid();
    const midias = new Map();
    const perdidos = [];
    const acoes = [];

    if (ativas.includes('selections')) acoes.push(...acoesSelecoes(nomes, perdidos));
    if (ativas.includes('accounts')) acoes.push(...acoesContas());
    if (ativas.includes('agents')) acoes.push(...acoesAgentes(nomes, perdidos));
    if (ativas.includes('schedules')) acoes.push(...acoesAgendamentos(nomes, midias, perdidos));
    if (ativas.includes('automations')) acoes.push(...acoesAutomacoes(nomes, midias, perdidos, comSegredos));
    if (ativas.includes('bulk')) acoes.push(...acoesBulk(nomes, midias, perdidos));

    const avisos = [];
    const ambiguos = nomesAmbiguos(nomes);
    if (ambiguos.length) {
      avisos.push(
        `${ambiguos.length} nome(s) de grupo aparecem em mais de um grupo (${ambiguos.slice(0, 3).join(', ')}` +
        `${ambiguos.length > 3 ? '…' : ''}). O plano referencia grupos por nome, entao a importacao nao saberia qual escolher — renomeie antes de exportar.`
      );
    }
    if (perdidos.length) {
      avisos.push(`${new Set(perdidos).size} grupo(s) referenciados nao estao mais sincronizados e ficaram de fora.`);
    }
    if (comSegredos) {
      avisos.push('O arquivo contem segredos de webhook em texto puro — trate como credencial e nao compartilhe.');
    }
    if (ativas.includes('agents')) {
      avisos.push('A chave da OpenAI NAO e exportada (vive no cofre do sistema). Quem importar precisa cadastrar a propria.');
    }

    const plan = {
      isigroup_plan: 1,
      name: nome || `Configuração do isigroup — ${new Date().toISOString().slice(0, 10)}`,
      exported_at: new Date().toISOString(),
      defaults: { pace: 'slow', on_error: 'continue' },
      actions: acoes,
    };

    const contagem = {};
    for (const a of acoes) contagem[a.type] = (contagem[a.type] ?? 0) + 1;

    return { plan, midias, avisos, contagem };
  }

  return { build, resumo, SECOES };
}

function safeObj(s) {
  try {
    const v = JSON.parse(s ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function safeArr(s) {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
