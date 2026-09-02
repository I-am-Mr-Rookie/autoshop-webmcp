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
        'INSERT INTO seller_users (id, username, password_hash, status, version) VALUES ($1, $2, $3, $4, $5)',
        [seller.id, seller.username, seller.passwordHash, seller.status, seller.version]
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
    const { rows: [session] } = await db.pool.query('SELECT id, mode, expires_at FROM buyer_sessions WHERE id = $1', [id]);
    return session ?? null;
  },

  async findSeller(username) {
    const { rows: [seller] } = await db.pool.query(`
      SELECT id, username, password_hash, status, failed_login_count, locked_until
      FROM seller_users WHERE username = $1
    `, [username]);
    return seller ?? null;
  },

  async recordSellerLoginFailure(id, now, limit, lockedUntil) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [seller] } = await client.query(
        'SELECT failed_login_count, locked_until FROM seller_users WHERE id = $1 FOR UPDATE', [id]
      );
      if (!seller) {
        await client.query('ROLLBACK');
        return null;
      }
      const count = seller.locked_until && new Date(seller.locked_until) <= now ? 1 : seller.failed_login_count + 1;
      const nextLock = count >= limit ? lockedUntil : null;
      const { rows: [result] } = await client.query(`
        UPDATE seller_users SET failed_login_count = $2, locked_until = $3, version = version + 1
        WHERE id = $1 RETURNING locked_until
      `, [id, count, nextLock]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async createSellerSession(id, tokenHash, expiresAt) {
    await db.pool.query(`
      UPDATE seller_users SET session_token_hash = $2, session_expires_at = $3,
        failed_login_count = 0, locked_until = NULL, version = version + 1
      WHERE id = $1 AND status = 'active'
    `, [id, tokenHash, expiresAt]);
  },

  async findSellerSession(tokenHash, now) {
    const { rows: [seller] } = await db.pool.query(`
      SELECT username, session_expires_at AS expires_at FROM seller_users
      WHERE session_token_hash = $1 AND session_expires_at > $2 AND status = 'active'
    `, [tokenHash, now]);
    return seller ?? null;
  },

  async deleteSellerSession(tokenHash) {
    await db.pool.query(`
      UPDATE seller_users SET session_token_hash = NULL, session_expires_at = NULL, version = version + 1
      WHERE session_token_hash = $1
    `, [tokenHash]);
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
      const { rows: [cart] } = await client.query("SELECT items FROM carts WHERE buyer_session_id = $1 AND status = 'open' FOR UPDATE", [sessionId]);
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
      await client.query(`
        UPDATE buyer_sessions SET confirmed_order_id = NULL, confirm_token_hash = NULL,
          confirm_cart_version = NULL, confirm_expires_at = NULL, version = version + 1
        WHERE id = $1
      `, [sessionId]);
      const result = await cartResult(client, sessionId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async confirmBuyer(sessionId, now, { mode, buyerName, buyerEmail, buyerCountry, orderId, tokenHash, expiresAt, reviewedCartVersion }) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [session] } = await client.query(
        'SELECT id FROM buyer_sessions WHERE id = $1 AND expires_at > $2 FOR UPDATE',
        [sessionId, now]
      );
      const { rows: [cart] } = await client.query(
        "SELECT items, version FROM carts WHERE buyer_session_id = $1 AND status = 'open' FOR UPDATE",
        [sessionId]
      );
      if (!session) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }
      if (!cart?.items?.length) {
        await client.query('ROLLBACK');
        return { error: 'EMPTY_CART' };
      }
      if (cart.version !== reviewedCartVersion) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }
      await client.query(`
        UPDATE buyer_sessions SET mode = $2, buyer_name = $3, buyer_email = $4,
          buyer_country = $5, confirmed_order_id = $6, confirm_token_hash = $7,
          confirm_cart_version = $8, confirm_expires_at = $9, version = version + 1
        WHERE id = $1
      `, [sessionId, mode, buyerName, buyerEmail, buyerCountry, orderId, tokenHash, cart.version, expiresAt]);
      await client.query('COMMIT');
      return { mode, cart_version: cart.version, expires_at: expiresAt.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async getOrder(sessionId, orderId) {
    const { rows: [order] } = await db.pool.query(`
      SELECT id AS order_id, status, total_cents, version, created_at
      FROM orders WHERE id = $1 AND buyer_session_id = $2
    `, [orderId, sessionId]);
    return order ?? null;
  },

  async submitOrder(sessionId, now, orderId, tokenHash) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [session] } = await client.query(`
        SELECT confirmed_order_id, confirm_token_hash, confirm_cart_version, confirm_expires_at
        FROM buyer_sessions WHERE id = $1 AND expires_at > $2 FOR UPDATE
      `, [sessionId, now]);
      if (!session) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }

      const { rows: [existing] } = await client.query(`
        SELECT id AS order_id, buyer_session_id, status, total_cents, version, created_at
        FROM orders WHERE id = $1
      `, [orderId]);
      if (existing) {
        if (existing.buyer_session_id !== sessionId) {
          await client.query('ROLLBACK');
          return { error: 'FORBIDDEN' };
        }
        await client.query('COMMIT');
        const { buyer_session_id, ...order } = existing;
        return { order, replayed: true };
      }

      if (session.confirmed_order_id !== orderId || session.confirm_token_hash !== tokenHash) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }
      if (new Date(session.confirm_expires_at) <= now) {
        await client.query('ROLLBACK');
        return { error: 'EXPIRED' };
      }

      const { rows: [cart] } = await client.query(
        "SELECT items, version FROM carts WHERE buyer_session_id = $1 AND status = 'open' FOR UPDATE",
        [sessionId]
      );
      if (!cart?.items?.length || cart.version !== session.confirm_cart_version) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }
      const snapshot = await cartResult(client, sessionId);
      const { rows: [order] } = await client.query(`
        INSERT INTO orders (id, buyer_session_id, items, total_cents, status, version)
        VALUES ($1, $2, $3::jsonb, $4, 'requested', 1)
        RETURNING id AS order_id, status, total_cents, version, created_at
      `, [orderId, sessionId, JSON.stringify(snapshot.items), snapshot.total_cents]);
      await client.query(`
        UPDATE buyer_sessions SET confirmed_order_id = NULL, confirm_token_hash = NULL,
          confirm_cart_version = NULL, confirm_expires_at = NULL, version = version + 1
        WHERE id = $1
      `, [sessionId]);
      await client.query("UPDATE carts SET status = 'submitted', version = version + 1 WHERE buyer_session_id = $1", [sessionId]);
      await client.query('COMMIT');
      return { order, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});
