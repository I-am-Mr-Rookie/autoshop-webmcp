export const createPostgresRepository = db => ({
  async replace(records) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE approval_tokens, receipts, pending_actions, orders, carts, buyer_sessions, mandates, seller_users, products CASCADE');
      for (const product of records.products) await client.query(
        'INSERT INTO products (id, name, price_cents, stock, version) VALUES ($1, $2, $3, $4, $5)',
        [product.id, product.name, product.priceCents, product.stock, product.version]
      );
      const mandate = records.mandates[0];
      await client.query(
        'INSERT INTO mandates (id, max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [mandate.id, mandate.maxItems, mandate.maxTotalCents, mandate.maxDiscountPercent, mandate.minRemainingStock, mandate.state, mandate.version]
      );
      const seller = records.sellerUsers[0];
      await client.query(
        'INSERT INTO seller_users (id, username, status, version) VALUES ($1, $2, $3, $4)',
        [seller.id, seller.username, seller.status, seller.version]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});
