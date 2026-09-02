import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createConfirmationHandler, hashConfirmationToken } from '../netlify/functions/buyer-confirm.mjs';
import { requestBuyerConfirmation } from '../public/app.js';

const memoryRepository = (sessionId = 'session-hash') => {
  const sessions = new Map([[sessionId, { id: sessionId, expires_at: '2026-09-03T12:00:00.000Z' }]]);
  const carts = new Map([[sessionId, { items: [{ product_id: 'ram-1', quantity: 2 }], version: 4 }]]);
  return {
    sessions,
    confirmations: [],
    async findBuyerSession(id, now) {
      const session = sessions.get(id);
      return session && new Date(session.expires_at) > now ? session : null;
    },
    async getCart(id) { return carts.get(id) ?? null; },
    async confirmBuyer(id, now, confirmation) {
      if (!sessions.has(id) || !carts.get(id)?.items.length) return { error: 'EMPTY_CART' };
      if (carts.get(id).version !== confirmation.reviewedCartVersion) return { error: 'STALE' };
      const stored = { sessionId: id, now, ...confirmation, cartVersion: carts.get(id).version };
      this.confirmations = [stored];
      Object.assign(sessions.get(id), stored);
      return { mode: confirmation.mode, cart_version: carts.get(id).version, expires_at: confirmation.expiresAt.toISOString() };
    }
  };
};

test('visible buyer confirmation defaults to Ask and requires an explicit button', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<input[^>]+name="mode"[^>]+value="Ask"[^>]+checked/);
  assert.match(html, /<input[^>]+name="mode"[^>]+value="Auto"/);
  assert.match(html, /name="buyer_name"[^>]+required/);
  assert.match(html, /name="buyer_email"[^>]+type="email"[^>]+required/);
  assert.match(html, /name="buyer_country"[^>]+required/);
  assert.match(html, /<button[^>]+type="submit"[^>]*>Confirm buyer and authorize order<\/button>/);
});

test('mints one cart-scoped finalization authorization after visible confirmation', async () => {
  const now = new Date('2026-09-02T12:00:00.000Z');
  const rawSession = 'a'.repeat(64);
  const repository = memoryRepository(hashConfirmationToken(rawSession));

  const handler = createConfirmationHandler(async () => repository, {
    now: () => now,
    createToken: () => 'b'.repeat(64),
    createOrderId: () => 'order_demo'
  });
  const response = await handler(new Request('https://example.test/api/buyer/confirm', {
    method: 'POST',
    headers: { cookie: `autoshop_buyer=${rawSession}` },
    body: JSON.stringify({ mode: 'Auto', buyer_name: 'Koushik', buyer_email: 'buyer@example.test', buyer_country: 'BD', cart_version: 4 })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    mode: 'Auto',
    cart_version: 4,
    order_id: 'order_demo',
    confirm_token: 'b'.repeat(64),
    confirmation_expires_at: '2026-09-02T12:10:00.000Z'
  });
  assert.equal(repository.confirmations.length, 1);
  assert.equal(repository.confirmations[0].tokenHash, hashConfirmationToken('b'.repeat(64)));
  assert.equal(JSON.stringify(repository.confirmations).includes('b'.repeat(64)), false);
  assert.equal(repository.confirmations[0].cartVersion, 4);
  assert.equal(repository.confirmations[0].orderId, 'order_demo');
});

test('rejects missing sessions, empty carts, and malformed confirmation without minting', async () => {
  const validSession = 'e'.repeat(64);
  const repository = memoryRepository(hashConfirmationToken(validSession));
  const handler = createConfirmationHandler(async () => repository, { createToken: () => 'c'.repeat(64) });

  const malformed = await handler(new Request('https://example.test/api/buyer/confirm', {
    method: 'POST',
    body: JSON.stringify({ mode: 'Agent', buyer_name: '', buyer_email: 'nope', buyer_country: 'Bangladesh', confirmed: true })
  }));
  assert.equal(malformed.status, 400);

  const missing = await handler(new Request('https://example.test/api/buyer/confirm', {
    method: 'POST',
    headers: { cookie: `autoshop_buyer=${'d'.repeat(64)}` },
    body: JSON.stringify({ mode: 'Ask', buyer_name: 'Buyer', buyer_email: 'buyer@example.test', buyer_country: 'BD', cart_version: 4 })
  }));
  assert.equal(missing.status, 401);

  repository.confirmBuyer = async () => ({ error: 'EMPTY_CART' });
  const empty = await handler(new Request('https://example.test/api/buyer/confirm', {
    method: 'POST',
    headers: { cookie: `autoshop_buyer=${validSession}` },
    body: JSON.stringify({ mode: 'Ask', buyer_name: 'Buyer', buyer_email: 'buyer@example.test', buyer_country: 'BD', cart_version: 4 })
  }));
  assert.equal(empty.status, 409);
  assert.equal((await empty.json()).error.code, 'EMPTY_CART');

  repository.confirmBuyer = async () => ({ error: 'STALE' });
  const stale = await handler(new Request('https://example.test/api/buyer/confirm', {
    method: 'POST',
    headers: { cookie: `autoshop_buyer=${validSession}` },
    body: JSON.stringify({ mode: 'Ask', buyer_name: 'Buyer', buyer_email: 'buyer@example.test', buyer_country: 'BD', cart_version: 3 })
  }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'STALE');
  assert.equal(repository.confirmations.length, 0);
});

test('buyer form posts the selected Ask or Auto mode and keeps the token out of visible copy', async () => {
  let request;
  const result = await requestBuyerConfirmation(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      ok: true,
      mode: 'Auto',
      cart_version: 4,
      order_id: 'order_demo',
      confirm_token: 'f'.repeat(64),
      confirmation_expires_at: '2026-09-02T12:10:00.000Z'
    }));
  }, { mode: 'Auto', buyer_name: 'Buyer', buyer_email: 'buyer@example.test', buyer_country: 'BD', cart_version: 4 });

  assert.equal(request.url, '/api/buyer/confirm');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    mode: 'Auto', buyer_name: 'Buyer', buyer_email: 'buyer@example.test', buyer_country: 'BD', cart_version: 4
  });
  assert.equal(result.message, 'Auto authority confirmed for cart version 4. Final order submission still requires this one-time authorization.');
  assert.equal(result.message.includes('f'.repeat(64)), false);
});
