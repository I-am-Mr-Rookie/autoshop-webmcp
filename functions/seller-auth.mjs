import { createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { getDatabase } from '../database.mjs';
import { currentShop } from '../shop-context.mjs';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';

const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE = '__Host-autoshop_seller';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const error = (code, message, status) => json({ ok: false, error: { code, message } }, status);
const clearCookie = `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
export const hashSessionToken = token => createHash('sha256').update(token).digest('hex');

// Compatibility helper for historical test fixtures only. No password login route exists.
export const createPasswordHash = async (password, salt = randomBytes(16).toString('hex')) => {
  const key = await promisify(scrypt)(password, Buffer.from(salt, 'hex'), 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
};
const readToken = request => request.headers.get('cookie')?.split(';')
  .map(part => part.trim().split('='))
  .find(([name, value]) => name === COOKIE && /^[a-f0-9]{64}$/.test(value ?? ''))?.[1];

export const authenticateSeller = async (request, repository, now) => {
  const token = readToken(request);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await repository.findSellerSession(tokenHash, now);
  return session && { ...session, tokenHash };
};

export const createHandler = (getRepository, options = {}) => async request => {
  const method = request.method.toUpperCase();
  if (!['GET', 'POST', 'DELETE'].includes(method)) return error('VALIDATION', 'Unsupported seller authentication request.', 400);
  // This context is established only by the HTTP adapter after verifying the Clerk session.
  if (!currentShop()?.userId) return error('FORBIDDEN', 'Sign in to open your demo shop.', 401);
  if (method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return error('FORBIDDEN', 'Use the seller portal.', 403);
  try {
    const repository = await getRepository();
    const now = (options.now ?? (() => new Date()))();
    const rawToken = readToken(request);
    if (method === 'DELETE') {
      if (rawToken) await repository.deleteSellerSession(hashSessionToken(rawToken));
      return json({ ok: true }, 200, { 'set-cookie': clearCookie });
    }
    const session = await authenticateSeller(request, repository, now);
    if (method === 'GET') return session
      ? json({ ok: true, username: session.username, expires_at: new Date(session.expires_at).toISOString() })
      : error('FORBIDDEN', 'Open the seller portal to start your session.', 401);
    let input;
    try { input = await request.json(); } catch { input = null; }
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) {
      return error('VALIDATION', 'Google sign-in replaces username and password. Send an empty object.', 400);
    }
    if (session) return json({ ok: true, username: session.username, expires_at: new Date(session.expires_at).toISOString() });
    const seller = await repository.findSeller('seller');
    if (!seller || seller.status !== 'active') return error('FORBIDDEN', 'Demo seller is unavailable.', 403);
    const token = (options.createToken ?? (() => randomBytes(32).toString('hex')))();
    const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
    await repository.createSellerSession(seller.id, hashSessionToken(token), expiresAt);
    return json({ ok: true, username: seller.username, expires_at: expiresAt.toISOString() }, 200, {
      'set-cookie': `${COOKIE}=${token}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`
    });
  } catch {
    console.error('seller authentication failed');
    return error('UNAVAILABLE', 'Seller authentication is temporarily unavailable.', 503);
  }
};
export default createHandler(async () => createPostgresRepository(getDatabase()));
export const config = { path: '/api/seller/auth', method: ['GET', 'POST', 'DELETE'] };
