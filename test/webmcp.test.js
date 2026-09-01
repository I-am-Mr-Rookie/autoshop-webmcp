import test from 'node:test';
import assert from 'node:assert/strict';
import { GET_MANDATE_TOOL, MANDATE, MANDATE_OUTPUT_SCHEMA, registerGetMandate } from '../public/app.js';

test('get_mandate is strict, bounded, read-only, and cleaned up', async () => {
  let registered;
  let cleanup;
  const modelContext = { registerTool: async (tool, options) => { registered = { tool, options }; } };

  const unregister = await registerGetMandate(modelContext, handler => { cleanup = handler; });

  assert.equal(registered.tool.name, 'get_mandate');
  assert.deepEqual(registered.tool.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(registered.tool.annotations, { readOnlyHint: true, untrustedContentHint: false });
  assert.deepEqual(await registered.tool.execute({}), MANDATE);
  assert.deepEqual(MANDATE_OUTPUT_SCHEMA.required, Object.keys(MANDATE));
  await assert.rejects(() => registered.tool.execute({ extra: true }), /empty object only/);
  assert.equal(registered.options.signal.aborted, false);
  cleanup();
  assert.equal(registered.options.signal.aborted, true);
  unregister();
});
