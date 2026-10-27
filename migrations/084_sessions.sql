CREATE TABLE IF NOT EXISTS sessions (
  sid text PRIMARY KEY,
  sess text NOT NULL,
  expire text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire);
