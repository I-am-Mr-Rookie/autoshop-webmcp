import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOrderHandler } from '../netlify/functions/buyer-order.mjs';
import { hashConfirmationToken } from '../netlify/functions/buyer-confirm.mjs';
import { hashSessionToken } from '../netlify/functions/buyer.mjs';

const rawSession = 'a'.repeat(64);
const rawConfirmation = 'b'.repeat(64);
const sessionId = hashSessionToken(rawSession);

const memoryRepository = () => {
  let order;
  const calls = [];
  return {
    calls,
    async findBuyerSession(id) { return id === sessionId ? { id } : null; },
    async submitOrder(id, now, orderId, tokenHash) {
      calls.push({ id, now, orderId, tokenHash });
      order ??= {
        order_id: orderId,
        status: 'requested',
        total_cents: 9800,
        version: 1,
        created_at: '2026-09-02T12:00:00.000Z'
      };
      return { order, replayed: calls.length > 1 };
    },
    async getOrder(id, orderId) { return id === sessionId && order?.order_id === orderId ? order : null; }
  };
};

const request = (method, body, query = '') => new Request(`https://example.test/api/buyer/order${query}`, {
  method,
  headers: { cookie: `autoshop_buyer=${rawSession}`, 'content-type': 'application/json' },
  body: body && JSON.stringify(body)
});

test('submits one synthetic order idempotently with the hashed confirmation token', async () => {
  const repository = memoryRepository();
  const handler = createOrderHandler(async () => repository, { now: () => new Date('2026-09-02T12:00:00.000Z') });
  const input = { order_id: 'order_demo', confirm_token: rawConfirmation };

  const first = await handler(request('POST', input));
  const replay = await handler(request('POST', input));

  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), {
    ok: true,
    replayed: false,
    order: {
      order_id: 'order_demo', status: 'requested', total_cents: 9800, version: 1,
      created_at: '2026-09-02T12:00:00.000Z'
    }
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(repository.calls[0].tokenHash, hashConfirmationToken(rawConfirmation));
  assert.equal(JSON.stringify(repository.calls).includes(rawConfirmation), false);
  const statusBody = await (await handler(request('GET', null, '?order_id=order_demo'))).json();
  assert.equal(Object.hasOwn(statusBody.order, 'payment'), false);
});

test('exposes only the cookie-bound synthetic order status', async () => {
  const repository = memoryRepository();
  const handler = createOrderHandler(async () => repository);
  await handler(request('POST', { order_id: 'order_demo', confirm_token: rawConfirmation }));

  const found = await handler(request('GET', null, '?order_id=order_demo'));
  assert.equal(found.status, 200);
  assert.equal((await found.json()).order.status, 'requested');

  const missing = await handler(request('GET', null, '?order_id=order_other'));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');
});

test('rejects malformed, unauthorized, expired, and stale submissions', async () => {
  const repository = memoryRepository();
  const handler = createOrderHandler(async () => repository);

  assert.equal((await handler(request('POST', { order_id: 'bad id', confirm_token: rawConfirmation }))).status, 400);
  assert.equal((await handler(request('GET', null, '?order_id=order_demo&order_id=order_demo'))).status, 400);
  const unauthorized = await handler(new Request('https://example.test/api/buyer/order', {
    method: 'POST', body: JSON.stringify({ order_id: 'order_demo', confirm_token: rawConfirmation })
  }));
  assert.equal(unauthorized.status, 401);

  for (const [error, status] of [['EXPIRED', 409], ['STALE', 409], ['FORBIDDEN', 403]]) {
    repository.submitOrder = async () => ({ error });
    const response = await handler(request('POST', { order_id: 'order_demo', confirm_token: rawConfirmation }));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, error);
  }
});

test('closes submitted carts and lets expired buyer sessions cascade', async () => {
  const repositorySource = await readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../netlify/database/migrations/003_order-submission/migration.sql', import.meta.url), 'utf8');

  assert.match(repositorySource, /FROM carts WHERE buyer_session_id = \$1 AND status = 'open' FOR UPDATE/);
  assert.match(migration, /FOREIGN KEY \(buyer_session_id\) REFERENCES buyer_sessions\(id\) ON DELETE CASCADE/);
});
