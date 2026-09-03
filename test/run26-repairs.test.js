import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createPostgresRepository } from '../netlify/functions/_shared/postgres-repository.mjs';
import { createHandler as createResetHandler } from '../netlify/functions/demo-data.mjs';
import { registerRoleTools } from '../public/app.js';

const sellerToken = 'a'.repeat(64);
const sellerCookie = `__Host-autoshop_seller=${sellerToken}`;
const sellerSession = { username: 'seller', expires_at: '2026-09-04T00:00:00.000Z' };
const passwordHash = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

test('reset requires a seller session, same origin, and exact RESET confirmation', async () => {
  let resets = 0;
  const repository = {
    async findSellerSession() { return sellerSession; },
    async replace() { resets += 1; }
  };
  const handler = createResetHandler(async () => repository, {
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    passwordHash
  });

  const anonymous = await handler(new Request('https://example.test/api/demo-data/reset', {
    method: 'POST', body: JSON.stringify({ confirm: 'RESET' })
  }));
  assert.equal(anonymous.status, 401);

  const crossOrigin = await handler(new Request('https://example.test/api/demo-data/reset', {
    method: 'POST', headers: { cookie: sellerCookie, origin: 'https://evil.test' },
    body: JSON.stringify({ confirm: 'RESET' })
  }));
  assert.equal(crossOrigin.status, 403);

  const invalid = await handler(new Request('https://example.test/api/demo-data/reset', {
    method: 'POST', headers: { cookie: sellerCookie, origin: 'https://example.test' },
    body: JSON.stringify({ confirm: 'wrong' })
  }));
  assert.equal(invalid.status, 400);

  const accepted = await handler(new Request('https://example.test/api/demo-data/reset', {
    method: 'POST', headers: { cookie: sellerCookie, origin: 'https://example.test' },
    body: JSON.stringify({ confirm: 'RESET' })
  }));
  assert.equal(accepted.status, 200);
  assert.equal(resets, 1);
});

test('root registers no tools and serves the script-free public homepage', async () => {
  const registrations = [];
  await registerRoleTools({ registerTool: async tool => registrations.push(tool.name) }, '/', () => {});
  assert.deepEqual(registrations, []);

  const redirects = await readFile(new URL('../public/_redirects', import.meta.url), 'utf8');
  assert.match(redirects, /^\/ \/home\.html 200!/m);
  const home = await readFile(new URL('../public/home.html', import.meta.url), 'utf8');
  assert.doesNotMatch(home, /<script/i);
  assert.match(home, /href="\/buyer"/);
  assert.match(home, /href="\/seller"/);
});

test('a failed stock update rolls back without creating a receipt', async () => {
  let receiptInserted = false;
  let committed = false;
  let rolledBack = false;
  const now = new Date('2026-09-03T00:00:00.000Z');
  const client = {
    async query(text) {
      if (text === 'BEGIN') return { rows: [], rowCount: 0 };
      if (text === 'COMMIT') { committed = true; return { rows: [], rowCount: 0 }; }
      if (text === 'ROLLBACK') { rolledBack = true; return { rows: [], rowCount: 0 }; }
      if (/SELECT id FROM seller_users/.test(text)) return { rows: [{ id: 'seller-1' }], rowCount: 1 };
      if (/FROM orders o JOIN receipts/.test(text)) return { rows: [], rowCount: 0 };
      if (/SELECT id, items, total_cents/.test(text)) return { rows: [{
        id: 'order-1', items: [{ product_id: 'ram-1', quantity: 3 }], total_cents: 3000,
        discount_percent: 0, status: 'requested', version: 1
      }], rowCount: 1 };
      if (/FROM pending_actions WHERE idempotency_key/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM mandates WHERE state = 'active'/.test(text)) return { rows: [{
        max_items: 5, max_total_cents: 10000, max_discount_percent: 10,
        min_remaining_stock: 2, state: 'active', version: 1
      }], rowCount: 1 };
      if (/SELECT id, stock, version FROM products/.test(text)) return { rows: [{ id: 'ram-1', stock: 5, version: 1 }], rowCount: 1 };
      if (/UPDATE orders SET status = 'accepted'/.test(text)) return { rows: [{ id: 'order-1' }], rowCount: 1 };
      if (/UPDATE products SET stock/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO receipts/.test(text)) {
        receiptInserted = true;
        return { rows: [{ body: { receipt_id: 'receipt-1' }, issued_at: now, version: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const repository = createPostgresRepository({ pool: { connect: async () => client } });

  const result = await repository.acceptOrder('order-1', 3, 'accept-key-1', 'seller-hash', now);
  assert.deepEqual(result, { error: 'STALE' });
  assert.equal(rolledBack, true);
  assert.equal(committed, false);
  assert.equal(receiptInserted, false);
});

test('migration 010 detaches durable orders from expiring buyer sessions', async () => {
  const migration = await readFile(new URL('../netlify/database/migrations/010_order-retention/migration.sql', import.meta.url), 'utf8').catch(() => '');
  assert.match(migration, /ALTER COLUMN buyer_session_id DROP NOT NULL/i);
  assert.match(migration, /REFERENCES buyer_sessions\(id\) ON DELETE SET NULL/i);
});

test('provider logs use constant messages without caught error details', async () => {
  const directory = new URL('../netlify/functions/', import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.mjs'));
  const source = (await Promise.all(files.map(name => readFile(new URL(name, directory), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /console\.error\([^\n]*(?:caught|error)\.message/);
});
