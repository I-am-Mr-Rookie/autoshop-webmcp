import { createHash, randomBytes } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';

const DAY_SECONDS = 86400;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});
const validation = () => json({
  ok: false,
  error: { code: 'VALIDATION', message: 'Input does not match the buyer API contract.' }
}, 400);

export const hashSessionToken = token => createHash('sha256').update(token).digest('hex');

export const readBuyerToken = request => request.headers.get('cookie')
  ?.split(';')
  .map(part => part.trim().split('='))
  .find(([name, value]) => name === 'autoshop_buyer' && /^[a-f0-9]{64}$/.test(value ?? ''))?.[1];

const readBrowseInput = url => {
  if ([...url.searchParams.keys()].some(key => !['query', 'limit'].includes(key))) return null;
  const query = url.searchParams.get('query') ?? '';
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? 8 : Number(limitText);
  return (query.length <= 80 && Number.isInteger(limit) && limit >= 1 && limit <= 8) ? { query, limit } : null;
};

const readCartInput = async request => {
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== 'action,product_id,quantity') return null;
  if (!['add', 'set', 'remove'].includes(input.action)) return null;
  if (typeof input.product_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.product_id)) return null;
  return Number.isInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 20 ? input : null;
};

export const createHandler = (getRepository, options = {}) => async request => {
  const now = (options.now ?? (() => new Date()))();
  const method = request.method.toUpperCase();
  const browseInput = method === 'GET' ? readBrowseInput(new URL(request.url)) : null;
  const cartInput = method === 'POST' ? await readCartInput(request) : null;
  if ((method === 'GET' && !browseInput) || (method === 'POST' && !cartInput) || !['GET', 'POST'].includes(method)) return validation();

  try {
    const repository = await getRepository();
    let rawToken = readBuyerToken(request);
    let session = rawToken && await repository.findBuyerSession(hashSessionToken(rawToken), now);
    let setCookie;
    if (!session) {
      rawToken = (options.createToken ?? (() => randomBytes(32).toString('hex')))();
      const expiresAt = new Date(now.getTime() + DAY_SECONDS * 1000);
      await repository.createBuyerSession(hashSessionToken(rawToken), expiresAt);
      session = { id: hashSessionToken(rawToken), expires_at: expiresAt.toISOString() };
      setCookie = `autoshop_buyer=${rawToken}; Max-Age=${DAY_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    }

    const headers = setCookie ? { 'set-cookie': setCookie } : {};
    if (method === 'GET') return json({
      ok: true,
      session_expires_at: new Date(session.expires_at).toISOString(),
      mode: session.mode ?? 'Ask',
      products: await repository.listProducts(browseInput.query, browseInput.limit),
      cart: await repository.getCart(session.id)
    }, 200, headers);

    const cart = await repository.mutateCart(session.id, now, {
      action: cartInput.action,
      productId: cartInput.product_id,
      quantity: cartInput.quantity
    });
    if (cart?.error === 'QUANTITY') return validation();
    if (!cart || cart.error) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Buyer session or product was not found.' } }, 404, headers);
    return json({ ok: true, cart }, 200, headers);
  } catch (error) {
    console.error('buyer API failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Buyer data is temporarily unavailable.' } }, 503);
  }
};

export default createHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/buyer', method: ['GET', 'POST'] };
