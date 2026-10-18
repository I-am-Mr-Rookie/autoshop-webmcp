import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresRepository } from '../functions/_shared/postgres-repository.mjs';
import { resetDemoData } from '../persistence.js';

// Real PostgreSQL (WASM) so the repository SQL, constraints and migrations run as in production.
const sellerPasswordHash = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
const hex = char => char.repeat(64);

// One engine per file (boot is slow); every test reseeds through the repository's own TRUNCATE.
const pglite = new PGlite();
const directory = new URL('../migrations/', import.meta.url);
for (const name of (await readdir(directory)).filter(name => /^\d+_/.test(name)).sort()) {
  await pglite.exec(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
}
const query = async (text, params) => {
  const result = await pglite.query(text, params);
  return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
};
// shortcut: one shared connection, so tests must await each call; concurrency is not exercised here.
const db = { pool: { query, connect: async () => ({ query, release() {} }) } };

const setup = async () => {
  const repository = createPostgresRepository(db);
  await resetDemoData(repository, sellerPasswordHash);
  const now = new Date();
  await repository.createSellerSession('seller-1', hex('a'), new Date(now.getTime() + 3600000));
  return { query, repository, seller: hex('a') };
};

const submitOrder = async (repository, sessionId, items) => {
  const now = new Date();
  await repository.createBuyerSession(sessionId, new Date(now.getTime() + 86400000));
  let cart;
  for (const [productId, quantity] of items) cart = await repository.mutateCart(sessionId, now, { action: 'add', productId, quantity });
  const orderId = `order_${sessionId.slice(0, 8)}`;
  const confirmed = await repository.confirmBuyer(sessionId, now, {
    mode: 'Auto', buyerName: 'Test', buyerEmail: 't@example.test', buyerCountry: 'Nowhere',
    orderId, tokenHash: hex('c'), expiresAt: new Date(now.getTime() + 600000), reviewedCartVersion: cart.version
  });
  assert.equal(confirmed.error, undefined);
  const submitted = await repository.submitOrder(sessionId, now, orderId, hex('c'));
  assert.equal(submitted.replayed, false);
  return orderId;
};

const stock = async (query, id) => (await query('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock;

test('migrations apply and the seeded catalogue and mandate read back', async () => {
  const { repository } = await setup();
  assert.deepEqual((await repository.listProducts('', 8)).map(product => product.id), ['cpu-1', 'ram-1', 'ssd-1']);
  assert.deepEqual((await repository.listProducts('ddr', 8)).map(product => product.id), ['ram-1']);
  assert.deepEqual(await repository.listProducts('_', 8), []);
  assert.deepEqual(await repository.listProducts('100%', 8), []);
  assert.equal((await repository.getMandate()).max_items_per_order, 5);
});

test('buyer submission snapshots the cart, empties it and replays idempotently', async () => {
  const { repository, query } = await setup();
  const orderId = await submitOrder(repository, hex('1'), [['ram-1', 2], ['ssd-1', 1]]);
  const order = await repository.getOrder(hex('1'), orderId);
  assert.equal(order.status, 'requested');
  assert.equal(order.total_cents, 2 * 4900 + 6900);
  assert.deepEqual((await repository.getCart(hex('1'))).items, []);

  const replay = await repository.submitOrder(hex('1'), new Date(), orderId, hex('c'));
  assert.equal(replay.replayed, true);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 1);

  await repository.createBuyerSession(hex('2'), new Date(Date.now() + 86400000));
  assert.deepEqual(await repository.submitOrder(hex('2'), new Date(), orderId, hex('c')), { error: 'FORBIDDEN' });
});

test('a cart change after confirmation makes the confirmation stale', async () => {
  const { repository } = await setup();
  const now = new Date();
  await repository.createBuyerSession(hex('1'), new Date(now.getTime() + 86400000));
  const cart = await repository.mutateCart(hex('1'), now, { action: 'add', productId: 'ram-1', quantity: 1 });
  assert.deepEqual(await repository.confirmBuyer(hex('1'), now, {
    mode: 'Ask', buyerName: 'T', buyerEmail: 't@e.st', buyerCountry: 'X',
    orderId: 'order_x', tokenHash: hex('c'), expiresAt: new Date(now.getTime() + 600000), reviewedCartVersion: cart.version + 1
  }), { error: 'STALE' });
  assert.deepEqual(await repository.mutateCart(hex('1'), now, { action: 'add', productId: 'ram-1', quantity: 20 }), { error: 'QUANTITY' });
  assert.equal(await repository.mutateCart(hex('1'), now, { action: 'add', productId: 'nope', quantity: 1 }), null);
});

test('in-mandate acceptance decrements stock once and enforces idempotency keys', async () => {
  const { repository, query, seller } = await setup();
  const orderId = await submitOrder(repository, hex('1'), [['ram-1', 2]]);
  const accepted = await repository.acceptOrder(orderId, 2, 'key-accept-1', seller, new Date());
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.receipt.decision_path, 'mandate');
  assert.equal(await stock(query, 'ram-1'), 10);

  const replay = await repository.acceptOrder(orderId, 2, 'key-accept-1', seller, new Date());
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receipt_id, accepted.receipt.receipt_id);
  assert.equal(await stock(query, 'ram-1'), 10);
  assert.deepEqual(await repository.acceptOrder(orderId, 3, 'key-accept-1', seller, new Date()), { error: 'CONFLICT' });
  assert.deepEqual(await repository.acceptOrder(orderId, 2, 'key-accept-2', seller, new Date()), { error: 'STALE' });
  assert.deepEqual(await repository.acceptOrder(orderId, 2, 'key-accept-3', hex('b'), new Date()), { error: 'FORBIDDEN' });
});

test('out-of-mandate orders need an exact human approval before commit', async () => {
  const { repository, query, seller } = await setup();
  const orderId = await submitOrder(repository, hex('1'), [['ram-1', 6]]);
  const pending = await repository.acceptOrder(orderId, 6, 'key-accept-1', seller, new Date());
  assert.equal(pending.error, 'APPROVAL_REQUIRED');
  assert.equal(await stock(query, 'ram-1'), 12);
  const again = await repository.acceptOrder(orderId, 6, 'key-accept-2', seller, new Date());
  assert.equal(again.pendingAction.action_id, pending.pendingAction.action_id);

  const actionId = pending.pendingAction.action_id;
  assert.deepEqual(await repository.commitAction(actionId, hex('d'), 'key-commit-1', seller, new Date()), { error: 'STALE' });
  const approved = await repository.approveAction(actionId, hex('d'), new Date(Date.now() + 600000), seller, new Date());
  assert.equal(approved.approval.state, 'approved');
  assert.deepEqual(await repository.approveAction(actionId, hex('e'), new Date(Date.now() + 600000), seller, new Date()), { error: 'CONFLICT' });
  assert.deepEqual(await repository.commitAction(actionId, hex('e'), 'key-commit-1', seller, new Date()), { error: 'FORBIDDEN' });

  const committed = await repository.commitAction(actionId, hex('d'), 'key-commit-1', seller, new Date());
  assert.equal(committed.replayed, false);
  assert.equal(committed.receipt.decision_path, 'human_exception');
  assert.equal(await stock(query, 'ram-1'), 6);
  const replay = await repository.commitAction(actionId, hex('d'), 'key-commit-1', seller, new Date());
  assert.equal(replay.replayed, true);
  assert.equal(await stock(query, 'ram-1'), 6);

  const [listed] = await repository.listSellerOrders(seller, new Date(), 5);
  assert.equal(listed.status, 'accepted');
  assert.equal(listed.quantity, 6);
  assert.equal(listed.receipt.receipt_id, committed.receipt.receipt_id);
  assert.deepEqual(await repository.listSellerOrders(hex('b'), new Date(), 5), []);
});

test('an expired approval cannot commit and is marked expired', async () => {
  const { repository, query, seller } = await setup();
  const orderId = await submitOrder(repository, hex('1'), [['ram-1', 6]]);
  const { pendingAction } = await repository.acceptOrder(orderId, 6, 'key-accept-1', seller, new Date());
  await repository.approveAction(pendingAction.action_id, hex('d'), new Date(Date.now() + 1000), seller, new Date());
  const later = new Date(Date.now() + 2000);
  assert.deepEqual(await repository.commitAction(pendingAction.action_id, hex('d'), 'key-commit-1', seller, later), { error: 'EXPIRED_APPROVAL' });
  assert.equal((await query('SELECT state FROM approval_tokens')).rows[0].state, 'expired');
  assert.equal(await stock(query, 'ram-1'), 12);
});

test('a mandate change re-evaluates pending orders and invalidates their approvals', async () => {
  const { repository, query, seller } = await setup();
  const orderId = await submitOrder(repository, hex('1'), [['ram-1', 6]]);
  const { pendingAction } = await repository.acceptOrder(orderId, 6, 'key-accept-1', seller, new Date());
  await repository.approveAction(pendingAction.action_id, hex('d'), new Date(Date.now() + 600000), seller, new Date());

  const limits = { max_items_per_order: 10, max_total_cents: 100000, max_discount_percent: 10, min_stock_remaining: 2 };
  assert.equal((await repository.updateMandate(2, limits, seller, new Date())).error, 'STALE');
  const updated = await repository.updateMandate(1, limits, seller, new Date());
  assert.equal(updated.mandate.mandate_version, 2);
  assert.equal(updated.re_evaluated, 1);
  assert.equal(updated.eligible, 1);
  assert.equal((await query('SELECT state FROM approval_tokens')).rows[0].state, 'invalidated');
  assert.deepEqual(await repository.commitAction(pendingAction.action_id, hex('d'), 'key-commit-1', seller, new Date()), { error: 'STALE' });

  const accepted = await repository.acceptOrder(orderId, 6, 'key-accept-2', seller, new Date());
  assert.equal(accepted.receipt.decision_path, 'mandate');
  assert.equal(accepted.receipt.mandate_version, 2);
  assert.equal(await stock(query, 'ram-1'), 6);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM pending_actions WHERE state = 'committed'")).rows[0].n, 1);
});

test('expired buyer and seller sessions are swept without deleting orders', async () => {
  const { repository, query, seller } = await setup();
  const orderId = await submitOrder(repository, hex('1'), [['ram-1', 1]]);
  await query("UPDATE buyer_sessions SET expires_at = NOW() - INTERVAL '1 second'");
  await repository.createSellerSession('seller-1', hex('f'), new Date(Date.now() - 1000));
  await repository.createBuyerSession(hex('2'), new Date(Date.now() + 86400000));
  await repository.createSellerSession('seller-1', hex('9'), new Date(Date.now() + 3600000));

  assert.deepEqual((await query('SELECT id FROM buyer_sessions')).rows, [{ id: hex('2') }]);
  assert.deepEqual((await query('SELECT token_hash FROM seller_sessions ORDER BY token_hash')).rows.map(row => row.token_hash), [hex('9'), seller]);
  assert.deepEqual((await query('SELECT id, buyer_session_id FROM orders')).rows, [{ id: orderId, buyer_session_id: null }]);
});

test('repeated login failures lock the seller and a later failure restarts the count', async () => {
  const { repository } = await setup();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + 900000);
  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.equal((await repository.recordSellerLoginFailure('seller-1', now, 5, lockedUntil)).locked_until, null);
  }
  assert.equal((await repository.recordSellerLoginFailure('seller-1', now, 5, lockedUntil)).locked_until.getTime(), lockedUntil.getTime());
  const afterLock = new Date(lockedUntil.getTime() + 1000);
  assert.equal((await repository.recordSellerLoginFailure('seller-1', afterLock, 5, lockedUntil)).locked_until, null);
  assert.equal((await repository.findSeller('seller')).failed_login_count, 1);
});

test('a failed ROLLBACK does not hide the original transaction error', async () => {
  const lost = Object.assign(new Error('connection lost'), { code: '57P01' });
  const failing = (original) => ({ pool: { connect: async () => ({
    query: async text => {
      if (text === 'ROLLBACK') throw lost;
      if (text.trim().startsWith('INSERT') || text.includes('FOR UPDATE')) throw original;
      return { rows: [], rowCount: 0 };
    },
    release() {}
  }) } });
  const original = new Error('insert failed');
  await assert.rejects(createPostgresRepository(failing(original)).createBuyerSession(hex('1'), new Date()), original);
  const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
  assert.deepEqual(await createPostgresRepository(failing(duplicate)).acceptOrder('order_x', 1, 'key-accept-1', hex('a'), new Date()), { error: 'CONFLICT' });
});
