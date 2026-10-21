import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server.js';
import { createHandler as createSellerAuthHandler } from '../functions/seller-auth.mjs';

const canonicalOrigin = 'https://autoshop.example';

const start = async (t, options = {}) => {
  const server = createAppServer({ healthcheck: async () => {}, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const withEnv = (t, values) => {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
};

test('non-canonical host gets a 301 to the same path and query on APP_ORIGIN', async t => {
  const base = await start(t, { canonicalOrigin });
  const response = await fetch(base + '/buyer?ref=old&x=1', { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://autoshop.example/buyer?ref=old&x=1');
  const api = await fetch(base + '/api/config', { redirect: 'manual' });
  assert.equal(api.status, 301);
  assert.equal(api.headers.get('location'), 'https://autoshop.example/api/config');
});

test('APP_ORIGIN environment variable drives the canonical redirect', async t => {
  withEnv(t, { APP_ORIGIN: canonicalOrigin });
  const base = await start(t);
  const response = await fetch(base + '/seller', { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://autoshop.example/seller');
});

test('non-GET requests on a non-canonical host keep their method with 308', async t => {
  const base = await start(t, { canonicalOrigin });
  const response = await fetch(base + '/api/seller/accept', { method: 'POST', body: '{}', redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://autoshop.example/api/seller/accept');
});

test('/healthz is exempt from the canonical redirect', async t => {
  const base = await start(t, { canonicalOrigin });
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(base + '/healthz', { method, redirect: 'manual', headers: { 'x-forwarded-host': 'healthcheck.railway.app' } });
    assert.equal(response.status, 200, method);
  }
});

test('canonical forwarded host is served directly, case-insensitively and with a default port', async t => {
  const base = await start(t, { canonicalOrigin });
  for (const host of ['autoshop.example', 'AutoShop.Example', 'autoshop.example:443']) {
    const response = await fetch(base + '/', { redirect: 'manual', headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } });
    assert.equal(response.status, 200, host);
  }
});

test('plain HTTP on the canonical host is upgraded to HTTPS', async t => {
  const base = await start(t, { canonicalOrigin });
  const response = await fetch(base + '/seller?a=1', { redirect: 'manual', headers: { 'x-forwarded-host': 'autoshop.example', 'x-forwarded-proto': 'http' } });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://autoshop.example/seller?a=1');
});

test('without a configured canonical origin no request is redirected', async t => {
  withEnv(t, { APP_ORIGIN: undefined });
  const base = await start(t);
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 200);
});

test('CSP keeps sign-in, Turnstile, and protect sources but drops telemetry hosts', async t => {
  const domain = 'clerk.autoshop.example';
  withEnv(t, { CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from(`${domain}$`).toString('base64url')}` });
  const base = await start(t);
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.doesNotMatch(csp, /clerk-telemetry\.com/);
  for (const directive of [
    // Protect probes non-default ports (seen live: 2082, 8443, 18443), so connect-src needs the port wildcard.
    `connect-src 'self' https://${domain} https://*.protect.clerk.com:*`,
    "img-src 'self' data: https://img.clerk.com https://*.googleusercontent.com",
    `script-src 'self' https://${domain} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    `frame-src 'self' https://${domain} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "worker-src 'self' blob:"
  ]) assert.ok(csp.includes(directive), directive);
});

test('unconfigured sign-in returns neutral provider-free copy', async t => {
  withEnv(t, { CLERK_PUBLISHABLE_KEY: undefined });
  const base = await start(t);
  const response = await fetch(base + '/api/config');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'UNAVAILABLE', message: 'Sign-in is not configured.' } });
});

test('signed-out API calls get neutral sign-in copy', async t => {
  const routes = new Map([['/api/probe', { config: { method: ['GET'] }, default: () => new Response('ok') }]]);
  const base = await start(t, { routes, authenticate: async () => null });
  const response = await fetch(base + '/api/probe');
  assert.equal(response.status, 401);
  const { error } = await response.json();
  assert.equal(error.message, 'Sign in to open your isolated demo shop.');
  assert.doesNotMatch(error.message, /Google|Clerk/);
});

test('seller auth outside a signed-in shop uses neutral sign-in copy', async () => {
  const response = await createSellerAuthHandler(async () => ({}))(new Request('https://autoshop.example/api/seller/auth'));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.message, 'Sign in to open your demo shop.');
});

test('the browser sign-in client loads with telemetry disabled', async () => {
  const source = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  assert.match(source, /clerk\.load\(\{[^\n]*\btelemetry: false[^\n]*\}\);/);
});

test('/privacy and /terms serve their HTML pages', async t => {
  const publicRoot = await mkdtemp(join(tmpdir(), 'autoshop-public-'));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));
  await writeFile(join(publicRoot, 'privacy.html'), '<h1>Privacy fixture</h1>');
  await writeFile(join(publicRoot, 'terms.html'), '<h1>Terms fixture</h1>');
  const base = await start(t, { publicRoot });
  for (const [path, body] of [['/privacy', 'Privacy fixture'], ['/terms', 'Terms fixture']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), new RegExp(body));
  }
});
