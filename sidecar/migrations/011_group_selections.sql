-- Selecoes de grupos salvas pelo usuario (picker do agendador).
-- Guarda os JIDs (chave natural do grupo) — sobrevive a re-sync e multi-chip.

CREATE TABLE group_selections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  jids_json   TEXT NOT NULL,            -- JSON array de JIDs de grupo
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
