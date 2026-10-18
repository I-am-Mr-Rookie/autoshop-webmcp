import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { scopedDatabase } from '../database.mjs';
import { currentShop, shopSchema, withShop } from '../shop-context.mjs';
import { provisionShop } from '../shop-provision.mjs';
import { createPostgresRepository } from '../functions/_shared/postgres-repository.mjs';
import { resetDemoData } from '../persistence.js';
import { createAppServer } from '../server.js';

test('verified account context survives concurrent requests and ignores arbitrary schema strings', async () => {
  assert.throws(() => shopSchema('public; DROP SCHEMA public CASCADE'));
  assert.throws(() => scopedDatabase({}, 'public'));
  const users = ['user_alpha', 'user_beta'];
  await Promise.all(users.map(userId => withShop({ userId }, async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(currentShop().schema, shopSchema(userId));
  })));
  assert.equal(currentShop(), undefined);
  assert.notEqual(shopSchema(users[0]), shopSchema(users[1]));
});

test('real PostgreSQL isolates inventory, orders, sessions, approvals, receipts and resets by Google account', async () => {
  const pg = new PGlite();
  // PGlite has a single engine. Serialize leases, just as a one-connection pg.Pool would.
  let tail = Promise.resolve();
  const query = async (sql, params) => {
    const result = params === undefined ? (await pg.exec(sql)).at(-1) : await pg.query(sql, params);
    return { rows: result?.rows ?? [], rowCount: result?.affectedRows || result?.rows?.length || 0 };
  };
  const db = { pool: { connect: async () => {
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    return { query, release: unlock };
  } } };
  const a = shopSchema('user_alpha');
  const b = shopSchema('user_beta');
  try {
    await provisionShop(a, db);
    await provisionShop(b, db);
    const da = scopedDatabase(db, a);
    const dbeta = scopedDatabase(db, b);
    const ra = createPostgresRepository(da);
    const rb = createPostgresRepository(dbeta);
    const now = new Date();
    await ra.createSellerSession('seller-1', 'a'.repeat(64), new Date(now.getTime() + 3600000));
    assert.equal((await ra.findSellerSession('a'.repeat(64), now)).username, 'seller');
    assert.equal(await rb.findSellerSession('a'.repeat(64), now), null);
    await ra.createBuyerSession('b'.repeat(64), new Date(now.getTime() + 3600000));
    assert.equal(await rb.findBuyerSession('b'.repeat(64), now), null);
    await da.pool.query("UPDATE products SET stock=3 WHERE id='ram-1'");
    assert.equal((await dbeta.pool.query("SELECT stock FROM products WHERE id='ram-1'")).rows[0].stock, 12);
    // The same local IDs can exist independently; none of these tables resolves through public.
    await da.pool.query("INSERT INTO orders (id,items,total_cents,status,version) VALUES ('order_private','[]',0,'requested',1)");
    await da.pool.query("INSERT INTO pending_actions (id,order_id,mandate_version,quantity,snapshot,state,version) VALUES ('action_private','order_private',1,1,'{}','pending',1)");
    await da.pool.query("INSERT INTO approval_tokens (id,action_id,token_hash,expires_at,state,version) VALUES ('approval_private','action_private',$1,NOW()+INTERVAL '1 hour','active',1)", ['c'.repeat(64)]);
    await da.pool.query("INSERT INTO receipts (id,order_id,body,version) VALUES ('receipt_private','order_private','{}',1)");
    for (const table of ['orders','pending_actions','approval_tokens','receipts']) {
      assert.equal((await dbeta.pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    await resetDemoData(rb);
    assert.equal((await da.pool.query("SELECT stock FROM products WHERE id='ram-1'")).rows[0].stock, 3);
    assert.equal((await da.pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 1);
    await provisionShop(a, db); // Idempotent provisioning must not restore sold inventory.
    assert.equal((await da.pool.query("SELECT stock FROM products WHERE id='ram-1'")).rows[0].stock, 3);
    // A failed transaction must be rolled back and search_path reset before the next lease.
    const client = await da.pool.connect();
    await client.query('BEGIN');
    await assert.rejects(client.query('SELECT missing_column FROM products'));
    await client.release();
    const base = await db.pool.connect();
    assert.notEqual((await base.query('SHOW search_path')).rows[0].search_path, a);
    base.release();
    assert.equal((await rb.listProducts('', 8)).length, 3);
  } finally { await tail; await pg.close(); }
});

test('HTTP guard rejects anonymous, forged and cross-origin calls before provisioning a shop', async t => {
  let provisions = 0;
  const config = { method: ['GET', 'POST'] };
  const server = createAppServer({ origin: 'https://demo.example',
    routes: new Map([['/api/test-shop', { config, default: () => Response.json({ schema: currentShop().schema }) }]]),
    authenticate: async request => request.headers.get('authorization') === 'Bearer verified-test-token'
      ? { userId: 'user_alpha', sessionId: 'sess_test' } : null,
    provisionShop: async () => { provisions++; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/test-shop`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer forged', 'x-shop-schema': shopSchema('user_beta') } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer verified-test-token', origin: 'https://attacker.example' } })).status, 403);
  assert.equal(provisions, 0);
  const response = await fetch(url, { headers: { authorization: 'Bearer verified-test-token', 'x-shop-schema': shopSchema('user_beta') } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).schema, shopSchema('user_alpha'));
  assert.equal(provisions, 1);
});
