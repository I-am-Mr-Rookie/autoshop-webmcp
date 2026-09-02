import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { hashConfirmationToken } from './buyer-confirm.mjs';
import { hashSessionToken, readBuyerToken } from './buyer.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const tokenPattern = /^[A-Za-z0-9_-]{16,256}$/;

const readInput = async request => {
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== 'confirm_token,order_id') return null;
  return idPattern.test(input.order_id) && tokenPattern.test(input.confirm_token) ? input : null;
};

const errorResponse = code => {
  const errors = {
    EXPIRED: [409, 'The buyer confirmation expired. Review and confirm the cart again.'],
    STALE: [409, 'The cart changed. Review and confirm it again.'],
    FORBIDDEN: [403, 'The order authorization is invalid or already used.']
  };
  const [status, message] = errors[code] ?? [404, 'The synthetic order was not found.'];
  return json({ ok: false, error: { code, message } }, status);
};

export const createOrderHandler = (getRepository, options = {}) => async request => {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const input = method === 'POST' ? await readInput(request) : null;
  const queryKeys = [...url.searchParams.keys()];
  const orderId = method === 'GET' && queryKeys.length === 1 && queryKeys[0] === 'order_id'
    ? url.searchParams.get('order_id')
    : null;
  if ((method === 'POST' && !input) || (method === 'GET' && !idPattern.test(orderId ?? '')) || !['GET', 'POST'].includes(method)) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Input does not match the synthetic order contract.' } }, 400);
  }

  const rawSession = readBuyerToken(request);
  if (!rawSession) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Start or refresh the buyer session, then try again.' } }, 401);

  try {
    const now = (options.now ?? (() => new Date()))();
    const repository = await getRepository();
    const session = await repository.findBuyerSession(hashSessionToken(rawSession), now);
    if (!session) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Start or refresh the buyer session, then try again.' } }, 401);

    if (method === 'GET') {
      const order = await repository.getOrder(session.id, orderId);
      return order ? json({ ok: true, order }) : errorResponse('NOT_FOUND');
    }

    const result = await repository.submitOrder(session.id, now, input.order_id, hashConfirmationToken(input.confirm_token));
    if (result?.error) return errorResponse(result.error);
    return json({ ok: true, replayed: result.replayed, order: result.order }, result.replayed ? 200 : 201);
  } catch {
    console.error('buyer order failed');
    return json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Synthetic order submission is temporarily unavailable.' } }, 503);
  }
};

export default createOrderHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/buyer/order', method: ['GET', 'POST'] };
