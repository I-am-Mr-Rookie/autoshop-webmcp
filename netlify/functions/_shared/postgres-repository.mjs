const cartResult = async (client, sessionId) => {
  const { rows: [cart] } = await client.query(`
    SELECT c.items, c.version, COALESCE((
      SELECT SUM((item->>'quantity')::integer * p.price_cents)
      FROM jsonb_array_elements(c.items) item
      JOIN products p ON p.id = item->>'product_id'
    ), 0)::integer AS total_cents
    FROM carts c WHERE c.buyer_session_id = $1
  `, [sessionId]);
  return cart ?? null;
};

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
  },

  async createBuyerSession(id, expiresAt) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO buyer_sessions (id, expires_at, version) VALUES ($1, $2, 1)', [id, expiresAt]);
      await client.query('INSERT INTO carts (id, buyer_session_id, version) VALUES ($1, $1, 1)', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async findBuyerSession(id, now) {
    await db.pool.query('DELETE FROM buyer_sessions WHERE id = $1 AND expires_at <= $2', [id, now]);
    const { rows: [session] } = await db.pool.query('SELECT id, expires_at FROM buyer_sessions WHERE id = $1', [id]);
    return session ?? null;
  },

  async listProducts(query, limit) {
    const { rows } = await db.pool.query(`
      SELECT id, name, price_cents, stock FROM products
      WHERE name ILIKE $1 ORDER BY id LIMIT $2
    `, [`%${query}%`, limit]);
    return rows;
  },

  async getCart(sessionId) {
    return cartResult(db.pool, sessionId);
  },

  async mutateCart(sessionId, now, { action, productId, quantity }) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [session] } = await client.query(
        'SELECT id FROM buyer_sessions WHERE id = $1 AND expires_at > $2 FOR UPDATE',
        [sessionId, now]
      );
      const { rows: [product] } = await client.query('SELECT id FROM products WHERE id = $1', [productId]);
      const { rows: [cart] } = await client.query('SELECT items FROM carts WHERE buyer_session_id = $1 FOR UPDATE', [sessionId]);
      if (!session || !product || !cart) {
        await client.query('ROLLBACK');
        return null;
      }

      const items = cart.items;
      const index = items.findIndex(item => item.product_id === productId);
      const nextQuantity = action === 'add' && index >= 0 ? items[index].quantity + quantity : quantity;
      if (action !== 'remove' && nextQuantity > 20) {
        await client.query('ROLLBACK');
        return { error: 'QUANTITY' };
      }
      if (action === 'remove' && index >= 0) items.splice(index, 1);
      else if (action !== 'remove' && index >= 0) items[index].quantity = nextQuantity;
      else if (action !== 'remove') items.push({ product_id: productId, quantity });

      await client.query('UPDATE carts SET items = $2::jsonb, version = version + 1 WHERE buyer_session_id = $1', [sessionId, JSON.stringify(items)]);
      const result = await cartResult(client, sessionId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});
