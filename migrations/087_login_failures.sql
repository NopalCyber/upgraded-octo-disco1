CREATE TABLE IF NOT EXISTS login_failures (
  email text PRIMARY KEY,
  failures integer NOT NULL,
  window_ends_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures_window_ends_at ON login_failures (window_ends_at);
