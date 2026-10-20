CREATE TABLE IF NOT EXISTS player_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Only token digests are stored. Anonymous game IDs never come from the browser.
CREATE TABLE IF NOT EXISTS player_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES player_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_expiry ON player_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_player_sessions_user ON player_sessions(user_id);

CREATE TABLE IF NOT EXISTS player_auth_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_auth_limits_reset ON player_auth_limits(reset_at);
