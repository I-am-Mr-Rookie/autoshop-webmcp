import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';

const scryptAsync = promisify(scrypt);
const SESSION_SECONDS = 8 * 60 * 60;
const LOCK_MINUTES = 15;
const MAX_FAILURES = 5;
const COOKIE = '__Host-autoshop_seller';
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});
const error = (code, message, status, headers) => json({ ok: false, error: { code, message } }, status, headers);
const clearCookie = `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

export const hashSessionToken = token => createHash('sha256').update(token).digest('hex');

export const createPasswordHash = async (password, salt = randomBytes(16).toString('hex')) => {
  const key = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
};

const verifyPassword = async (password, encoded) => {
  const [, salt, expected] = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded ?? '') ?? [];
  if (!salt) return false;
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
};

const readToken = request => request.headers.get('cookie')
  ?.split(';')
  .map(part => part.trim().split('='))
  .find(([name, value]) => name === COOKIE && /^[a-f0-9]{64}$/.test(value ?? ''))?.[1];

export const authenticateSeller = async (request, repository, now) => {
  const token = readToken(request);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await repository.findSellerSession(tokenHash, now);
  return session && { ...session, tokenHash };
};

const readLogin = async request => {
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== 'password,username') return null;
  if (typeof input.username !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.username)) return null;
  return typeof input.password === 'string' && input.password.length >= 8 && input.password.length <= 128 ? input : null;
};

export const createHandler = (getRepository, options = {}) => async request => {
  const method = request.method.toUpperCase();
  if (!['GET', 'POST', 'DELETE'].includes(method)) return error('VALIDATION', 'Unsupported seller authentication request.', 400);
  const now = (options.now ?? (() => new Date()))();

  try {
    const repository = await getRepository();
    const rawToken = readToken(request);

    if (method === 'GET') {
      const session = await authenticateSeller(request, repository, now);
      return session
        ? json({ ok: true, username: session.username, expires_at: new Date(session.expires_at).toISOString() })
        : error('FORBIDDEN', 'Seller sign-in is required.', 401);
    }

    if (method === 'DELETE') {
      if (rawToken) await repository.deleteSellerSession(hashSessionToken(rawToken));
      return json({ ok: true }, 200, { 'set-cookie': clearCookie });
    }

    const input = await readLogin(request);
    if (!input) return error('VALIDATION', 'Input does not match the seller login contract.', 400);
    const seller = await repository.findSeller(input.username);
    if (seller?.locked_until && new Date(seller.locked_until) > now) {
      return error('RATE_LIMITED', 'Too many sign-in attempts. Try again later.', 429, { 'retry-after': String(LOCK_MINUTES * 60) });
    }

    const valid = await verifyPassword(input.password, seller?.password_hash ?? DUMMY_HASH);
    if (!seller || seller.status !== 'active' || !valid) {
      if (seller) {
        const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000);
        const failure = await repository.recordSellerLoginFailure(seller.id, now, MAX_FAILURES, lockedUntil);
        if (failure?.locked_until) return error('RATE_LIMITED', 'Too many sign-in attempts. Try again later.', 429, { 'retry-after': String(LOCK_MINUTES * 60) });
      }
      return error('FORBIDDEN', 'Invalid seller credentials.', 401);
    }

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
