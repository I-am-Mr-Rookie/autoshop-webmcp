CREATE TABLE seller_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  seller_id TEXT NOT NULL REFERENCES seller_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO seller_sessions (token_hash, seller_id, expires_at)
SELECT session_token_hash, id, session_expires_at
FROM seller_users
WHERE session_token_hash IS NOT NULL AND session_expires_at IS NOT NULL;

CREATE INDEX seller_sessions_expires_at_idx ON seller_sessions (expires_at);
