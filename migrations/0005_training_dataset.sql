CREATE TABLE training_consents (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  consent INTEGER NOT NULL CHECK(consent IN (0,1)),
  consent_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(match_id,player_id)
);
CREATE TABLE training_samples (
  match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  examples_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX idx_training_status ON training_samples(status,created_at DESC);
