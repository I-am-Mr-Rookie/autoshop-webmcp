import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMandateHandler } from '../netlify/functions/seller-mandate.mjs';
import { hashSessionToken } from '../netlify/functions/seller-auth.mjs';
import { isOrderEligible } from '../netlify/functions/_shared/postgres-repository.mjs';

const rawSession = 'a'.repeat(64);
const now = new Date('2026-09-02T12:00:00.000Z');
const input = {
  mandate_version: 1,
  max_items_per_order: 6,
  max_total_cents: 10000,
  max_discount_percent: 10,
  min_stock_remaining: 2
};

const memoryRepository = () => {
  let mandate = {
    mandate_version: 1, currency: 'USD', max_items_per_order: 5,
    max_total_cents: 10000, max_discount_percent: 10,
    min_stock_remaining: 2, status: 'active'
  };
  return {
    updates: 0,
    async findSellerSession(tokenHash) {
      return tokenHash === hashSessionToken(rawSession) ? { username: 'seller', expires_at: '2026-09-02T20:00:00.000Z' } : null;
    },
    async getMandate() { return mandate; },
    async updateMandate(expectedVersion, limits) {
      if (expectedVersion !== mandate.mandate_version) return { error: 'STALE', mandate };
      this.updates += 1;
      mandate = { ...mandate, ...limits, mandate_version: mandate.mandate_version + 1 };
      return { mandate, re_evaluated: 0, eligible: 0 };
    }
  };
};

const request = (method, body = undefined, headers = {}) => new Request('https://example.test/api/seller/mandate', {
  method,
  headers: {
    cookie: `__Host-autoshop_seller=${rawSession}`,
    origin: 'https://example.test',
    'content-type': 'application/json',
    ...headers
  },
  body: body && JSON.stringify(body)
});

test('rejects unauthenticated, cross-origin, and malformed mandate edits without mutation', async () => {
  const repository = memoryRepository();
  const handler = createMandateHandler(async () => repository, { now: () => now });

  const unauthorized = await handler(new Request('https://example.test/api/seller/mandate'));
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await handler(request('PUT', input, { origin: 'https://attacker.test' }));
  assert.equal(crossOrigin.status, 403);

  for (const malformed of [
    { ...input, extra: true },
    { ...input, max_items_per_order: 1.5 },
    { ...input, max_total_cents: 100001 },
    { ...input, max_discount_percent: -1 },
    { ...input, min_stock_remaining: 101 },
    { ...input, mandate_version: undefined }
  ]) {
    const response = await handler(request('PUT', malformed));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VALIDATION');
  }
  assert.equal(repository.updates, 0);
});

test('reads and increments the authenticated mandate with stale-write protection', async () => {
  const repository = memoryRepository();
  const handler = createMandateHandler(async () => repository, { now: () => now });

  const read = await handler(request('GET'));
  assert.equal((await read.json()).mandate.mandate_version, 1);
  const saved = await handler(request('PUT', input));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    ok: true,
    mandate: { ...input, mandate_version: 2, currency: 'USD', status: 'active' },
    re_evaluated: 0,
    eligible: 0
  });
  const stale = await handler(request('PUT', input));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'STALE');
  assert.equal(repository.updates, 1);

  repository.getMandate = async () => null;
  const missing = await handler(request('GET'));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'UNAVAILABLE');
});

test('re-evaluates quantity six without mutating stock or silently accepting it', async () => {
  const order = {
    status: 'pending', quantity: 6, total_cents: 6000, discount_percent: 0,
    items: [{ product_id: 'ram-1', quantity: 6 }]
  };
  const products = [{ id: 'ram-1', stock: 10, version: 1 }];
  const before = structuredClone(products);
  assert.equal(isOrderEligible(order, products, { ...input, max_items_per_order: 5 }), false);
  assert.equal(isOrderEligible(order, products, input), true);
  assert.deepEqual(products, before);
  assert.equal(order.status, 'pending');

  assert.equal(isOrderEligible({ ...order, quantity: 5 }, products, input), false);
  assert.equal(isOrderEligible({ ...order, quantity: 10, items: [...order.items, { product_id: 'ram-1', quantity: 4 }] }, products, { ...input, max_items_per_order: 10 }), false);

  const repository = await readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8');
  const mandateUpdate = repository.slice(repository.indexOf('async updateMandate'), repository.indexOf('async listProducts'));
  assert.doesNotMatch(mandateUpdate, /UPDATE\s+products/i);
  assert.match(mandateUpdate, /state = 'replaced'/);
  assert.match(mandateUpdate, /const state = permitted \? 'eligible' : 'pending'/);
});
