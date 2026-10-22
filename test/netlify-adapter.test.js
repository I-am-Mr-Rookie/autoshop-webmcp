import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer, securityHeaders } from '../server.js';
import { handleWithNodeServer } from '../netlify-adapter.mjs';
import netlifyFunction, { config as netlifyConfig } from '../netlify/functions/app.mjs';

const echoRoute = {
  config: { path: '/api/echo', method: ['POST'] },
  default: async request => {
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
    headers.append('set-cookie', 'b=2; Path=/; HttpOnly');
    return new Response(JSON.stringify({ body: await request.text() }), { status: 201, headers });
  }
};
const app = (options = {}) => createAppServer({
  routes: new Map([[echoRoute.config.path, echoRoute]]),
  healthcheck: async () => {},
  authenticate: async () => ({ userId: 'user_test' }),
  provisionShop: async () => {},
  ...options
});

test('Netlify adapter serves healthz with security headers', async () => {
  const response = await handleWithNodeServer(app(), new Request('https://autoshop-webmcp.netlify.app/healthz'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-frame-options'), securityHeaders['X-Frame-Options']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Netlify adapter returns no body for HEAD', async () => {
  const response = await handleWithNodeServer(app(), new Request('https://autoshop-webmcp.netlify.app/healthz', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('Netlify adapter redirects non-canonical hosts from the request URL, not spoofed headers', async () => {
  const server = app({ canonicalOrigin: 'https://autoshop.webmcp.rookiecoders.tech' });
  const request = new Request('https://autoshop-webmcp.netlify.app/seller?x=1', {
    headers: { 'x-forwarded-host': 'autoshop.webmcp.rookiecoders.tech', 'x-forwarded-proto': 'https' }
  });
  const response = await handleWithNodeServer(server, request);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://autoshop.webmcp.rookiecoders.tech/seller?x=1');
  const canonical = await handleWithNodeServer(server, new Request('https://autoshop.webmcp.rookiecoders.tech/healthz'));
  assert.equal(canonical.status, 200);
});

test('Netlify adapter forwards request bodies and keeps every Set-Cookie header', async () => {
  const origin = 'https://autoshop.webmcp.rookiecoders.tech';
  const response = await handleWithNodeServer(app({ origin, canonicalOrigin: origin }), new Request(`${origin}/api/echo`, {
    method: 'POST',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: '{"hello":"world"}'
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { body: '{"hello":"world"}' });
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly']);
});

test('Netlify function claims every path and serves static pages through the shared server', async () => {
  assert.deepEqual(netlifyConfig.path, ['/', '/*']);
  assert.notEqual(netlifyConfig.preferStatic, true);
  const response = await netlifyFunction(new Request('https://autoshop-webmcp.netlify.app/'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /AutoShop/);
});

test('database falls back to the Netlify Database connection string', async t => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, NETLIFY_DB_URL: process.env.NETLIFY_DB_URL };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  delete process.env.DATABASE_URL;
  process.env.NETLIFY_DB_URL = 'postgres://netlify@127.0.0.1:1/autoshop';
  const { getBaseDatabase } = await import('../database.mjs?netlify-fallback');
  const { pool } = getBaseDatabase();
  assert.equal(pool.options.connectionString, process.env.NETLIFY_DB_URL);
  await pool.end();
});

test('app root is the repository locally and the Lambda task root when Netlify bundles modules', async t => {
  const saved = process.env.LAMBDA_TASK_ROOT;
  t.after(() => { if (saved === undefined) delete process.env.LAMBDA_TASK_ROOT; else process.env.LAMBDA_TASK_ROOT = saved; });
  delete process.env.LAMBDA_TASK_ROOT;
  const local = await import('../app-root.mjs?local');
  assert.equal(local.appRoot.href, new URL('../', import.meta.url).href);
  process.env.LAMBDA_TASK_ROOT = '/var/task';
  const lambda = await import('../app-root.mjs?lambda');
  assert.equal(fileURLToPath(lambda.appRoot), resolve('/var/task') + sep);
});
