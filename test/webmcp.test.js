import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as app from '../public/app.js';

test('get_mandate is strict, bounded, read-only, and cleaned up', async () => {
  let registered;
  let cleanup;
  const modelContext = { registerTool: async (tool, options) => { registered = { tool, options }; } };

  const unregister = await app.registerGetMandate(modelContext, handler => { cleanup = handler; });

  assert.equal(registered.tool.name, 'get_mandate');
  assert.deepEqual(registered.tool.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(registered.tool.annotations, { readOnlyHint: true, untrustedContentHint: false });
  assert.deepEqual(await registered.tool.execute({}), app.MANDATE);
  assert.deepEqual(app.MANDATE_OUTPUT_SCHEMA.required, Object.keys(app.MANDATE));
  assert.deepEqual(await registered.tool.execute({ extra: true }), {
    ok: false,
    error: { code: 'VALIDATION', message: 'Input does not match the tool contract.', retryable: false }
  });
  assert.equal(registered.options.signal.aborted, false);
  cleanup();
  assert.equal(registered.options.signal.aborted, true);
  unregister();
});

test('get_mandate refreshes through the authenticated seller API in a browser', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const live = { ...app.MANDATE, mandate_version: 2, max_items_per_order: 3 };
  let requested;
  globalThis.document = {};
  globalThis.fetch = async url => {
    requested = url;
    return new Response(JSON.stringify({ ok: true, mandate: live }));
  };
  try {
    assert.deepEqual(await app.GET_MANDATE_TOOL.execute({}), live);
    assert.equal(requested, '/api/seller/mandate');
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});

test('role registration stays isolated and aborts on exit', async () => {
  assert.equal(typeof app.registerRoleTools, 'function');

  const buyerTools = [];
  const buyerStop = await app.registerRoleTools({ registerTool: async tool => { buyerTools.push(tool.name); } }, '/buyer', () => {});
  assert.deepEqual(buyerTools, ['browse_products', 'manage_cart', 'submit_order']);
  assert.ok(!buyerTools.includes('get_mandate'));
  buyerStop();

  const sellerTools = [];
  let registered;
  let cleanup;
  const sellerStop = await app.registerRoleTools(
    { registerTool: async (tool, options) => { sellerTools.push(tool.name); registered = { tool, options }; } },
    '/seller',
    handler => { cleanup = handler; }
  );
  assert.deepEqual(sellerTools, ['get_mandate', 'list_orders', 'accept_order', 'commit_action']);
  assert.ok(!sellerTools.includes('browse_products'));
  assert.equal(registered.options.signal.aborted, false);
  sellerStop();
  assert.equal(registered.options.signal.aborted, true);
  cleanup();
});

test('buyer and seller routes serve the portal page', async () => {
  // ponytail: fixed port keeps this test tiny; allocate dynamically if tests ever run in parallel.
  const port = 31606;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });

  try {
    let home;
    let buyer;
    let seller;
    let hero;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        home = await fetch(`http://127.0.0.1:${port}/`);
        buyer = await fetch(`http://127.0.0.1:${port}/buyer`);
        seller = await fetch(`http://127.0.0.1:${port}/seller`);
        hero = await fetch(`http://127.0.0.1:${port}/img/hero-circuit.svg`);
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.ok(home && buyer && seller && hero, 'server did not become reachable');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>AutoShop/);
    assert.equal(buyer.status, 200);
    assert.equal(seller.status, 200);
    assert.equal(hero.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  } finally {
    server.kill();
  }
});
