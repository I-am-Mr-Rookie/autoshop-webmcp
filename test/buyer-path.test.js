import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as app from '../public/app.js';

test('buyer portal exposes catalogue, cart, submission, status, and reset controls', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['product-search', 'buyer-products', 'buyer-cart', 'buyer-submit-order', 'buyer-order-status', 'reset-demo']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('buyer WebMCP tools use the buyer APIs and return bounded results', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.document = {};
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('/api/buyer?')) return new Response(JSON.stringify({
      ok: true,
      products: [{ id: 'ram-1', name: '16GB DDR5 Kit', price_cents: 4900, stock: 12 }],
      cart: { items: [], total_cents: 0, version: 1 }
    }));
    if (url === '/api/buyer') return new Response(JSON.stringify({
      ok: true, cart: { items: [{ product_id: 'ram-1', quantity: 3 }], total_cents: 14700, version: 2 }
    }));
    return new Response(JSON.stringify({
      ok: true, replayed: false, order: { order_id: 'order_demo', status: 'requested', total_cents: 14700, version: 1 }
    }), { status: 201 });
  };

  try {
    assert.deepEqual(await app.BUYER_TOOLS[0].execute({ query: 'ddr', limit: 1 }), {
      ok: true, products: [{ id: 'ram-1', name: '16GB DDR5 Kit', price_cents: 4900, stock: 12 }]
    });
    assert.equal((await app.BUYER_TOOLS[1].execute({ action: 'add', product_id: 'ram-1', quantity: 3 })).cart.version, 2);
    assert.equal((await app.BUYER_TOOLS[2].execute({ order_id: 'order_demo', confirm_token: 'a'.repeat(64) })).order.status, 'requested');
    assert.match(calls[0].url, /^\/api\/buyer\?query=ddr&limit=1$/);
    assert.deepEqual(JSON.parse(calls[1].options.body), { action: 'add', product_id: 'ram-1', quantity: 3 });
    assert.deepEqual(JSON.parse(calls[2].options.body), { order_id: 'order_demo', confirm_token: 'a'.repeat(64) });
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});

test('demo reset sends only the explicit reset confirmation', async () => {
  let request;
  const result = await app.resetDemoData(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, products: 3, mandateVersion: 1, sellerUsers: 1 }));
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, '/api/demo-data/reset');
  assert.deepEqual(JSON.parse(request.options.body), { confirm: 'RESET' });
});
