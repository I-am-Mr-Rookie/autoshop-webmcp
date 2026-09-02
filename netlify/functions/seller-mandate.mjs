import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { authenticateSeller } from './seller-auth.mjs';

const fields = Object.freeze({
  mandate_version: [1, Number.MAX_SAFE_INTEGER],
  max_items_per_order: [1, 20],
  max_total_cents: [0, 100000],
  max_discount_percent: [0, 100],
  min_stock_remaining: [0, 100]
});

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});
const error = (code, message, status, extra = {}) => json({ ok: false, error: { code, message }, ...extra }, status);

const readInput = async request => {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== Object.keys(fields).sort().join(',')) return null;
  return Object.entries(fields).every(([name, [minimum, maximum]]) =>
    Number.isInteger(input[name]) && input[name] >= minimum && input[name] <= maximum
  ) ? input : null;
};

export const createMandateHandler = (getRepository, options = {}) => async request => {
  const method = request.method.toUpperCase();
  if (!['GET', 'PUT'].includes(method)) return error('VALIDATION', 'Unsupported mandate request.', 400);
  const now = (options.now ?? (() => new Date()))();

  try {
    const repository = await getRepository();
    const seller = await authenticateSeller(request, repository, now);
    if (!seller) return error('FORBIDDEN', 'Seller sign-in is required.', 401);

    if (method === 'GET') {
      const mandate = await repository.getMandate();
      return mandate ? json({ ok: true, mandate }) : error('UNAVAILABLE', 'Seller mandate is temporarily unavailable.', 503);
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) {
      return error('FORBIDDEN', 'Mandate changes require the seller portal.', 403);
    }
    const input = await readInput(request);
    if (!input) return error('VALIDATION', 'Input does not match the mandate contract.', 400);
    const { mandate_version: expectedVersion, ...limits } = input;
    const result = await repository.updateMandate(expectedVersion, limits, seller.tokenHash, now);
    if (result?.error === 'FORBIDDEN') return error('FORBIDDEN', 'Seller sign-in is required.', 401);
    if (result?.error === 'STALE') return error('STALE', 'The mandate changed. Review the current limits and try again.', 409, { mandate: result.mandate });
    if (result?.error === 'UNAVAILABLE') return error('UNAVAILABLE', 'Seller mandate is temporarily unavailable.', 503);
    return json({ ok: true, ...result });
  } catch {
    console.error('seller mandate failed');
    return error('UNAVAILABLE', 'Seller mandate is temporarily unavailable.', 503);
  }
};

export default createMandateHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/seller/mandate', method: ['GET', 'PUT'] };
