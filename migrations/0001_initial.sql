PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
  status TEXT NOT NULL DEFAULT 'revealed',
  ai_codename TEXT,
  created_at INTEGER NOT NULL,
  revealed_at INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER NOT NULL DEFAULT 0,
  truth TEXT NOT NULL CHECK (truth IN ('human', 'ai')),
  archived_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_kind_created ON matches(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS participants (
  match_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  codename TEXT NOT NULL,
  human_probability INTEGER NOT NULL DEFAULT 50,
  correct INTEGER,
  PRIMARY KEY (match_id, session_id),
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_participants_match ON participants(match_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_codename TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'ai', 'admin')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  target_session_ids TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_match_created ON messages(match_id, created_at);

CREATE TABLE IF NOT EXISTS ai_events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  model TEXT NOT NULL,
  persona_codename TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'fallback')),
  error_code TEXT,
  latency_ms INTEGER NOT NULL,
  input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_events_created ON ai_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_events_status_created ON ai_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_events_match ON ai_events(match_id);

CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  content TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_match ON admin_actions(match_id);
