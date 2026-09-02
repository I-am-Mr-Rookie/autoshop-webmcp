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
  await assert.rejects(() => registered.tool.execute({ extra: true }), /empty object only/);
  assert.equal(registered.options.signal.aborted, false);
  cleanup();
  assert.equal(registered.options.signal.aborted, true);
  unregister();
});

test('seller registration is absent from buyer and aborts on exit', async () => {
  assert.equal(typeof app.registerRoleTools, 'function');

  let buyerRegistrations = 0;
  const buyerStop = await app.registerRoleTools({ registerTool: async () => { buyerRegistrations += 1; } }, '/buyer', () => {});
  assert.equal(buyerRegistrations, 0);
  buyerStop();

  let registered;
  let cleanup;
  const sellerStop = await app.registerRoleTools(
    { registerTool: async (tool, options) => { registered = { tool, options }; } },
    '/seller',
    handler => { cleanup = handler; }
  );
  assert.equal(registered.tool.name, 'get_mandate');
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
    let buyer;
    let seller;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        buyer = await fetch(`http://127.0.0.1:${port}/buyer`);
        seller = await fetch(`http://127.0.0.1:${port}/seller`);
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.ok(buyer && seller, 'server did not become reachable');
    assert.equal(buyer.status, 200);
    assert.equal(seller.status, 200);
  } finally {
    server.kill();
  }
});
