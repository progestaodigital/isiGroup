-- Fase 3+: passos de sequencia multi-formato (texto/imagem/audio/video/enquete).
-- Cada passo passa a ser autossuficiente: tem seu proprio tipo, corpo e midia.
ALTER TABLE schedule_steps ADD COLUMN payload_type           TEXT;   -- text|image|audio|video|poll
ALTER TABLE schedule_steps ADD COLUMN body_json              TEXT;   -- {text} | {caption} | {poll}
ALTER TABLE schedule_steps ADD COLUMN media_path             TEXT;
ALTER TABLE schedule_steps ADD COLUMN media_mimetype         TEXT;
ALTER TABLE schedule_steps ADD COLUMN media_kind             TEXT;
ALTER TABLE schedule_steps ADD COLUMN media_duration_seconds INTEGER;
ALTER TABLE schedule_steps ADD COLUMN media_waveform_json    TEXT;
