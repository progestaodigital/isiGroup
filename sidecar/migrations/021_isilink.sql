-- Redirecionamento isiLink: o isiGroup avisa o isiLink (webhook isiGroup)
-- quando um grupo lota ou reabre, e o link curto manda os cliques para o
-- proximo grupo ativo da fila.

-- Dados do grupo que independem do chip: o tamanho e o link de convite sao os
-- mesmos para qualquer chip membro. Fica fora de `targets` porque a sync de
-- alvos e autoritativa por chip (poda linhas) e porque `targets` tem uma linha
-- por (chip, grupo) — a contagem duplicada sairia dessincronizada.
CREATE TABLE IF NOT EXISTS group_info (
  jid           TEXT PRIMARY KEY,
  member_count  INTEGER,         -- todos os participantes (inclui admins e o proprio chip)
  invite_code   TEXT,            -- codigo de https://chat.whatsapp.com/<codigo> (exige admin)
  count_at      TEXT,
  invite_at     TEXT
);

-- Um link do isiLink (metodo isiGroup) e a regra de lotacao dele.
CREATE TABLE IF NOT EXISTS isilink_links (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  webhook_url   TEXT NOT NULL,   -- https://isilink.com.br/api/webhooks/isigroup/<token>
  secret        TEXT,            -- opcional, vai no header x-webhook-secret
  max_members   INTEGER NOT NULL, -- chegou aqui: "ativo": "nao"
  reopen_at     INTEGER NOT NULL, -- caiu para isto ou menos: "ativo": "sim"
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT
);

-- Grupos do link, na ordem da fila. last_status = ultimo status ACEITO pelo
-- isiLink ('sim' | 'nao' | NULL = nunca enviado); invite_url = URL enviada
-- (detecta convite redefinido no WhatsApp).
CREATE TABLE IF NOT EXISTS isilink_groups (
  id            INTEGER PRIMARY KEY,
  link_id       INTEGER NOT NULL REFERENCES isilink_links(id) ON DELETE CASCADE,
  jid           TEXT NOT NULL,
  order_index   INTEGER NOT NULL,
  invite_url    TEXT,
  last_status   TEXT,
  last_result   TEXT,            -- activated | deactivated | added | unchanged | ignored | erro
  last_error    TEXT,
  last_sent_at  TEXT,
  UNIQUE (link_id, jid)
);

-- Auditoria das chamadas ao isiLink (a tela mostra as ultimas).
CREATE TABLE IF NOT EXISTS isilink_events (
  id            INTEGER PRIMARY KEY,
  link_id       INTEGER NOT NULL REFERENCES isilink_links(id) ON DELETE CASCADE,
  jid           TEXT,
  invite_url    TEXT,
  ativo         TEXT,            -- sim | nao
  member_count  INTEGER,
  http_status   INTEGER,
  result        TEXT,
  error         TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_isilink_events_link ON isilink_events (link_id, id);
