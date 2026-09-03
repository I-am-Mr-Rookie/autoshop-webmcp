import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as app from '../public/app.js';
import { hashSessionToken } from '../netlify/functions/seller-auth.mjs';
import { createPostgresRepository } from '../netlify/functions/_shared/postgres-repository.mjs';

const rawToken = 'a'.repeat(64);
const order = {
  order_id: 'order_1',
  items: [{ product_id: 'ram-1', quantity: 3 }],
  quantity: 3,
  total_cents: 14700,
  discount_percent: 0,
  status: 'requested',
  version: 1,
  created_at: '2026-09-03T00:00:00.000Z',
  pending_action: null,
  receipt: null
};

test('seller portal exposes queue, decision, approval, commit, receipt, privileged reset, and logout controls', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['seller-orders', 'seller-refresh-orders', 'seller-approval', 'seller-commit-approved', 'reset-demo', 'seller-logout']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /receipt\.decision_path[\s\S]+receipt\.mandate_version/);
  assert.match(source, /receipt\?\.decision_path && order\.receipt\?\.mandate_version/);
});

test('authenticated seller order endpoint returns a bounded queue', async () => {
  const { createSellerOrdersHandler } = await import('../netlify/functions/seller-orders.mjs');
  let limit;
  const repository = {
    async findSellerSession(tokenHash) {
      return tokenHash === hashSessionToken(rawToken) ? { username: 'seller', expires_at: '2026-09-03T08:00:00.000Z' } : null;
    },
    async listSellerOrders(_tokenHash, _now, requestedLimit) { limit = requestedLimit; return [order]; }
  };
  const handler = createSellerOrdersHandler(async () => repository, { now: () => new Date('2026-09-03T00:00:00.000Z') });
  const response = await handler(new Request('https://example.test/api/seller/orders?limit=2', {
    headers: { cookie: `__Host-autoshop_seller=${rawToken}` }
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, orders: [order] });
  assert.equal(limit, 2);
});

test('seller order endpoint rejects unauthenticated and unbounded reads', async () => {
  const { createSellerOrdersHandler } = await import('../netlify/functions/seller-orders.mjs');
  const repository = { findSellerSession: async () => null, listSellerOrders: async () => assert.fail('must not list') };
  const handler = createSellerOrdersHandler(async () => repository);
  assert.equal((await handler(new Request('https://example.test/api/seller/orders'))).status, 401);
  assert.equal((await handler(new Request('https://example.test/api/seller/orders?limit=6'))).status, 400);
});

test('list_orders uses the authenticated seller API in browser context', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.document = {};
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, orders: [order] }));
  };
  try {
    assert.deepEqual(await app.SELLER_TOOLS[1].execute({ limit: 2 }), { ok: true, orders: [order] });
    assert.equal(request.url, '/api/seller/orders?limit=2');
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});

test('repository bounds seller queue data without exposing buyer details', async () => {
  let query;
  const repository = createPostgresRepository({ pool: { query: async (text, params) => {
    query = { text, params };
    return { rows: [{
      order_id: 'order_1', items: [{ product_id: 'ram-1', quantity: 3 }], total_cents: 14700,
      discount_percent: 0, status: 'accepted', version: 2, created_at: new Date('2026-09-03T00:00:00.000Z'),
      action_id: null, action_quantity: null, action_state: null, action_version: null,
      receipt_body: { receipt_id: 'receipt_1', order_id: 'order_1', items: [{ product_id: 'ram-1', quantity: 3 }], total_cents: 14700, discount_percent: 0 },
      issued_at: new Date('2026-09-03T00:01:00.000Z'), receipt_version: 1
    }] };
  } } });
  const result = await repository.listSellerOrders('token-hash', new Date('2026-09-03T00:00:00.000Z'), 2);
  assert.equal(query.params[2], 2);
  assert.match(query.text, /WHERE session_token_hash = \$1/);
  assert.equal(result[0].quantity, 3);
  assert.equal(result[0].receipt.receipt_id, 'receipt_1');
  assert.equal(Object.hasOwn(result[0], 'buyer_email'), false);
});
