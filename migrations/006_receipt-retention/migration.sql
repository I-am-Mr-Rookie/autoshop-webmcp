ALTER TABLE receipts DROP CONSTRAINT receipts_order_id_fkey;

ALTER TABLE receipts ADD CONSTRAINT receipts_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
