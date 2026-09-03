import test from 'node:test';
import assert from 'node:assert/strict';
import * as app from '../public/app.js';

const validInputs = {
  browse_products: {},
  manage_cart: { action: 'add', product_id: 'cpu-1', quantity: 6 },
  submit_order: { order_id: 'order_1' },
  get_mandate: {},
  list_orders: {},
  accept_order: { order_id: 'order_1', quantity: 6, idempotency_key: 'request-1' },
  commit_action: { action_id: 'action_1', idempotency_key: 'request-2' }
};

test('freezes seven strict role-scoped tool contracts', () => {
  assert.deepEqual(app.BUYER_TOOLS.map(tool => tool.name), ['browse_products', 'manage_cart', 'submit_order']);
  assert.deepEqual(app.SELLER_TOOLS.map(tool => tool.name), ['get_mandate', 'list_orders', 'accept_order', 'commit_action']);

  for (const tool of [...app.BUYER_TOOLS, ...app.SELLER_TOOLS]) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length <= 240);
    assert.deepEqual(Object.keys(tool.annotations).sort(), ['readOnlyHint', 'untrustedContentHint']);
  }

  assert.equal(app.BUYER_TOOLS[0].inputSchema.properties.limit.maximum, 8);
  assert.equal(app.SELLER_TOOLS[1].inputSchema.properties.limit.maximum, 5);
  assert.equal(app.SELLER_TOOLS[1].annotations.untrustedContentHint, true);
  assert.equal(app.BUYER_TOOLS[0].annotations.readOnlyHint, true);
  assert.equal(app.SELLER_TOOLS[0].annotations.readOnlyHint, true);
  assert.equal(Object.hasOwn(app.BUYER_TOOLS[2].inputSchema.properties, 'confirm_token'), false);
  assert.equal(Object.hasOwn(app.SELLER_TOOLS[3].inputSchema.properties, 'confirm_token'), false);
});

test('runtime validation returns bounded structured errors', async () => {
  for (const tool of [...app.BUYER_TOOLS, ...app.SELLER_TOOLS]) {
    const invalid = await tool.execute({ ...validInputs[tool.name], extra: true });
    assert.deepEqual(invalid, {
      ok: false,
      error: { code: 'VALIDATION', message: 'Input does not match the tool contract.', retryable: false }
    });

    const result = await tool.execute(validInputs[tool.name]);
    if (tool.name === 'get_mandate') assert.deepEqual(result, app.MANDATE);
    else assert.deepEqual(result, {
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'This operation is not available yet.', retryable: true }
    });
  }

  assert.deepEqual(await app.BUYER_TOOLS[0].execute({ toString: 'not-a-declared-field' }), {
    ok: false,
    error: { code: 'VALIDATION', message: 'Input does not match the tool contract.', retryable: false }
  });
  for (const invalid of [
    { action: 'add', product_id: 'cpu-1' },
    { action: 'add', product_id: 'cpu-1', quantity: 21 },
    Object.create({ action: 'add', product_id: 'cpu-1', quantity: 1 })
  ]) assert.deepEqual(await app.BUYER_TOOLS[1].execute(invalid), {
    ok: false,
    error: { code: 'VALIDATION', message: 'Input does not match the tool contract.', retryable: false }
  });
});

test('forbids cross-role registrations and cleans up the active role', async () => {
  const registrations = [];
  let cleanup;
  const modelContext = { registerTool: async (tool, options) => registrations.push({ tool, options }) };

  const stopBuyer = await app.registerRoleTools(modelContext, '/buyer', handler => { cleanup = handler; });
  assert.deepEqual(registrations.map(({ tool }) => tool.name), ['browse_products', 'manage_cart', 'submit_order']);
  assert.equal(registrations.some(({ tool }) => tool.name === 'get_mandate'), false);
  assert.equal(new Set(registrations.map(({ options }) => options.signal)).size, 1);
  cleanup();
  assert.ok(registrations.every(({ options }) => options.signal.aborted));
  stopBuyer();

  registrations.length = 0;
  const stopSeller = await app.registerRoleTools(modelContext, '/seller', () => {});
  assert.deepEqual(registrations.map(({ tool }) => tool.name), ['get_mandate', 'list_orders', 'accept_order', 'commit_action']);
  assert.equal(registrations.some(({ tool }) => tool.name === 'browse_products'), false);
  stopSeller();

  registrations.length = 0;
  const stopUnknown = await app.registerRoleTools(modelContext, '/api', () => assert.fail('cleanup registered for an unauthorized route'));
  assert.deepEqual(registrations, []);
  stopUnknown();
});

test('aborts earlier registrations when a later registration fails', async () => {
  let firstSignal;
  let calls = 0;
  const modelContext = {
    registerTool: async (_tool, options) => {
      calls += 1;
      firstSignal ??= options.signal;
      if (calls === 2) throw new Error('registration failed');
    }
  };

  await assert.rejects(() => app.registerRoleTools(modelContext, '/buyer', () => {}), /registration failed/);
  assert.equal(firstSignal.aborted, true);
});
