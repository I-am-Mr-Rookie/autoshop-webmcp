ALTER TABLE orders DROP CONSTRAINT orders_buyer_session_id_fkey;

ALTER TABLE orders ADD CONSTRAINT orders_buyer_session_id_fkey
  FOREIGN KEY (buyer_session_id) REFERENCES buyer_sessions(id) ON DELETE CASCADE;
