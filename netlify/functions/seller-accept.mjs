import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { authenticateSeller } from './seller-auth.mjs';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const error = (code, message, status) => json({ ok: false, error: { code, message } }, status);

const readInput = async request => {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== 'idempotency_key,order_id,quantity') return null;
  return idPattern.test(input.order_id)
    && Number.isInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 20
    && keyPattern.test(input.idempotency_key) ? input : null;
};

const errors = {
  FORBIDDEN: [401, 'Seller sign-in is required.'],
  NOT_FOUND: [404, 'The synthetic order was not found.'],
  STALE: [409, 'The order changed. Refresh it and try again.'],
  APPROVAL_REQUIRED: [409, 'The order is outside the current mandate and requires seller approval.'],
  CONFLICT: [409, 'The idempotency key belongs to a different acceptance request.'],
  UNAVAILABLE: [503, 'Seller acceptance is temporarily unavailable.']
};

export const createAcceptHandler = (getRepository, options = {}) => async request => {
  if (request.method.toUpperCase() !== 'POST') return error('VALIDATION', 'Unsupported seller acceptance request.', 400);
  const now = (options.now ?? (() => new Date()))();
  try {
    const repository = await getRepository();
    const seller = await authenticateSeller(request, repository, now);
    if (!seller) return error('FORBIDDEN', errors.FORBIDDEN[1], errors.FORBIDDEN[0]);
    if (request.headers.get('origin') !== new URL(request.url).origin) {
      return error('FORBIDDEN', 'Order acceptance requires the seller portal.', 403);
    }
    const input = await readInput(request);
    if (!input) return error('VALIDATION', 'Input does not match the accept_order contract.', 400);
    const result = await repository.acceptOrder(
      input.order_id, input.quantity, input.idempotency_key, seller.tokenHash, now
    );
    if (result?.error === 'APPROVAL_REQUIRED') return json({
      ok: false,
      error: { code: result.error, message: errors.APPROVAL_REQUIRED[1] },
      pending_action: result.pendingAction
    }, errors.APPROVAL_REQUIRED[0]);
    if (result?.error) return error(result.error, errors[result.error]?.[1] ?? errors.UNAVAILABLE[1], errors[result.error]?.[0] ?? 503);
    return json({ ok: true, replayed: result.replayed, receipt: result.receipt }, result.replayed ? 200 : 201);
  } catch {
    console.error('seller acceptance failed');
    return error('UNAVAILABLE', errors.UNAVAILABLE[1], 503);
  }
};

export default createAcceptHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/seller/accept', method: ['POST'] };
