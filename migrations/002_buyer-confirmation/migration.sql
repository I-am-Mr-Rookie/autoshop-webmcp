ALTER TABLE buyer_sessions
  ADD COLUMN confirmed_order_id TEXT,
  ADD COLUMN confirm_token_hash TEXT,
  ADD COLUMN confirm_cart_version INTEGER CHECK (confirm_cart_version > 0),
  ADD COLUMN confirm_expires_at TIMESTAMPTZ;
