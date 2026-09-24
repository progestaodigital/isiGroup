-- Planos de acao (isiplan) + integracao com IA (MCP).
--
-- plan_runs/plan_steps: execucao de um plano importado (ou aplicado via MCP).
-- O executor e um worker persistente no padrao do bulk/scheduler: fonte de
-- verdade no SQLite, retomavel apos queda, passos em ordem com dependencias
-- ("ref" de grupos criados por passos anteriores).
--
-- app_settings: chave/valor simples (flag da integracao MCP, etc.).
-- pending_approvals: acoes de risco pedidas por IA aguardando o usuario
-- aprovar no app (expiram). integration_log: trilha de auditoria.

CREATE TABLE plan_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_hash    TEXT NOT NULL,                    -- sha256 do plan.json (guarda de reimportacao)
  plan_id      TEXT,                             -- id declarado no plano (opcional)
  name         TEXT,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | done | failed | canceled
  source       TEXT NOT NULL DEFAULT 'import',   -- import | mcp
  plan_json    TEXT NOT NULL,                    -- plano normalizado (como foi executado)
  report_json  TEXT,                             -- resumo final por passo
  total_steps  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE plan_steps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES plan_runs(id) ON DELETE CASCADE,
  order_index       INTEGER NOT NULL,
  action_id         TEXT,                            -- id simbolico (para "ref")
  action_type       TEXT NOT NULL,
  params_json       TEXT NOT NULL,                   -- params normalizados (midia ja staged)
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | running | waiting | done | failed | skipped
  waits_bulk_job_id INTEGER,                         -- job bulk aguardado (create/members/edit)
  result_json       TEXT,                            -- ex.: { groups: [{jid,name}], schedule_id, rule_id }
  detail            TEXT,
  finished_at       TEXT
);
CREATE INDEX idx_plan_steps_run ON plan_steps(run_id, order_index);

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE pending_approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL DEFAULT 'mcp',
  tool         TEXT NOT NULL,
  summary      TEXT NOT NULL,                    -- resumo humano exibido no app
  payload_json TEXT NOT NULL,                    -- { method, path, body } executado ao aprovar
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | expired
  result_json  TEXT,                             -- resultado da execucao (aprovado)
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);

CREATE TABLE integration_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,                     -- mcp | plan
  tool        TEXT NOT NULL,
  summary     TEXT,
  approval_id INTEGER,
  result      TEXT,                              -- ok | denied | expired | error: <msg>
  created_at  TEXT NOT NULL
);
