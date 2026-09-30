// CRUD dos agentes, dos documentos de conhecimento e dos vinculos com grupos.
//
// A indexacao (chunk + embedding) roda em SEGUNDO PLANO: o endpoint responde
// na hora com o documento em 'indexing' e a tela faz polling do status. Um PDF
// de 300 paginas levaria dezenas de segundos — segurar o HTTP nisso daria
// timeout e travaria o laco de eventos do sidecar.

import { indexDocument, extractFromFile, extractFromUrl, searchByQuestion } from './knowledge.mjs';
import { setKey, hasKey, maskKey, validateKey, DEFAULT_CHAT_MODEL } from './openai.mjs';

const MAX_AGENTS = 50;
const MAX_DOCS_PER_AGENT = 200;

export function createAi(db) {
  // Documentos indexando agora (evita reprocessar o mesmo em paralelo).
  const indexing = new Set();

  // --- Chave ---

  function applyKey(key) {
    const ok = setKey(key);
    // Chave chegou: indexa o que entrou sem ela (importacao de plano, por ex.).
    if (ok) {
      const pend = db.prepare("SELECT id FROM ai_documents WHERE status = 'pending'").all();
      for (const d of pend) runIndex(d.id);
      if (pend.length) console.error(`[ai] chave configurada — indexando ${pend.length} documento(s) pendente(s)`);
    }
    return { ok, masked: maskKey(), indexing_pending: ok ? db.prepare("SELECT COUNT(*) n FROM ai_documents WHERE status = 'pending'").get().n : 0 };
  }

  const status = () => ({
    has_key: hasKey(),
    masked: maskKey(),
    agents: db.prepare('SELECT COUNT(*) n FROM ai_agents').get().n,
    documents: db.prepare('SELECT COUNT(*) n FROM ai_documents').get().n,
    chunks: db.prepare('SELECT COUNT(*) n FROM ai_chunks WHERE embedding IS NOT NULL').get().n,
    indexing: indexing.size,
  });

  // --- Agentes ---

  function parseAgent(body) {
    const name = String(body?.name ?? '').trim().slice(0, 120);
    if (!name) return { error: 'informe o nome do agente' };

    const keywords = Array.isArray(body?.keywords)
      ? [...new Set(body.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 30)
      : [];

    const min = Number(body?.min_similarity);
    // 0..1: abaixo de 0 aceitaria qualquer coisa; acima de 1 nunca casaria.
    const minSimilarity = Number.isFinite(min) && min >= 0 && min <= 1 ? min : 0.3;

    return {
      name,
      description: String(body?.description ?? '').trim().slice(0, 1000),
      system_prompt: String(body?.system_prompt ?? '').trim().slice(0, 8000),
      model: String(body?.model ?? DEFAULT_CHAT_MODEL).trim() || DEFAULT_CHAT_MODEL,
      keywords_json: JSON.stringify(keywords),
      min_similarity: minSimilarity,
      use_in_triage: body?.use_in_triage ? 1 : 0,
      enabled: body?.enabled === false ? 0 : 1,
    };
  }

  const rowToAgent = (r) => ({
    ...r,
    keywords: safeArr(r.keywords_json),
    keywords_json: undefined,
    use_in_triage: !!r.use_in_triage,
    enabled: !!r.enabled,
  });

  function listAgents() {
    return db
      .prepare(
        `SELECT a.*,
                (SELECT COUNT(*) FROM ai_documents d WHERE d.agent_id = a.id) AS doc_count,
                (SELECT COUNT(*) FROM ai_chunks c WHERE c.agent_id = a.id AND c.embedding IS NOT NULL) AS chunk_count
           FROM ai_agents a ORDER BY a.id DESC`
      )
      .all()
      .map(rowToAgent);
  }

  function getAgent(id) {
    const r = db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(id);
    return r ? rowToAgent(r) : null;
  }

  function createAgent(body) {
    if (db.prepare('SELECT COUNT(*) n FROM ai_agents').get().n >= MAX_AGENTS) {
      return { error: `limite de ${MAX_AGENTS} agentes atingido` };
    }
    const p = parseAgent(body);
    if (p.error) return p;
    const r = db
      .prepare(
        `INSERT INTO ai_agents (name, description, system_prompt, model, keywords_json,
                                min_similarity, use_in_triage, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(p.name, p.description, p.system_prompt, p.model, p.keywords_json,
           p.min_similarity, p.use_in_triage, p.enabled, new Date().toISOString());
    return { id: Number(r.lastInsertRowid) };
  }

  function updateAgent(id, body) {
    if (!db.prepare('SELECT id FROM ai_agents WHERE id = ?').get(id)) return { error: 'not_found' };
    const p = parseAgent(body);
    if (p.error) return p;
    db.prepare(
      `UPDATE ai_agents SET name = ?, description = ?, system_prompt = ?, model = ?, keywords_json = ?,
              min_similarity = ?, use_in_triage = ?, enabled = ?, updated_at = ? WHERE id = ?`
    ).run(p.name, p.description, p.system_prompt, p.model, p.keywords_json,
          p.min_similarity, p.use_in_triage, p.enabled, new Date().toISOString(), id);
    return { ok: true };
  }

  // Apaga o agente com documentos, chunks e vinculos. Limpa explicitamente
  // porque o PRAGMA foreign_keys nao esta garantido em toda conexao.
  function deleteAgent(id) {
    if (!db.prepare('SELECT id FROM ai_agents WHERE id = ?').get(id)) return { error: 'not_found' };
    db.exec('BEGIN;');
    try {
      db.prepare('DELETE FROM ai_chunks WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM ai_documents WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM ai_group_bindings WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM ai_agents WHERE id = ?').run(id);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      return { error: e?.message ?? 'erro ao apagar' };
    }
    return { ok: true };
  }

  // --- Documentos ---

  const listDocuments = (agentId) =>
    db
      .prepare(
        `SELECT id, agent_id, title, source, source_ref, status, error_msg, chunk_count,
                LENGTH(content) AS content_len, created_at, updated_at
           FROM ai_documents WHERE agent_id = ? ORDER BY id DESC`
      )
      .all(agentId);

  // Cria o documento e dispara a indexacao em segundo plano.
  // source: text (content) | url (source_ref) | file (source_ref = caminho)
  async function addDocument(agentId, body) {
    if (!db.prepare('SELECT id FROM ai_agents WHERE id = ?').get(agentId)) return { error: 'not_found' };
    if (db.prepare('SELECT COUNT(*) n FROM ai_documents WHERE agent_id = ?').get(agentId).n >= MAX_DOCS_PER_AGENT) {
      return { error: `limite de ${MAX_DOCS_PER_AGENT} documentos por agente atingido` };
    }

    const source = ['text', 'url', 'file'].includes(body?.source) ? body.source : 'text';
    const ref = String(body?.source_ref ?? '').trim();
    let content = String(body?.content ?? '');
    let title = String(body?.title ?? '').trim().slice(0, 200);

    // Extracao sincrona (ler arquivo / baixar pagina e rapido). O caro e o
    // embedding, e esse vai para segundo plano.
    try {
      if (source === 'file') {
        if (!ref) return { error: 'informe o arquivo' };
        content = await extractFromFile(ref);
        if (!title) title = ref.split(/[\\/]/).pop() ?? 'arquivo';
      } else if (source === 'url') {
        if (!/^https?:\/\//i.test(ref)) return { error: 'informe uma URL http(s) valida' };
        content = await extractFromUrl(ref);
        if (!title) title = ref;
      }
    } catch (e) {
      return { error: e?.message ?? 'falha ao ler a fonte' };
    }

    if (!content.trim()) return { error: 'nao foi possivel extrair texto desta fonte' };
    if (!title) title = content.trim().slice(0, 60);

    // Sem chave, o documento entra como 'pending' em vez de ser recusado: o
    // TEXTO e o que importa (o vetor e derivavel) e descarta-lo perderia
    // conhecimento na importacao de um plano numa maquina ainda sem chave.
    // Assim que a chave chega, tudo que esta pendente e indexado.
    const pronto = hasKey();
    const now = new Date().toISOString();
    const r = db
      .prepare(
        `INSERT INTO ai_documents (agent_id, title, source, source_ref, content, status, created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(agentId, title, source, ref || null, content, pronto ? 'indexing' : 'pending', now);

    const id = Number(r.lastInsertRowid);
    if (pronto) runIndex(id);
    return { id, chars: content.length, pending: !pronto };
  }

  // Indexa em segundo plano; o status do documento e o canal de resultado.
  function runIndex(documentId) {
    if (indexing.has(documentId)) return;
    indexing.add(documentId);
    (async () => {
      try {
        const { chunks } = await indexDocument(db, documentId);
        console.error(`[ai] documento ${documentId} indexado: ${chunks} chunk(s)`);
      } catch (e) {
        const msg = e?.message ?? 'erro ao indexar';
        db.prepare("UPDATE ai_documents SET status = 'error', error_msg = ?, updated_at = ? WHERE id = ?")
          .run(msg, new Date().toISOString(), documentId);
        console.error(`[ai] documento ${documentId} falhou: ${msg}`);
      } finally {
        indexing.delete(documentId);
      }
    })();
  }

  function reindexDocument(id) {
    if (!db.prepare('SELECT id FROM ai_documents WHERE id = ?').get(id)) return { error: 'not_found' };
    if (!hasKey()) return { error: 'configure a chave da OpenAI para indexar' };
    if (indexing.has(id)) return { error: 'este documento ja esta sendo indexado' };
    db.prepare("UPDATE ai_documents SET status = 'indexing', error_msg = NULL WHERE id = ?").run(id);
    runIndex(id);
    return { ok: true };
  }

  function deleteDocument(id) {
    if (!db.prepare('SELECT id FROM ai_documents WHERE id = ?').get(id)) return { error: 'not_found' };
    db.exec('BEGIN;');
    try {
      db.prepare('DELETE FROM ai_chunks WHERE document_id = ?').run(id);
      db.prepare('DELETE FROM ai_documents WHERE id = ?').run(id);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      return { error: e?.message ?? 'erro ao apagar' };
    }
    return { ok: true };
  }

  // --- Vinculos grupo <-> agente (ou triagem) ---

  function parseBinding(body) {
    const jid = String(body?.target_jid ?? '').trim();
    if (!jid.endsWith('@g.us')) return { error: 'selecione um grupo' };

    const mode = body?.mode === 'triage' ? 'triage' : 'agent';
    let agentId = null;
    if (mode === 'agent') {
      agentId = Number(body?.agent_id);
      if (!Number.isInteger(agentId)) return { error: 'selecione o agente' };
      if (!db.prepare('SELECT id FROM ai_agents WHERE id = ?').get(agentId)) {
        return { error: 'agente nao encontrado' };
      }
    } else if (db.prepare('SELECT COUNT(*) n FROM ai_agents WHERE enabled = 1 AND use_in_triage = 1').get().n === 0) {
      // Triagem sem candidato nunca responderia — avisa na hora de salvar em
      // vez de o usuario descobrir pelo silencio no grupo.
      return { error: 'nenhum agente esta marcado para triagem — marque ao menos um' };
    }

    const trigger = ['mention', 'match', 'always'].includes(body?.trigger_mode) ? body.trigger_mode : 'mention';
    let matchType = null;
    let pattern = null;
    if (trigger === 'match') {
      matchType = ['starts_with', 'contains', 'ends_with', 'exact'].includes(body?.match_type)
        ? body.match_type : 'contains';
      pattern = String(body?.pattern ?? '').trim().slice(0, 200);
      if (!pattern) return { error: 'informe o texto do gatilho' };
    }

    const hops = Number(body?.max_hops);
    return {
      target_jid: jid,
      mode,
      agent_id: agentId,
      trigger_mode: trigger,
      match_type: matchType,
      pattern,
      case_sensitive: body?.case_sensitive ? 1 : 0,
      // 0..4 saltos extras: cada salto custa 1 embedding + 1 completion.
      max_hops: Number.isInteger(hops) && hops >= 0 && hops <= 4 ? hops : 2,
      enabled: body?.enabled === false ? 0 : 1,
    };
  }

  const listBindings = () =>
    db
      .prepare(
        `SELECT b.*, a.name AS agent_name, t.name AS group_name
           FROM ai_group_bindings b
           LEFT JOIN ai_agents a ON a.id = b.agent_id
           LEFT JOIN (SELECT jid, name, MAX(last_synced_at) FROM targets GROUP BY jid) t ON t.jid = b.target_jid
          ORDER BY b.id DESC`
      )
      .all()
      .map((b) => ({ ...b, case_sensitive: !!b.case_sensitive, enabled: !!b.enabled }));

  function createBinding(body) {
    const p = parseBinding(body);
    if (p.error) return p;
    const r = db
      .prepare(
        `INSERT INTO ai_group_bindings (target_jid, mode, agent_id, trigger_mode, match_type,
                                        pattern, case_sensitive, max_hops, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(p.target_jid, p.mode, p.agent_id, p.trigger_mode, p.match_type,
           p.pattern, p.case_sensitive, p.max_hops, p.enabled, new Date().toISOString());
    return { id: Number(r.lastInsertRowid) };
  }

  function updateBinding(id, body) {
    if (!db.prepare('SELECT id FROM ai_group_bindings WHERE id = ?').get(id)) return { error: 'not_found' };
    const p = parseBinding(body);
    if (p.error) return p;
    db.prepare(
      `UPDATE ai_group_bindings SET target_jid = ?, mode = ?, agent_id = ?, trigger_mode = ?,
              match_type = ?, pattern = ?, case_sensitive = ?, max_hops = ?, enabled = ? WHERE id = ?`
    ).run(p.target_jid, p.mode, p.agent_id, p.trigger_mode, p.match_type,
          p.pattern, p.case_sensitive, p.max_hops, p.enabled, id);
    return { ok: true };
  }

  function deleteBinding(id) {
    if (!db.prepare('SELECT id FROM ai_group_bindings WHERE id = ?').get(id)) return { error: 'not_found' };
    db.prepare('DELETE FROM ai_group_bindings WHERE id = ?').run(id);
    return { ok: true };
  }

  // Ultimas respostas/decisoes — a tela usa para calibrar limiar e descricoes.
  const listEvents = (limit = 50) =>
    db
      .prepare('SELECT * FROM ai_answer_events ORDER BY id DESC LIMIT ?')
      .all(Math.min(200, Math.max(1, limit)))
      .map((e) => ({ ...e, tried: safeArr(e.tried_json), tried_json: undefined, answered: !!e.answered }));

  // Busca avulsa — a tela usa para o usuario testar o conhecimento sem
  // precisar mandar mensagem num grupo de verdade.
  async function testSearch(agentId, question) {
    const agent = db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(agentId);
    if (!agent) return { error: 'not_found' };
    if (!hasKey()) return { error: 'configure a chave da OpenAI' };
    if (!String(question ?? '').trim()) return { error: 'informe a pergunta' };
    try {
      const hits = await searchByQuestion(db, agentId, question, { k: 6, minSimilarity: 0 });
      return {
        min_similarity: agent.min_similarity,
        hits: hits.map((h) => ({
          document_id: h.document_id,
          score: Number(h.score.toFixed(4)),
          passa: h.score >= agent.min_similarity,
          trecho: h.content.slice(0, 300),
        })),
      };
    } catch (e) {
      return { error: e?.message ?? 'falha na busca' };
    }
  }

  return {
    applyKey, status, validateKey,
    listAgents, getAgent, createAgent, updateAgent, deleteAgent,
    listDocuments, addDocument, reindexDocument, deleteDocument,
    listBindings, createBinding, updateBinding, deleteBinding,
    listEvents, testSearch,
  };
}

function safeArr(s) {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
