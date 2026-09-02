ALTER TABLE seller_users
  ADD COLUMN session_token_hash TEXT CHECK (session_token_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN session_expires_at TIMESTAMPTZ,
  ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until TIMESTAMPTZ;
