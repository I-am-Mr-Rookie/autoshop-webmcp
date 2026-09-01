export const MANDATE = Object.freeze({
  mandate_version: 1,
  currency: 'USD',
  max_items_per_order: 5,
  max_total_cents: 10000,
  max_discount_percent: 10,
  min_stock_remaining: 2,
  status: 'stub'
});

export const MANDATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    mandate_version: { type: 'integer', const: 1 },
    currency: { type: 'string', const: 'USD' },
    max_items_per_order: { type: 'integer', minimum: 1, maximum: 20 },
    max_total_cents: { type: 'integer', minimum: 0, maximum: 100000 },
    max_discount_percent: { type: 'integer', minimum: 0, maximum: 100 },
    min_stock_remaining: { type: 'integer', minimum: 0, maximum: 100 },
    status: { type: 'string', const: 'stub' }
  },
  required: Object.keys(MANDATE),
  additionalProperties: false
});

export const GET_MANDATE_TOOL = Object.freeze({
  name: 'get_mandate',
  title: 'Get seller mandate',
  description: 'Read the current synthetic AutoShop seller mandate and its bounded numerical limits. This tool never changes state.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, untrustedContentHint: false },
  execute: async (input = {}) => {
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) {
      throw new TypeError('get_mandate accepts an empty object only.');
    }
    return { ...MANDATE };
  }
});

export async function registerGetMandate(modelContext, onPageHide) {
  const controller = new AbortController();
  await modelContext.registerTool(GET_MANDATE_TOOL, { signal: controller.signal });
  onPageHide(() => controller.abort());
  return () => controller.abort();
}

if (typeof document !== 'undefined') {
  const status = document.querySelector('#webmcp-status');
  if (typeof document.modelContext?.registerTool === 'function') {
    registerGetMandate(document.modelContext, cleanup => addEventListener('pagehide', cleanup, { once: true }))
      .then(() => { status.textContent = 'WebMCP tool registered'; })
      .catch(() => { status.textContent = 'WebMCP registration failed'; });
  } else {
    status.textContent = 'WebMCP unavailable here';
  }
}
