import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as app from '../public/app.js';
import { createPostgresRepository } from '../netlify/functions/_shared/postgres-repository.mjs';

const respond = (status, body) => new Response(JSON.stringify(body), { status });

async function withBrowser(fetchImpl, run) {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const listeners = new Map();
  globalThis.document = {
    querySelector: () => null,
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    }
  };
  globalThis.fetch = fetchImpl;
  try { return await run(); }
  finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
}

test('seller 401 returns non-retryable FORBIDDEN and removes registered tools', async () => {
  await withBrowser(
    async () => respond(401, { ok: false, error: { code: 'FORBIDDEN', message: 'Seller sign-in is required.' } }),
    async () => {
      let signal;
      const stop = await app.registerRoleTools(
        { registerTool: async (_tool, options) => { signal = options.signal; } },
        '/seller',
        () => {}
      );
      try {
        const result = await app.SELLER_TOOLS.find(tool => tool.name === 'list_orders').execute({ limit: 5 });
        assert.deepEqual(result, {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Seller sign-in is required.', retryable: false }
        });
        assert.equal(signal.aborted, true);
      } finally { stop(); }
    }
  );
});

test('seller tools preserve actionable errors and retry only genuine outages', async () => {
  const accept = app.SELLER_TOOLS.find(tool => tool.name === 'accept_order');
  const input = { order_id: 'order-1', quantity: 6, idempotency_key: 'judge-key-0001' };

  const stale = await withBrowser(
    async () => respond(409, { ok: false, error: { code: 'STALE', message: 'Refresh the order.' } }),
    () => accept.execute(input)
  );
  assert.deepEqual(stale, { ok: false, error: { code: 'STALE', message: 'Refresh the order.', retryable: false } });

  const outage = await withBrowser(
    async () => respond(503, { ok: false, error: { code: 'UNAVAILABLE', message: 'Try later.' } }),
    () => accept.execute(input)
  );
  assert.deepEqual(outage, { ok: false, error: { code: 'UNAVAILABLE', message: 'Try later.', retryable: true } });
});

test('submitting an order reopens an empty cart for the next judge run', async () => {
  const statements = [];
  const client = {
    async query(rawText, params) {
      const text = rawText.replace(/\s+/g, ' ').trim();
      statements.push({ text, params });
      if (/FROM buyer_sessions WHERE id = \$1 AND expires_at > \$2 FOR UPDATE/.test(text)) {
        return { rows: [{ confirmed_order_id: 'order-1', confirm_token_hash: 'hash', confirm_cart_version: 2, confirm_expires_at: '2026-09-04T00:00:00.000Z' }] };
      }
      if (/FROM orders WHERE id = \$1/.test(text)) return { rows: [] };
      if (/FROM carts WHERE buyer_session_id = \$1 AND status = 'open' FOR UPDATE/.test(text)) {
        return { rows: [{ items: [{ product_id: 'ram-1', quantity: 6 }], version: 2 }] };
      }
      if (/AS total_cents FROM carts c/.test(text)) {
        return { rows: [{ items: [{ product_id: 'ram-1', quantity: 6 }], version: 2, total_cents: 29400 }] };
      }
      if (/INSERT INTO orders/.test(text)) {
        return { rows: [{ order_id: 'order-1', status: 'requested', total_cents: 29400, version: 1, created_at: new Date('2026-09-03T00:00:00.000Z') }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const repository = createPostgresRepository({ pool: { connect: async () => client } });

  await repository.submitOrder('buyer-1', new Date('2026-09-03T00:00:00.000Z'), 'order-1', 'hash');

  const update = statements.find(({ text }) => /UPDATE carts SET/.test(text));
  assert.match(update.text, /items = '\[\]'::jsonb/);
  assert.match(update.text, /status = 'open'/);
  assert.equal(statements.at(-1).text, 'COMMIT');
});

test('an identical pending retry with a fresh key replays without mutation', async () => {
  const statements = [];
  const order = { id: 'order-1', items: [{ product_id: 'ram-1', quantity: 6 }], total_cents: 29400, discount_percent: 0, status: 'pending', version: 2 };
  const products = [{ id: 'ram-1', stock: 12, version: 1 }];
  const mandate = { max_items: 5, max_total_cents: 10000, max_discount_percent: 10, min_remaining_stock: 2, state: 'active', version: 1 };
  const current = {
    id: 'pending-1', order_id: 'order-1', mandate_version: 1, quantity: 6, state: 'pending', version: 1,
    idempotency_key: 'first-key-0001',
    snapshot: { mandate_version: 1, order_version: 2, items: order.items, products }
  };
  const client = {
    async query(rawText, params) {
      const text = rawText.replace(/\s+/g, ' ').trim();
      statements.push({ text, params });
      if (/FROM seller_sessions ss JOIN seller_users su/.test(text)) return { rows: [{ id: 'seller-1' }] };
      if (/FROM orders o JOIN receipts r/.test(text)) return { rows: [] };
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [order] };
      if (/FROM pending_actions WHERE idempotency_key = \$1/.test(text)) return { rows: [] };
      if (/FROM mandates WHERE state = 'active'/.test(text)) return { rows: [mandate] };
      if (/FROM products WHERE id = ANY/.test(text)) return { rows: products };
      if (/FROM pending_actions WHERE order_id = \$1 AND state IN/.test(text)) return { rows: [current] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const repository = createPostgresRepository({ pool: { connect: async () => client } });

  const result = await repository.acceptOrder(
    'order-1', 6, 'second-key-0002', 'seller-token', new Date('2026-09-03T00:00:00.000Z')
  );

  assert.equal(result.error, 'APPROVAL_REQUIRED');
  assert.equal(result.replayed, true);
  assert.deepEqual(result.pendingAction, {
    action_id: 'pending-1', order_id: 'order-1', quantity: 6, state: 'pending', version: 1
  });
  assert.ok(!statements.some(({ text }) => /^(UPDATE|INSERT)/.test(text)));
  assert.equal(statements.at(-1).text, 'COMMIT');
});

test('independent seller sessions survive another login and isolated logout', async () => {
  let legacySession;
  const sessions = new Map();
  const pool = {
    async query(rawText, params = []) {
      const text = rawText.replace(/\s+/g, ' ').trim();
      if (/UPDATE seller_users SET session_token_hash/.test(text)) {
        legacySession = { token_hash: params[1], seller_id: params[0], expires_at: params[2] };
        return { rows: [] };
      }
      if (/INSERT INTO seller_sessions/.test(text)) {
        sessions.set(params[1], { token_hash: params[1], seller_id: params[0], expires_at: params[2] });
        return { rows: [] };
      }
      if (/UPDATE seller_users SET session_token_hash = NULL/.test(text)) {
        if (legacySession?.token_hash === params[0]) legacySession = undefined;
        return { rows: [] };
      }
      if (/DELETE FROM seller_sessions WHERE token_hash = \$1 AND expires_at <= \$2/.test(text)) {
        const session = sessions.get(params[0]);
        if (session && session.expires_at <= params[1]) sessions.delete(params[0]);
        return { rows: [] };
      }
      if (/DELETE FROM seller_sessions WHERE token_hash = \$1/.test(text)) {
        sessions.delete(params[0]);
        return { rows: [] };
      }
      if (/FROM seller_sessions ss JOIN seller_users su/.test(text)) {
        const session = sessions.get(params[0]);
        return { rows: session && session.expires_at > params[1]
          ? [{ seller_user_id: session.seller_id, username: 'seller', expires_at: session.expires_at }]
          : [] };
      }
      if (/FROM seller_users WHERE session_token_hash/.test(text)) {
        return { rows: legacySession?.token_hash === params[0] && legacySession.expires_at > params[1]
          ? [{ username: 'seller', expires_at: legacySession.expires_at }]
          : [] };
      }
      return { rows: [] };
    }
  };
  const repository = createPostgresRepository({ pool });
  const expiresAt = new Date('2026-09-04T00:00:00.000Z');
  const now = new Date('2026-09-03T00:00:00.000Z');

  await repository.createSellerSession('seller-1', 'token-a', expiresAt);
  await repository.createSellerSession('seller-1', 'token-b', expiresAt);
  assert.equal((await repository.findSellerSession('token-a', now))?.username, 'seller');
  assert.equal((await repository.findSellerSession('token-b', now))?.username, 'seller');
  await repository.deleteSellerSession('token-a');
  assert.equal(await repository.findSellerSession('token-a', now), null);
  assert.equal((await repository.findSellerSession('token-b', now))?.username, 'seller');
});

test('every seller authorization path uses the multi-session table', async () => {
  const [source, migration] = await Promise.all([
    readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../netlify/database/migrations/011_seller-sessions/migration.sql', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /CREATE TABLE seller_sessions[\s\S]+token_hash TEXT PRIMARY KEY[\s\S]+REFERENCES seller_users\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(source, /WHERE session_token_hash = \$1/);
  for (const method of ['findSellerSession', 'listSellerOrders', 'updateMandate', 'approveAction', 'commitAction', 'acceptOrder']) {
    const start = source.indexOf(`async ${method}`);
    const end = source.indexOf('\n  async ', start + 6);
    assert.match(source.slice(start, end < 0 ? source.length : end), /seller_sessions/);
  }
});
