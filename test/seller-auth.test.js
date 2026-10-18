import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHandler, hashSessionToken } from '../functions/seller-auth.mjs';
import { withShop } from '../shop-context.mjs';

const identity = { userId: 'user_testGoogle', sessionId: 'sess_test' };
const now = new Date('2026-10-18T12:00:00Z');
const token = 'a'.repeat(64);
const request = (method, body, cookie) => new Request('https://example.test/api/seller/auth', {
  method, headers: { origin: 'https://example.test', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const setup = () => {
  const sessions = new Map();
  const repository = {
    findSeller: async () => ({ id: 'seller-1', username: 'seller', status: 'active' }),
    createSellerSession: async (_id, hash, expires_at) => { sessions.set(hash, { username: 'seller', expires_at }); },
    findSellerSession: async (hash, at) => { const session = sessions.get(hash); return session && new Date(session.expires_at) > at ? session : null; },
    deleteSellerSession: async hash => { sessions.delete(hash); }
  };
  return { sessions, handler: createHandler(async () => repository, { now: () => now, createToken: () => token }) };
};

test('only verified Clerk request context can mint a seller session; old passwords cannot log in', async () => {
  const { handler, sessions } = setup();
  assert.equal((await handler(request('POST', {}))).status, 401);
  const oldLogin = await withShop(identity, () => handler(request('POST', { username: 'seller', password: 'not-a-credential' })));
  assert.equal(oldLogin.status, 400);
  assert.equal(sessions.size, 0);
  assert.equal((await withShop(identity, () => handler(request('POST', [])))).status, 400);
});

test('Google-authenticated shop receives a hashed HttpOnly session and can log out', async () => {
  const { handler, sessions } = setup();
  await withShop(identity, async () => {
    const login = await handler(request('POST', {}));
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /^__Host-autoshop_seller=a{64}; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(sessions.has(hashSessionToken(token)), true);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await handler(request('GET', undefined, cookie))).status, 200);
    assert.equal((await handler(request('POST', {}, cookie))).status, 200);
    assert.equal(sessions.size, 1);
    const logout = await handler(request('DELETE', undefined, cookie));
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await handler(request('GET', undefined, cookie))).status, 401);
  });
});

test('session creation fails closed on a cross-origin request', async () => {
  const { handler, sessions } = setup();
  const result = await withShop(identity, () => handler(new Request('https://example.test/api/seller/auth', {
    method: 'POST', headers: { origin: 'https://attacker.example' }, body: '{}'
  })));
  assert.equal(result.status, 403);
  assert.equal(sessions.size, 0);
});

test('seller UI has Google login and no manual credential fields or password environment setting', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(html, /Continue with Google/);
  assert.doesNotMatch(html, /name="(?:password|username)"/);
  assert.doesNotMatch(env, /SELLER_PASSWORD_HASH/);
});
