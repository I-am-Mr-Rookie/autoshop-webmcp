import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPostgresRepository, isOrderEligible } from '../netlify/functions/_shared/postgres-repository.mjs';
import { hashSessionToken } from '../netlify/functions/seller-auth.mjs';
import * as app from '../public/app.js';

const acceptModule = await import('../netlify/functions/seller-accept.mjs').catch(() => ({}));
const rawSession = 'a'.repeat(64);
const now = new Date('2026-09-02T12:00:00.000Z');
const input = { order_id: 'order_demo', quantity: 3, idempotency_key: 'accept-request-1' };

const memoryRepository = () => {
  const receipt = {
    receipt_id: 'receipt_demo', order_id: 'order_demo', items: [{ product_id: 'ram-1', quantity: 3 }],
    total_cents: 3000, discount_percent: 0, issued_at: now.toISOString(), version: 1
  };
  let calls = 0;
  return {
    get calls() { return calls; },
    async findSellerSession(tokenHash) {
      return tokenHash === hashSessionToken(rawSession) ? { username: 'seller', expires_at: '2026-09-02T20:00:00.000Z' } : null;
    },
    async acceptOrder(orderId, quantity, idempotencyKey, tokenHash, acceptedAt) {
      calls += 1;
      assert.equal(tokenHash, hashSessionToken(rawSession));
      assert.deepEqual({ orderId, quantity, idempotencyKey, acceptedAt }, {
        orderId: 'order_demo', quantity: 3, idempotencyKey: 'accept-request-1', acceptedAt: now
      });
      return { receipt, replayed: calls > 1 };
    }
  };
};

const request = (body = input, headers = {}) => new Request('https://example.test/api/seller/accept', {
  method: 'POST',
  headers: {
    cookie: `__Host-autoshop_seller=${rawSession}`,
    origin: 'https://example.test',
    'content-type': 'application/json',
    ...headers
  },
  body: JSON.stringify(body)
});

test('accepts a permitted order once and replays its immutable receipt', async () => {
  assert.equal(typeof acceptModule.createAcceptHandler, 'function');
  const repository = memoryRepository();
  const handler = acceptModule.createAcceptHandler(async () => repository, { now: () => now });

  const first = await handler(request());
  const replay = await handler(request());

  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), {
    ok: true, replayed: false,
    receipt: {
      receipt_id: 'receipt_demo', order_id: 'order_demo', items: [{ product_id: 'ram-1', quantity: 3 }],
      total_cents: 3000, discount_percent: 0, issued_at: now.toISOString(), version: 1
    }
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
});

test('rejects unauthorized, cross-origin, malformed, and non-permitted acceptance', async () => {
  assert.equal(typeof acceptModule.createAcceptHandler, 'function');
  const repository = memoryRepository();
  const handler = acceptModule.createAcceptHandler(async () => repository, { now: () => now });

  assert.equal((await handler(new Request('https://example.test/api/seller/accept', { method: 'POST' }))).status, 401);
  assert.equal((await handler(request(input, { origin: 'https://attacker.test' }))).status, 403);
  for (const malformed of [
    { ...input, extra: true }, { ...input, quantity: 0 }, { ...input, order_id: 'bad id' },
    { ...input, idempotency_key: 'short' }
  ]) assert.equal((await handler(request(malformed))).status, 400);

  repository.acceptOrder = async () => ({
    error: 'APPROVAL_REQUIRED',
    pendingAction: { action_id: 'pending-1', order_id: 'order-1', quantity: 6, state: 'pending', version: 1 }
  });
  const pending = await handler(request({ ...input, quantity: 6 }));
  assert.equal(pending.status, 409);
  const pendingResult = await pending.json();
  assert.equal(pendingResult.error.code, 'APPROVAL_REQUIRED');
  assert.equal(pendingResult.pending_action.action_id, 'pending-1');

  repository.acceptOrder = async () => ({ error: 'CONFLICT' });
  const conflict = await handler(request());
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'CONFLICT');
});

test('permits quantities three and five only while minimum stock remains', () => {
  const mandate = {
    max_items_per_order: 5, max_total_cents: 10000, max_discount_percent: 10, min_stock_remaining: 2
  };
  const order = quantity => ({
    quantity, total_cents: quantity * 1000, discount_percent: 0,
    items: [{ product_id: 'ram-1', quantity }]
  });

  assert.equal(isOrderEligible(order(3), [{ id: 'ram-1', stock: 5 }], mandate), true);
  assert.equal(isOrderEligible(order(5), [{ id: 'ram-1', stock: 7 }], mandate), true);
  assert.equal(isOrderEligible(order(5), [{ id: 'ram-1', stock: 6 }], mandate), false);
  assert.equal(isOrderEligible({
    ...order(3),
    items: [{ product_id: 'ram-1', quantity: 3, note: 'untrusted buyer content' }]
  }, [{ id: 'ram-1', stock: 5 }], mandate), false);
});

test('repository exposes one transactional acceptance path and receipts stay immutable', async () => {
  const repository = createPostgresRepository({ pool: {} });
  assert.equal(typeof repository.acceptOrder, 'function');
  const source = await readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8');
  assert.match(source, /BEGIN[\s\S]+FOR UPDATE[\s\S]+UPDATE products[\s\S]+INSERT INTO receipts[\s\S]+COMMIT/);
  assert.match(source, /replay\.order_id !== orderId[\s\S]+replay\.quantity !== quantity/);
  assert.match(source, /status IN \('requested', 'eligible'\)[\s\S]+pending_actions SET state = 'committed'/);
  assert.doesNotMatch(source, /UPDATE receipts/);

  const migration = await readFile(new URL('../netlify/database/migrations/006_receipt-retention/migration.sql', import.meta.url), 'utf8').catch(() => '');
  assert.match(migration, /FOREIGN KEY \(order_id\) REFERENCES orders\(id\) ON DELETE CASCADE/);
});

test('accept_order calls the seller acceptance endpoint in browser context', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.document = {};
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ ok: true, replayed: false, receipt: { receipt_id: 'receipt_demo' } }), { status: 201 });
  };
  try {
    const tool = app.SELLER_TOOLS.find(candidate => candidate.name === 'accept_order');
    const result = await tool.execute(input);
    assert.equal(result.receipt.receipt_id, 'receipt_demo');
    assert.deepEqual(call, {
      url: '/api/seller/accept',
      options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'APPROVAL_REQUIRED', message: 'Seller approval required.' },
      pending_action: { action_id: 'pending-1', order_id: 'order_demo', quantity: 6, state: 'pending', version: 1 }
    }), { status: 409 });
    const pending = await tool.execute({ ...input, quantity: 6 });
    assert.equal(pending.error.code, 'APPROVAL_REQUIRED');
    assert.equal(pending.pending_action.action_id, 'pending-1');
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});
