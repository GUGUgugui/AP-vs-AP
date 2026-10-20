ALTER TABLE matches ADD COLUMN end_reason TEXT NOT NULL DEFAULT 'judged';
ALTER TABLE matches ADD COLUMN intervention_count INTEGER NOT NULL DEFAULT 0;
UPDATE matches SET intervention_count=(SELECT COUNT(*) FROM messages WHERE match_id=matches.id AND source='admin');
CREATE TABLE player_seat_owners (
  player_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES player_accounts(id) ON DELETE CASCADE,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX idx_seat_owners_account ON player_seat_owners(account_id);
INSERT OR IGNORE INTO player_seat_owners SELECT 'user:' || id, id, created_at FROM player_accounts;
INSERT OR IGNORE INTO player_seat_owners SELECT player_id, user_id, MIN(created_at) FROM player_sessions WHERE user_id IS NOT NULL GROUP BY player_id, user_id;
CREATE INDEX idx_participants_session ON participants(session_id, match_id);
CREATE TABLE match_feedback (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  tags TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(match_id, player_id)
);
CREATE TABLE player_reports (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved', 'dismissed')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(match_id, reporter_id)
);
CREATE INDEX idx_reports_status_created ON player_reports(status, created_at DESC);
CREATE TABLE player_achievements (
  player_id TEXT NOT NULL,
  code TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY(player_id, code)
);
