import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, securityHeaders } from '../server.js';
import { createAcceptHandler, config } from '../functions/seller-accept.mjs';

test('Railway HTTP adapter preserves HTTPS origin, cookies, authorization, and security headers', async t => {
  const origin = 'https://autoshop.example';
  let mutations = 0;
  const handler = createAcceptHandler(async () => ({
    findSellerSession: async () => ({ username: 'seller' }),
    acceptOrder: async () => { mutations++; return { replayed: false, receipt: { receipt_id: 'receipt-1' } }; }
  }));
  const routes = new Map([[config.path, { config, default: handler }], ['/api/cookies', {
    config: { method: ['GET'] }, default: () => new Response('ok', { headers: [
      ['Set-Cookie', 'first=one; Secure; HttpOnly'], ['Set-Cookie', 'second=two; Secure; HttpOnly']
    ] })
  }]]);
  const server = createAppServer({ origin, routes, healthcheck: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = suppliedOrigin => fetch(base + config.path, { method: 'POST', headers: {
    origin: suppliedOrigin, 'Content-Type': 'application/json', cookie: `__Host-autoshop_seller=${'a'.repeat(64)}`
  }, body: JSON.stringify({ order_id: 'order-1', quantity: 1, idempotency_key: 'migration-check-1' }) });
  assert.equal((await request('https://attacker.example')).status, 403);
  assert.equal(mutations, 0);
  const accepted = await request(origin);
  assert.equal(accepted.status, 201);
  assert.equal(mutations, 1);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(accepted.headers.get(name), value);
  assert.equal((await fetch(base + '/api/cookies')).headers.getSetCookie().length, 2);
  assert.equal((await fetch(base + config.path)).status, 405);
  assert.equal((await fetch(base + '/api/missing')).status, 404);
  assert.equal((await fetch(base + config.path, { method: 'POST', body: 'x'.repeat(65537) })).status, 413);
  for (const path of ['/', '/buyer', '/seller', '/app.js', '/healthz']) assert.equal((await fetch(base + path)).status, 200);
  for (const path of ['/%2e%2e%2fpackage.json', '/%2f..%2fpackage.json', '/_redirects']) assert.equal((await fetch(base + path)).status, 404);
});
