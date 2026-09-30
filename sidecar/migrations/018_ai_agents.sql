-- Agentes de IA com base de conhecimento (RAG) e triagem.
--
-- Espelha o modelo do isiFlow (ai_agents + knowledge_documents/chunks +
-- triage_events), com UMA diferenca forcada pela arquitetura: la o vetor vive
-- em pgvector com indice HNSW; aqui o SQLite e o node:sqlite (sem extensao
-- nativa, por decisao de projeto), entao o embedding fica como BLOB e a busca
-- por cosseno roda em JS. Rapido ate ~20 mil chunks; acima disso precisaria
-- de indice aproximado.
--
-- A chave da OpenAI NAO fica aqui: vive no keyring do SO (como a license_key)
-- e chega ao sidecar em memoria via POST /ai/key.

CREATE TABLE ai_agents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',   -- sinal de roteamento lido pela triagem
  system_prompt  TEXT    NOT NULL DEFAULT '',   -- persona + regras
  model          TEXT    NOT NULL DEFAULT 'gpt-4o-mini',
  keywords_json  TEXT    NOT NULL DEFAULT '[]', -- atalho deterministico (casou => pula o LLM)
  min_similarity REAL    NOT NULL DEFAULT 0.3,  -- corte do cosseno (text-embedding-3-small fica ~0.2-0.6)
  use_in_triage  INTEGER NOT NULL DEFAULT 0,    -- entra no sorteio da triagem?
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT
);

-- Fonte bruta enviada pelo usuario (texto colado, arquivo ou url).
CREATE TABLE ai_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL DEFAULT '',
  source       TEXT    NOT NULL DEFAULT 'text', -- text | file | url
  source_ref   TEXT,                            -- caminho do arquivo ou URL de origem
  content      TEXT    NOT NULL DEFAULT '',     -- texto ja extraido
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | indexing | ready | error
  error_msg    TEXT,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT
);
CREATE INDEX idx_ai_documents_agent ON ai_documents(agent_id);

-- Pedacos vetorizados: o que a busca consulta.
CREATE TABLE ai_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES ai_documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,        -- ordem dentro do documento
  content     TEXT    NOT NULL,
  embedding   BLOB,                    -- Float32Array (dims * 4 bytes); NULL = ainda nao indexado
  dims        INTEGER,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_ai_chunks_agent ON ai_chunks(agent_id);
CREATE INDEX idx_ai_chunks_doc   ON ai_chunks(document_id);

-- Vinculo grupo <-> agente (ou triagem). Um grupo pode ter mais de um vinculo
-- (ex.: um agente por gatilho diferente), mas so um deles responde por mensagem.
CREATE TABLE ai_group_bindings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_jid     TEXT    NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'agent',   -- agent (fixo) | triage (escolhe)
  agent_id       INTEGER REFERENCES ai_agents(id) ON DELETE CASCADE, -- NULL quando mode='triage'
  trigger_mode   TEXT    NOT NULL DEFAULT 'mention', -- mention | match | always
  match_type     TEXT,                               -- starts_with|contains|ends_with|exact (trigger_mode='match')
  pattern        TEXT,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  max_hops       INTEGER NOT NULL DEFAULT 2,         -- teto do boomerang da triagem
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);
CREATE INDEX idx_ai_bindings_jid ON ai_group_bindings(target_jid);

-- Log de cada decisao/resposta. Essencial para calibrar limiar e descricoes.
CREATE TABLE ai_answer_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_jid      TEXT,
  account_id      INTEGER,
  binding_id      INTEGER,
  question        TEXT,
  chosen_agent_id INTEGER,
  route           TEXT,      -- keyword | llm | fixed  (como a triagem escolheu)
  tried_json      TEXT,      -- agentes tentados no boomerang, em ordem
  hops            INTEGER NOT NULL DEFAULT 0,
  answered        INTEGER NOT NULL DEFAULT 0,
  top_similarity  REAL,
  error           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_ai_events_jid ON ai_answer_events(target_jid);
