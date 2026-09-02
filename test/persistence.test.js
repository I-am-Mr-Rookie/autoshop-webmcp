import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedRecords, resetDemoData } from '../persistence.js';
import { createHandler } from '../netlify/functions/demo-data.mjs';

const sellerPasswordHash = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

test('seeds every required record type and resets through one repository transaction', async () => {
  const records = createSeedRecords(sellerPasswordHash);
  assert.deepEqual(Object.keys(records), [
    'products', 'buyerSessions', 'carts', 'orders', 'mandates',
    'pendingActions', 'approvalTokens', 'receipts', 'sellerUsers'
  ]);
  assert.equal(records.products.length, 3);
  assert.equal(records.mandates[0].maxItems, 5);
  assert.equal(records.sellerUsers[0].username, 'seller');
  assert.ok(Object.values(records).flat().every(record => record.version === 1));

  let replaced;
  const result = await resetDemoData({ replace: async value => { replaced = value; } }, sellerPasswordHash);
  assert.deepEqual(replaced, records);
  assert.deepEqual(result, { ok: true, products: 3, mandateVersion: 1, sellerUsers: 1 });
});

test('reset endpoint requires an explicit confirmation and returns a bounded result', async () => {
  let resets = 0;
  const repository = {
    findSellerSession: async () => ({ username: 'seller', expires_at: '2026-09-04T00:00:00.000Z' }),
    replace: async () => { resets += 1; }
  };
  const handler = createHandler(async () => repository, { passwordHash: sellerPasswordHash });

  const rejected = await handler(new Request('https://example.test/api/demo-data/reset', {
    method: 'POST', headers: { cookie: `__Host-autoshop_seller=${'a'.repeat(64)}`, origin: 'https://example.test' },
    body: JSON.stringify({ confirm: 'wrong' })
  }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { ok: false, error: { code: 'VALIDATION', message: 'Send exactly {"confirm":"RESET"}.' } });

  const accepted = await handler(new Request('https://example.test/api/demo-data/reset', {
    method: 'POST', headers: { cookie: `__Host-autoshop_seller=${'a'.repeat(64)}`, origin: 'https://example.test' },
    body: JSON.stringify({ confirm: 'RESET' })
  }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, products: 3, mandateVersion: 1, sellerUsers: 1 });
  assert.equal(resets, 1);
});
