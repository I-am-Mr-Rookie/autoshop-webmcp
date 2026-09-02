CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE buyer_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'Ask' CHECK (mode IN ('Ask', 'Auto')),
  expires_at TIMESTAMPTZ NOT NULL,
  buyer_name TEXT,
  buyer_email TEXT,
  buyer_country TEXT,
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  buyer_session_id TEXT NOT NULL REFERENCES buyer_sessions(id) ON DELETE CASCADE,
  items JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  buyer_session_id TEXT NOT NULL REFERENCES buyer_sessions(id),
  items JSONB NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('requested', 'pending', 'eligible', 'accepted', 'cancelled', 'rejected')),
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE mandates (
  id TEXT PRIMARY KEY,
  max_items INTEGER NOT NULL CHECK (max_items > 0),
  max_total_cents INTEGER NOT NULL CHECK (max_total_cents >= 0),
  max_discount_percent INTEGER NOT NULL CHECK (max_discount_percent BETWEEN 0 AND 100),
  min_remaining_stock INTEGER NOT NULL CHECK (min_remaining_stock >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded')),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  mandate_version INTEGER NOT NULL CHECK (mandate_version > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  snapshot JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'eligible', 'approved', 'committed', 'replaced')),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE approval_tokens (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES pending_actions(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'expired', 'invalidated')),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  body JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE TABLE seller_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL CHECK (version > 0)
);
