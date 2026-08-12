-- Acoes em massa (bulk): operacoes de risco aplicadas a varios grupos/contatos.
-- Um "job" agrupa uma operacao (ex: adicionar membros) e seus "itens" (um por
-- par grupo+contato nas acoes de membro, ou um por grupo nas acoes de grupo).
-- O worker processa os itens pendentes com espacamento (anti-flood) e e
-- resumivel: se o app cair, os jobs 'running' retomam pelos itens 'pending'.

CREATE TABLE bulk_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  op            TEXT NOT NULL,                    -- add_members|remove_members|promote|demote|set_name|set_description|set_picture|set_settings
  status        TEXT NOT NULL DEFAULT 'running',  -- running | done | canceled
  params_json   TEXT,                             -- payload da operacao (nome/descricao/foto/config + ritmo)
  total         INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE bulk_job_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES bulk_jobs(id) ON DELETE CASCADE,
  group_jid     TEXT NOT NULL,
  group_name    TEXT,
  contact       TEXT,                             -- telefone (acoes de membro) | NULL (acoes de grupo)
  account_id    INTEGER,                          -- chip admin que executou (resolvido no disparo)
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | ok | failed | skipped
  detail        TEXT,                             -- mensagem de resultado/erro
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_bulk_items_job ON bulk_job_items(job_id);
CREATE INDEX idx_bulk_items_pending ON bulk_job_items(job_id, status);
