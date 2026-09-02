import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createHandler,
  createPasswordHash,
  hashSessionToken
} from '../netlify/functions/seller-auth.mjs';
import { createSeedRecords } from '../persistence.js';

const rawSession = 'a'.repeat(64);
const validPassword = ['unit', 'test', 'password', 'only'].join('-');

const memoryRepository = passwordHash => {
  const seller = {
    id: 'seller-1', username: 'seller', password_hash: passwordHash,
    status: 'active', failed_login_count: 0, locked_until: null
  };
  return {
    seller,
    async findSeller(username) { return username === seller.username ? { ...seller } : null; },
    async recordSellerLoginFailure(_id, now, limit, lockedUntil) {
      if (seller.locked_until && new Date(seller.locked_until) <= now) seller.failed_login_count = 0;
      seller.failed_login_count += 1;
      if (seller.failed_login_count >= limit) seller.locked_until = lockedUntil.toISOString();
      return { locked_until: seller.locked_until };
    },
    async createSellerSession(_id, tokenHash, expiresAt) {
      seller.session_token_hash = tokenHash;
      seller.session_expires_at = expiresAt.toISOString();
      seller.failed_login_count = 0;
      seller.locked_until = null;
    },
    async findSellerSession(tokenHash, now) {
      return tokenHash === seller.session_token_hash && new Date(seller.session_expires_at) > now
        ? { username: seller.username, expires_at: seller.session_expires_at }
        : null;
    },
    async deleteSellerSession(tokenHash) {
      if (tokenHash === seller.session_token_hash) {
        seller.session_token_hash = null;
        seller.session_expires_at = null;
      }
    }
  };
};

const loginRequest = password => new Request('https://example.test/api/seller/auth', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'seller', password })
});

test('logs in with a hashed password and supports cookie-bound session logout', async () => {
  const passwordHash = await createPasswordHash(validPassword, '01'.repeat(16));
  const repository = memoryRepository(passwordHash);
  const now = new Date('2026-09-02T12:00:00.000Z');
  const handler = createHandler(async () => repository, {
    now: () => now,
    createToken: () => rawSession
  });

  const login = await handler(loginRequest(validPassword));
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /^__Host-autoshop_seller=a{64}; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(repository.seller.session_token_hash, hashSessionToken(rawSession));
  assert.equal(JSON.stringify(repository.seller).includes(rawSession), false);

  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const session = await handler(new Request('https://example.test/api/seller/auth', { headers: { cookie } }));
  assert.deepEqual(await session.json(), {
    ok: true, username: 'seller', expires_at: '2026-09-02T20:00:00.000Z'
  });

  const logout = await handler(new Request('https://example.test/api/seller/auth', { method: 'DELETE', headers: { cookie } }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^__Host-autoshop_seller=; Max-Age=0;/);
  assert.equal((await handler(new Request('https://example.test/api/seller/auth', { headers: { cookie } }))).status, 401);
});

test('rejects malformed or wrong credentials and rate-limits the seeded account', async () => {
  const passwordHash = await createPasswordHash(validPassword, '02'.repeat(16));
  const repository = memoryRepository(passwordHash);
  const handler = createHandler(async () => repository, {
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    createToken: () => rawSession
  });

  const malformed = await handler(new Request('https://example.test/api/seller/auth', {
    method: 'POST', body: JSON.stringify({ username: 'seller', password: 123, extra: true })
  }));
  assert.equal(malformed.status, 400);
  assert.equal(repository.seller.failed_login_count, 0);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const rejected = await handler(loginRequest('definitely wrong password'));
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, 'FORBIDDEN');
  }
  const limited = await handler(loginRequest('definitely wrong password'));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'RATE_LIMITED');

  const stillLimited = await handler(loginRequest(validPassword));
  assert.equal(stillLimited.status, 429);
  assert.equal(repository.seller.session_token_hash, undefined);
});

test('keeps the seller credential out of source while wiring persistence and accessible UI', async () => {
  assert.throws(() => createSeedRecords(), /SELLER_PASSWORD_HASH/);
  assert.throws(() => createSeedRecords('plaintext'), /SELLER_PASSWORD_HASH/);
  const migration = await readFile(new URL('../netlify/database/migrations/004_seller-authentication/migration.sql', import.meta.url), 'utf8');
  const repository = await readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const client = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(migration, /session_token_hash TEXT/);
  assert.match(migration, /failed_login_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(repository, /password_hash/);
  assert.match(html, /id="seller-login"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(client, /\/api\/seller\/auth/);
  assert.doesNotMatch(`${migration}\n${repository}\n${html}\n${client}`, new RegExp(validPassword));
});
