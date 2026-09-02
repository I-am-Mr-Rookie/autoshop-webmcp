import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, hashSessionToken } from '../netlify/functions/buyer.mjs';

const products = [
  { id: 'cpu-1', name: 'Ryzen 5 7600', price_cents: 18900, stock: 10 },
  { id: 'ram-1', name: '16GB DDR5 Kit', price_cents: 4900, stock: 12 }
];

const memoryRepository = () => {
  const sessions = new Map();
  const carts = new Map();
  const readCart = id => {
    const cart = carts.get(id);
    return cart && {
      ...cart,
      total_cents: cart.items.reduce((total, item) => total + products.find(product => product.id === item.product_id).price_cents * item.quantity, 0)
    };
  };
  return {
    sessions,
    async createBuyerSession(id, expiresAt) {
      sessions.set(id, { id, expires_at: expiresAt.toISOString() });
      carts.set(id, { items: [], version: 1 });
    },
    async findBuyerSession(id, now) {
      const session = sessions.get(id);
      if (!session || new Date(session.expires_at) <= now) {
        sessions.delete(id);
        carts.delete(id);
        return null;
      }
      return session;
    },
    async listProducts(query, limit) {
      return products.filter(product => product.name.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
    },
    async getCart(id) { return readCart(id); },
    async mutateCart(id, _now, { action, productId, quantity }) {
      const cart = carts.get(id);
      const product = products.find(candidate => candidate.id === productId);
      if (!product) return null;
      const current = cart.items.find(item => item.product_id === productId);
      if (action === 'remove') cart.items = cart.items.filter(item => item.product_id !== productId);
      else if (current) current.quantity = action === 'add' ? current.quantity + quantity : quantity;
      else cart.items.push({ product_id: productId, quantity });
      cart.version += 1;
      return readCart(id);
    }
  };
};

test('creates a private 24-hour buyer session and reads a bounded catalogue', async () => {
  const repository = memoryRepository();
  const now = new Date('2026-09-02T12:00:00.000Z');
  const handler = createHandler(async () => repository, {
    now: () => now,
    createToken: () => 'a'.repeat(64)
  });

  const response = await handler(new Request('https://example.test/api/buyer?query=ddr&limit=1'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^autoshop_buyer=a{64}; Max-Age=86400; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.deepEqual(await response.json(), {
    ok: true,
    session_expires_at: '2026-09-03T12:00:00.000Z',
    mode: 'Ask',
    products: [{ id: 'ram-1', name: '16GB DDR5 Kit', price_cents: 4900, stock: 12 }],
    cart: { items: [], total_cents: 0, version: 1 }
  });
  assert.ok(repository.sessions.has(hashSessionToken('a'.repeat(64))));
});

test('mutates only the cookie-bound cart and replaces an expired session', async () => {
  const repository = memoryRepository();
  let now = new Date('2026-09-02T12:00:00.000Z');
  let token = 'b'.repeat(64);
  const handler = createHandler(async () => repository, { now: () => now, createToken: () => token });

  const first = await handler(new Request('https://example.test/api/buyer'));
  const cookie = first.headers.get('set-cookie').split(';', 1)[0];
  const added = await handler(new Request('https://example.test/api/buyer', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'add', product_id: 'ram-1', quantity: 2 })
  }));
  assert.deepEqual(await added.json(), {
    ok: true,
    cart: { items: [{ product_id: 'ram-1', quantity: 2 }], total_cents: 9800, version: 2 }
  });

  const set = await handler(new Request('https://example.test/api/buyer', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'set', product_id: 'ram-1', quantity: 3 })
  }));
  assert.deepEqual((await set.json()).cart, {
    items: [{ product_id: 'ram-1', quantity: 3 }], total_cents: 14700, version: 3
  });
  const removed = await handler(new Request('https://example.test/api/buyer', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'remove', product_id: 'ram-1', quantity: 1 })
  }));
  assert.deepEqual((await removed.json()).cart, { items: [], total_cents: 0, version: 4 });

  now = new Date('2026-09-03T12:00:00.001Z');
  token = 'c'.repeat(64);
  const expired = await handler(new Request('https://example.test/api/buyer', { headers: { cookie } }));
  assert.match(expired.headers.get('set-cookie'), /autoshop_buyer=c{64}/);
  assert.equal(repository.sessions.has(hashSessionToken('b'.repeat(64))), false);
});

test('rejects malformed catalogue and cart input without mutation', async () => {
  const repository = memoryRepository();
  const handler = createHandler(async () => repository, { createToken: () => 'd'.repeat(64) });

  const badQuery = await handler(new Request('https://example.test/api/buyer?limit=9'));
  assert.equal(badQuery.status, 400);
  assert.equal(repository.sessions.size, 0);

  const badCart = await handler(new Request('https://example.test/api/buyer', {
    method: 'POST', body: JSON.stringify({ action: 'add', product_id: 'ram-1', quantity: 2, extra: true })
  }));
  assert.equal(badCart.status, 400);
  assert.deepEqual(await badCart.json(), {
    ok: false,
    error: { code: 'VALIDATION', message: 'Input does not match the buyer API contract.' }
  });
  assert.equal(repository.sessions.size, 0);
});
