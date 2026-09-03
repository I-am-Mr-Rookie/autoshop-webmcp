import { randomUUID } from 'node:crypto';

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

const mandateResult = row => row && ({
  mandate_version: row.version,
  currency: 'USD',
  max_items_per_order: row.max_items,
  max_total_cents: row.max_total_cents,
  max_discount_percent: row.max_discount_percent,
  min_stock_remaining: row.min_remaining_stock,
  status: row.state
});

const receiptResult = row => row && ({
  ...row.body,
  issued_at: new Date(row.issued_at).toISOString(),
  version: row.version
});

export const isOrderEligible = (order, products, mandate) => {
  if (!Array.isArray(order.items) || !order.items.length) return false;
  const productById = new Map(products.map(product => [product.id, product]));
  const quantities = new Map();
  for (const item of order.items) {
    if (!item || Array.isArray(item) || typeof item !== 'object'
      || Object.keys(item).sort().join(',') !== 'product_id,quantity'
      || typeof item.product_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.product_id)
      || !Number.isInteger(item.quantity) || item.quantity <= 0) return false;
    quantities.set(item.product_id, (quantities.get(item.product_id) ?? 0) + item.quantity);
  }
  const quantity = [...quantities.values()].reduce((total, value) => total + value, 0);
  return quantity === order.quantity
    && quantity <= mandate.max_items_per_order
    && order.total_cents <= mandate.max_total_cents
    && order.discount_percent <= mandate.max_discount_percent
    && [...quantities].every(([productId, requested]) => productById.has(productId)
      && productById.get(productId).stock - requested >= mandate.min_stock_remaining);
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

  async getMandate() {
    const { rows: [mandate] } = await db.pool.query(`
      SELECT max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version
      FROM mandates WHERE state = 'active' ORDER BY version DESC LIMIT 1
    `);
    return mandateResult(mandate);
  },

  async listSellerOrders(tokenHash, now, limit) {
    const { rows } = await db.pool.query(`
      SELECT o.id AS order_id, o.items, o.total_cents, o.discount_percent, o.status,
        o.version, o.created_at, pa.id AS action_id, pa.quantity AS action_quantity,
        pa.state AS action_state, pa.version AS action_version,
        r.body AS receipt_body, r.issued_at, r.version AS receipt_version
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT id, quantity, state, version FROM pending_actions
        WHERE order_id = o.id ORDER BY version DESC LIMIT 1
      ) pa ON true
      LEFT JOIN receipts r ON r.order_id = o.id
      WHERE EXISTS (
        SELECT 1 FROM seller_users
        WHERE session_token_hash = $1 AND session_expires_at > $2 AND status = 'active'
      )
      ORDER BY o.created_at DESC, o.id DESC LIMIT $3
    `, [tokenHash, now, limit]);
    return rows.map(row => ({
      order_id: row.order_id,
      items: row.items,
      quantity: row.items.reduce((total, item) => total + item.quantity, 0),
      total_cents: row.total_cents,
      discount_percent: row.discount_percent,
      status: row.status,
      version: row.version,
      created_at: new Date(row.created_at).toISOString(),
      pending_action: row.action_id ? {
        action_id: row.action_id, quantity: row.action_quantity, state: row.action_state, version: row.action_version
      } : null,
      receipt: row.receipt_body ? receiptResult({ body: row.receipt_body, issued_at: row.issued_at, version: row.receipt_version }) : null
    }));
  },

  async updateMandate(expectedVersion, limits, tokenHash, now) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [seller] } = await client.query(`
        SELECT id FROM seller_users
        WHERE session_token_hash = $1 AND session_expires_at > $2 AND status = 'active'
        FOR UPDATE
      `, [tokenHash, now]);
      if (!seller) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }

      const { rows: [current] } = await client.query(`
        SELECT id, max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version
        FROM mandates WHERE state = 'active' ORDER BY version DESC LIMIT 1 FOR UPDATE
      `);
      if (!current) {
        await client.query('ROLLBACK');
        return { error: 'UNAVAILABLE' };
      }
      if (current.version !== expectedVersion) {
        await client.query('ROLLBACK');
        return { error: 'STALE', mandate: mandateResult(current) };
      }

      await client.query("UPDATE mandates SET state = 'superseded' WHERE id = $1", [current.id]);
      const { rows: [saved] } = await client.query(`
        INSERT INTO mandates (id, max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
        RETURNING max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version
      `, [`mandate-${current.version + 1}`, limits.max_items_per_order, limits.max_total_cents,
        limits.max_discount_percent, limits.min_stock_remaining, current.version + 1]);
      const mandate = mandateResult(saved);
      const { rows: actions } = await client.query(`
        SELECT pa.id, pa.order_id, pa.quantity, pa.version AS action_version,
          o.items, o.total_cents, o.discount_percent, o.status, o.version AS order_version
        FROM pending_actions pa JOIN orders o ON o.id = pa.order_id
        WHERE pa.state IN ('pending', 'eligible', 'approved') AND o.status IN ('pending', 'eligible')
        ORDER BY pa.order_id, pa.id FOR UPDATE OF pa, o
      `);
      const productIds = [...new Set(actions.flatMap(action => action.items.map(item => item.product_id)))].sort();
      const { rows: products } = productIds.length ? await client.query(`
        SELECT id, stock, version FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
      `, [productIds]) : { rows: [] };

      let eligible = 0;
      for (const action of actions) {
        const permitted = isOrderEligible(action, products, mandate);
        const state = permitted ? 'eligible' : 'pending';
        eligible += Number(permitted);
        await client.query("UPDATE pending_actions SET state = 'replaced', version = version + 1 WHERE id = $1", [action.id]);
        await client.query("UPDATE approval_tokens SET state = 'invalidated', version = version + 1 WHERE action_id = $1 AND state = 'active'", [action.id]);
        const { rows: [order] } = action.status === state ? { rows: [{ version: action.order_version }] } : await client.query(
          'UPDATE orders SET status = $2, version = version + 1 WHERE id = $1 RETURNING version', [action.order_id, state]
        );
        const snapshot = {
          mandate_version: mandate.mandate_version,
          order_version: order.version,
          items: action.items,
          products: products.filter(product => action.items.some(item => item.product_id === product.id))
        };
        await client.query(`
          INSERT INTO pending_actions (id, order_id, mandate_version, quantity, snapshot, state, version)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1)
        `, [`pending-${randomUUID()}`, action.order_id, mandate.mandate_version, action.quantity, JSON.stringify(snapshot), state]);
      }
      await client.query('COMMIT');
      return { mandate, re_evaluated: actions.length, eligible };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
      SELECT o.id AS order_id, o.status, o.total_cents, o.version, o.created_at,
        r.body AS receipt_body, r.issued_at, r.version AS receipt_version
      FROM orders o LEFT JOIN receipts r ON r.order_id = o.id
      WHERE o.buyer_session_id = $1 AND ($2::text IS NULL OR o.id = $2)
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1
    `, [sessionId, orderId ?? null]);
    return order ? {
      order_id: order.order_id,
      status: order.status,
      total_cents: order.total_cents,
      version: order.version,
      created_at: new Date(order.created_at).toISOString(),
      receipt: order.receipt_body
        ? receiptResult({ body: order.receipt_body, issued_at: order.issued_at, version: order.receipt_version })
        : null
    } : null;
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
  },

  async approveAction(actionId, approvalTokenHash, expiresAt, sellerTokenHash, now) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // ponytail: the single demo seller row serializes approvals; use advisory locks if seller throughput grows.
      const { rows: [seller] } = await client.query(`
        SELECT id FROM seller_users
        WHERE session_token_hash = $1 AND session_expires_at > $2 AND status = 'active'
        FOR UPDATE
      `, [sellerTokenHash, now]);
      if (!seller) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }

      const { rows: [action] } = await client.query(`
        SELECT pa.id AS action_id, pa.order_id, pa.mandate_version, pa.quantity, pa.snapshot,
          pa.state, o.items, o.total_cents, o.discount_percent,
          o.status AS order_status, o.version AS order_version
        FROM pending_actions pa JOIN orders o ON o.id = pa.order_id
        WHERE pa.id = $1 FOR UPDATE OF pa, o
      `, [actionId]);
      if (!action) {
        await client.query('ROLLBACK');
        return { error: 'NOT_FOUND' };
      }
      if (!['pending', 'approved'].includes(action.state) || action.order_status !== 'pending') {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }

      const { rows: [mandateRow] } = await client.query(`
        SELECT max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version
        FROM mandates WHERE state = 'active' ORDER BY version DESC LIMIT 1 FOR UPDATE
      `);
      const quantities = new Map();
      for (const item of action.items) quantities.set(item.product_id, (quantities.get(item.product_id) ?? 0) + item.quantity);
      const productIds = [...quantities.keys()].sort();
      const { rows: products } = await client.query(`
        SELECT id, stock, version FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
      `, [productIds]);
      const mandate = mandateResult(mandateRow);
      const currentSnapshot = mandate
        && action.mandate_version === mandate.mandate_version
        && action.snapshot.mandate_version === mandate.mandate_version
        && action.snapshot.order_version === action.order_version
        && JSON.stringify(action.snapshot.items) === JSON.stringify(action.items)
        && JSON.stringify(action.snapshot.products) === JSON.stringify(products)
        && [...quantities.values()].reduce((total, value) => total + value, 0) === action.quantity
        && !isOrderEligible({ ...action, quantity: action.quantity }, products, mandate);
      if (!currentSnapshot) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }

      const { rows: [active] } = await client.query(`
        SELECT id, expires_at FROM approval_tokens
        WHERE action_id = $1 AND state = 'active' FOR UPDATE
      `, [actionId]);
      if (active && new Date(active.expires_at) > now) {
        await client.query('ROLLBACK');
        return { error: 'CONFLICT' };
      }
      if (active) await client.query(
        "UPDATE approval_tokens SET state = 'expired', version = version + 1 WHERE id = $1", [active.id]
      );
      if (action.state === 'pending') await client.query(
        "UPDATE pending_actions SET state = 'approved', version = version + 1 WHERE id = $1", [actionId]
      );
      await client.query(`
        INSERT INTO approval_tokens (id, action_id, token_hash, expires_at, state, version)
        VALUES ($1, $2, $3, $4, 'active', 1)
      `, [`approval-${randomUUID()}`, actionId, approvalTokenHash, expiresAt]);
      await client.query('COMMIT');
      return {
        approval: {
          action_id: action.action_id,
          order_id: action.order_id,
          quantity: action.quantity,
          state: 'approved',
          expires_at: expiresAt.toISOString()
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') return { error: 'CONFLICT' };
      throw error;
    } finally {
      client.release();
    }
  },

  async commitAction(actionId, approvalTokenHash, idempotencyKey, sellerTokenHash, now) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [seller] } = await client.query(`
        SELECT id FROM seller_users
        WHERE session_token_hash = $1 AND session_expires_at > $2 AND status = 'active'
        FOR UPDATE
      `, [sellerTokenHash, now]);
      if (!seller) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }

      const { rows: [replay] } = await client.query(`
        SELECT pa.id AS action_id, at.token_hash, r.body, r.issued_at, r.version
        FROM orders o
        JOIN pending_actions pa ON pa.order_id = o.id AND pa.state = 'committed'
        JOIN approval_tokens at ON at.action_id = pa.id AND at.state = 'consumed'
        JOIN receipts r ON r.order_id = o.id
        WHERE o.idempotency_key = $1
      `, [idempotencyKey]);
      if (replay) {
        if (replay.action_id !== actionId || replay.token_hash !== approvalTokenHash) {
          await client.query('ROLLBACK');
          return { error: 'CONFLICT' };
        }
        await client.query('COMMIT');
        return { receipt: receiptResult(replay), replayed: true };
      }

      const { rows: [action] } = await client.query(`
        SELECT pa.id AS action_id, pa.order_id, pa.mandate_version, pa.quantity, pa.snapshot,
          pa.state, o.items, o.total_cents, o.discount_percent,
          o.status AS order_status, o.version AS order_version
        FROM pending_actions pa JOIN orders o ON o.id = pa.order_id
        WHERE pa.id = $1 FOR UPDATE OF pa, o
      `, [actionId]);
      if (!action) {
        await client.query('ROLLBACK');
        return { error: 'NOT_FOUND' };
      }
      if (action.state !== 'approved' || action.order_status !== 'pending') {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }

      const { rows: [approval] } = await client.query(`
        SELECT id, expires_at, state FROM approval_tokens
        WHERE action_id = $1 AND token_hash = $2 FOR UPDATE
      `, [actionId, approvalTokenHash]);
      if (!approval) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }
      if (approval.state !== 'active') {
        await client.query('ROLLBACK');
        return { error: 'EXPIRED_APPROVAL' };
      }
      if (new Date(approval.expires_at) <= now) {
        await client.query("UPDATE approval_tokens SET state = 'expired', version = version + 1 WHERE id = $1", [approval.id]);
        await client.query('COMMIT');
        return { error: 'EXPIRED_APPROVAL' };
      }

      const { rows: [mandateRow] } = await client.query(`
        SELECT max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version
        FROM mandates WHERE state = 'active' ORDER BY version DESC LIMIT 1 FOR UPDATE
      `);
      const quantities = new Map();
      for (const item of action.items) quantities.set(item.product_id, (quantities.get(item.product_id) ?? 0) + item.quantity);
      const productIds = [...quantities.keys()].sort();
      const { rows: products } = await client.query(`
        SELECT id, stock, version FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
      `, [productIds]);
      const mandate = mandateResult(mandateRow);
      const currentSnapshot = mandate
        && action.mandate_version === mandate.mandate_version
        && action.snapshot.mandate_version === mandate.mandate_version
        && action.snapshot.order_version === action.order_version
        && JSON.stringify(action.snapshot.items) === JSON.stringify(action.items)
        && JSON.stringify(action.snapshot.products) === JSON.stringify(products)
        && [...quantities.values()].reduce((total, value) => total + value, 0) === action.quantity
        && products.length === quantities.size
        && [...quantities].every(([productId, requested]) => products.find(product => product.id === productId)?.stock >= requested);
      if (!currentSnapshot) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }

      const accepted = await client.query(`
        UPDATE orders SET status = 'accepted', idempotency_key = $2, version = version + 1
        WHERE id = $1 AND status = 'pending'
      `, [action.order_id, idempotencyKey]);
      const committed = await client.query(`
        UPDATE pending_actions SET state = 'committed', version = version + 1
        WHERE id = $1 AND state = 'approved'
      `, [actionId]);
      const consumed = await client.query(`
        UPDATE approval_tokens SET state = 'consumed', version = version + 1
        WHERE id = $1 AND state = 'active'
      `, [approval.id]);
      if (accepted.rowCount !== 1 || committed.rowCount !== 1 || consumed.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }
      for (const [productId, requested] of quantities) {
        const product = products.find(candidate => candidate.id === productId);
        const changed = await client.query(`
          UPDATE products SET stock = stock - $2, version = version + 1
          WHERE id = $1 AND version = $3 AND stock >= $2
        `, [productId, requested, product.version]);
        if (changed.rowCount !== 1) {
          await client.query('ROLLBACK');
          return { error: 'STALE' };
        }
      }
      const receiptId = `receipt-${randomUUID()}`;
      const body = {
        receipt_id: receiptId,
        order_id: action.order_id,
        action_id: actionId,
        items: action.items,
        total_cents: action.total_cents,
        discount_percent: action.discount_percent
      };
      const { rows: [receipt] } = await client.query(`
        INSERT INTO receipts (id, order_id, body, issued_at, version)
        VALUES ($1, $2, $3::jsonb, $4, 1)
        RETURNING body, issued_at, version
      `, [receiptId, action.order_id, JSON.stringify(body), now]);
      await client.query('COMMIT');
      return { receipt: receiptResult(receipt), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') return { error: 'CONFLICT' };
      throw error;
    } finally {
      client.release();
    }
  },

  async acceptOrder(orderId, quantity, idempotencyKey, tokenHash, now) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // ponytail: one demo seller row serializes acceptance; use advisory locks if seller throughput grows.
      const { rows: [seller] } = await client.query(`
        SELECT id FROM seller_users
        WHERE session_token_hash = $1 AND session_expires_at > $2 AND status = 'active'
        FOR UPDATE
      `, [tokenHash, now]);
      if (!seller) {
        await client.query('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }

      const { rows: [replay] } = await client.query(`
        SELECT o.id AS order_id, COALESCE((
          SELECT SUM((item->>'quantity')::integer) FROM jsonb_array_elements(o.items) item
        ), 0)::integer AS quantity, r.body, r.issued_at, r.version
        FROM orders o JOIN receipts r ON r.order_id = o.id
        WHERE o.idempotency_key = $1
      `, [idempotencyKey]);
      if (replay) {
        if (replay.order_id !== orderId || replay.quantity !== quantity) {
          await client.query('ROLLBACK');
          return { error: 'CONFLICT' };
        }
        await client.query('COMMIT');
        return { receipt: receiptResult(replay), replayed: true };
      }

      const { rows: [order] } = await client.query(`
        SELECT id, items, total_cents, discount_percent, status, version
        FROM orders WHERE id = $1 FOR UPDATE
      `, [orderId]);
      if (!order) {
        await client.query('ROLLBACK');
        return { error: 'NOT_FOUND' };
      }
      const { rows: [pendingReplay] } = await client.query(`
        SELECT id AS action_id, order_id, quantity, state, version
        FROM pending_actions WHERE idempotency_key = $1
      `, [idempotencyKey]);
      if (pendingReplay) {
        if (pendingReplay.order_id !== orderId || pendingReplay.quantity !== quantity) {
          await client.query('ROLLBACK');
          return { error: 'CONFLICT' };
        }
        await client.query('COMMIT');
        return { error: 'APPROVAL_REQUIRED', pendingAction: pendingReplay, replayed: true };
      }
      if (!['requested', 'pending', 'eligible'].includes(order.status)) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }

      const quantities = new Map();
      for (const item of order.items) quantities.set(item.product_id, (quantities.get(item.product_id) ?? 0) + item.quantity);
      if ([...quantities.values()].reduce((total, value) => total + value, 0) !== quantity) {
        await client.query('ROLLBACK');
        return { error: 'STALE' };
      }
      const { rows: [mandateRow] } = await client.query(`
        SELECT max_items, max_total_cents, max_discount_percent, min_remaining_stock, state, version
        FROM mandates WHERE state = 'active' ORDER BY version DESC LIMIT 1 FOR UPDATE
      `);
      if (!mandateRow) {
        await client.query('ROLLBACK');
        return { error: 'UNAVAILABLE' };
      }
      const productIds = [...quantities.keys()].sort();
      const { rows: products } = await client.query(`
        SELECT id, stock, version FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
      `, [productIds]);
      const mandate = mandateResult(mandateRow);
      if (!isOrderEligible({ ...order, quantity }, products, mandate)) {
        const { rows: [current] } = await client.query(`
          SELECT id, order_id, mandate_version, quantity, snapshot, state, version, idempotency_key
          FROM pending_actions
          WHERE order_id = $1 AND state IN ('pending', 'eligible', 'approved')
          FOR UPDATE
        `, [orderId]);
        const currentSnapshot = current
          && current.mandate_version === mandate.mandate_version
          && current.quantity === quantity
          && current.snapshot.order_version === order.version
          && JSON.stringify(current.snapshot.items) === JSON.stringify(order.items)
          && JSON.stringify(current.snapshot.products) === JSON.stringify(products);
        if (currentSnapshot) {
          if (current.idempotency_key && current.idempotency_key !== idempotencyKey) {
            await client.query('ROLLBACK');
            return { error: 'CONFLICT' };
          }
          const { rows: [pendingAction] } = current.idempotency_key ? { rows: [current] } : await client.query(`
            UPDATE pending_actions SET idempotency_key = $2, version = version + 1
            WHERE id = $1
            RETURNING id AS action_id, order_id, quantity, state, version
          `, [current.id, idempotencyKey]);
          await client.query('COMMIT');
          return { error: 'APPROVAL_REQUIRED', pendingAction, replayed: true };
        }
        const { rows: [pendingOrder] } = order.status === 'pending' ? { rows: [{ version: order.version }] } : await client.query(`
          UPDATE orders SET status = 'pending', version = version + 1
          WHERE id = $1 AND status IN ('requested', 'eligible') RETURNING version
        `, [orderId]);
        if (!pendingOrder) {
          await client.query('ROLLBACK');
          const { rows: [winner] } = await db.pool.query(`
            SELECT id AS action_id, order_id, quantity, state, version
            FROM pending_actions WHERE idempotency_key = $1
          `, [idempotencyKey]);
          return winner?.order_id === orderId && winner.quantity === quantity
            ? { error: 'APPROVAL_REQUIRED', pendingAction: winner, replayed: true }
            : { error: 'STALE' };
        }
        if (current) {
          await client.query("UPDATE pending_actions SET state = 'replaced', version = version + 1 WHERE id = $1", [current.id]);
          await client.query("UPDATE approval_tokens SET state = 'invalidated', version = version + 1 WHERE action_id = $1 AND state = 'active'", [current.id]);
        }
        const snapshot = {
          mandate_version: mandate.mandate_version,
          order_version: pendingOrder.version,
          items: order.items,
          products
        };
        const { rows: [pendingAction] } = await client.query(`
          INSERT INTO pending_actions (id, order_id, mandate_version, quantity, snapshot, state, version, idempotency_key)
          VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 1, $6)
          RETURNING id AS action_id, order_id, quantity, state, version
        `, [`pending-${randomUUID()}`, orderId, mandate.mandate_version, quantity, JSON.stringify(snapshot), idempotencyKey]);
        await client.query('COMMIT');
        return { error: 'APPROVAL_REQUIRED', pendingAction, replayed: false };
      }

      const accepted = await client.query(`
        UPDATE orders SET status = 'accepted', idempotency_key = $2, version = version + 1
        WHERE id = $1 AND status IN ('requested', 'eligible')
        RETURNING id
      `, [orderId, idempotencyKey]);
      if (!accepted.rowCount) {
        const { rows: [winner] } = await client.query(`
          SELECT o.id AS order_id, COALESCE((
            SELECT SUM((item->>'quantity')::integer) FROM jsonb_array_elements(o.items) item
          ), 0)::integer AS quantity, r.body, r.issued_at, r.version
          FROM orders o JOIN receipts r ON r.order_id = o.id
          WHERE o.idempotency_key = $1
        `, [idempotencyKey]);
        await client.query(winner ? 'COMMIT' : 'ROLLBACK');
        return winner?.order_id === orderId && winner.quantity === quantity
          ? { receipt: receiptResult(winner), replayed: true }
          : { error: 'STALE' };
      }
      await client.query(`
        UPDATE pending_actions SET state = 'committed', version = version + 1
        WHERE order_id = $1 AND state = 'eligible'
      `, [orderId]);
      for (const [productId, requested] of quantities) {
        const changed = await client.query(`
          UPDATE products SET stock = stock - $2, version = version + 1
          WHERE id = $1 AND stock - $2 >= $3
        `, [productId, requested, mandate.min_stock_remaining]);
        if (changed.rowCount !== 1) {
          await client.query('ROLLBACK');
          return { error: 'STALE' };
        }
      }
      const receiptId = `receipt-${randomUUID()}`;
      const body = {
        receipt_id: receiptId,
        order_id: orderId,
        items: order.items,
        total_cents: order.total_cents,
        discount_percent: order.discount_percent
      };
      const { rows: [receipt] } = await client.query(`
        INSERT INTO receipts (id, order_id, body, issued_at, version)
        VALUES ($1, $2, $3::jsonb, $4, 1)
        RETURNING body, issued_at, version
      `, [receiptId, orderId, JSON.stringify(body), now]);
      await client.query('COMMIT');
      return { receipt: receiptResult(receipt), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') return { error: 'CONFLICT' };
      throw error;
    } finally {
      client.release();
    }
  }
});
