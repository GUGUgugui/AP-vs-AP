CREATE TABLE IF NOT EXISTS human_style_samples (
  match_id TEXT PRIMARY KEY,
  sample_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  total_chars INTEGER NOT NULL,
  short_count INTEGER NOT NULL,
  question_count INTEGER NOT NULL,
  reply_delay_count INTEGER NOT NULL,
  total_reply_delay_ms INTEGER NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_style_samples_created ON human_style_samples(created_at DESC);

CREATE TABLE IF NOT EXISTS deleted_match_ids (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deleted_match_ids_deleted_at ON deleted_match_ids(deleted_at);
