ALTER TABLE pending_actions ADD COLUMN idempotency_key TEXT UNIQUE;
ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_order_id_fkey;
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
