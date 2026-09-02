import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { authenticateSeller } from './seller-auth.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export const createSellerOrdersHandler = (getRepository, options = {}) => async request => {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 5;
  if (request.method.toUpperCase() !== 'GET' || keys.some(key => key !== 'limit')
    || keys.length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Input does not match the list_orders contract.' } }, 400);
  }

  try {
    const now = (options.now ?? (() => new Date()))();
    const repository = await getRepository();
    const seller = await authenticateSeller(request, repository, now);
    if (!seller) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Seller sign-in is required.' } }, 401);
    return json({ ok: true, orders: await repository.listSellerOrders(seller.tokenHash, now, limit) });
  } catch {
    console.error('seller order list failed');
    return json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Seller orders are temporarily unavailable.' } }, 503);
  }
};

export default createSellerOrdersHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/seller/orders', method: ['GET'] };
