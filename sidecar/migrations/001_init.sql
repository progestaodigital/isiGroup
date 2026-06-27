-- isigroup — schema inicial (Fase 0)
-- Fonte de verdade da fila, regras, logs e estado de sessao/licenca.

PRAGMA foreign_keys = ON;

-- Conta conectada (preparado para N, MVP usa 1)
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  label         TEXT,
  jid           TEXT,
  session_path  TEXT,
  status        TEXT,            -- connected | disconnected | qr_pending
  created_at    TEXT
);

-- Grupos e comunidades onde a conta e admin
CREATE TABLE IF NOT EXISTS targets (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER REFERENCES accounts(id),
  jid            TEXT,
  name           TEXT,
  type           TEXT,           -- group | community_announce | community_subgroup
  is_admin       INTEGER,
  last_synced_at TEXT
);

-- Agendamentos
CREATE TABLE IF NOT EXISTS schedules (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER REFERENCES accounts(id),
  name          TEXT,
  scheduled_at  TEXT,            -- ISO 8601
  payload_type  TEXT,           -- text | audio | video | poll
  content_mode  TEXT,           -- broadcast | per_target
  default_json  TEXT,           -- conteudo padrao (modo broadcast)
  status        TEXT,           -- pending | sent | partial | failed | canceled
  created_at    TEXT
);

-- Alvo de cada agendamento, com override opcional de mensagem
CREATE TABLE IF NOT EXISTS schedule_targets (
  id           INTEGER PRIMARY KEY,
  schedule_id  INTEGER REFERENCES schedules(id),
  target_id    INTEGER REFERENCES targets(id),
  message_json TEXT,            -- nulo = usa default_json do schedule
  status       TEXT,            -- pending | sent | failed
  sent_at      TEXT,
  error        TEXT
);

-- Midia anexada a um agendamento
CREATE TABLE IF NOT EXISTS media_assets (
  id               INTEGER PRIMARY KEY,
  schedule_id      INTEGER REFERENCES schedules(id),
  path             TEXT,
  mimetype         TEXT,
  kind             TEXT,        -- audio | video
  duration_seconds INTEGER,
  waveform_json    TEXT         -- usado no audio PTT
);

-- Regras de automacao
CREATE TABLE IF NOT EXISTS automation_rules (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER REFERENCES accounts(id),
  name           TEXT,
  enabled        INTEGER,
  match_type     TEXT,          -- starts_with | contains | ends_with | exact
  pattern        TEXT,
  case_sensitive INTEGER,
  scope_json     TEXT           -- alvos onde a regra vale
);

CREATE TABLE IF NOT EXISTS automation_actions (
  id          INTEGER PRIMARY KEY,
  rule_id     INTEGER REFERENCES automation_rules(id),
  action_type TEXT,             -- reply | remove | webhook
  config_json TEXT,             -- texto da resposta, id do webhook, etc.
  order_index INTEGER
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id            INTEGER PRIMARY KEY,
  rule_id       INTEGER REFERENCES automation_rules(id),
  target_jid    TEXT,
  sender_e164   TEXT,
  matched_text  TEXT,
  actions_taken TEXT,
  created_at    TEXT
);

-- Eventos de entrada e saida
CREATE TABLE IF NOT EXISTS membership_events (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER REFERENCES accounts(id),
  target_jid       TEXT,
  member_e164      TEXT,
  event_type       TEXT,        -- join | leave
  occurred_at      TEXT,
  webhook_status   TEXT         -- pending | delivered | failed
);

-- Webhooks configuraveis
CREATE TABLE IF NOT EXISTS webhooks (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts(id),
  name        TEXT,
  url         TEXT,
  secret      TEXT,             -- usado para assinar HMAC
  events_json TEXT,             -- join | leave | automation_match
  enabled     INTEGER
);

-- Estado local de licenca (cache do boot ping; chave NUNCA fica aqui — vive no keyring do OS)
CREATE TABLE IF NOT EXISTS license_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  status            TEXT,        -- valid | invalid | hwid_mismatch | expired | blocked | unknown
  expires_at        TEXT,
  grace_until       TEXT,
  subscription_url  TEXT,
  support_url       TEXT,
  last_validated_at TEXT
);
