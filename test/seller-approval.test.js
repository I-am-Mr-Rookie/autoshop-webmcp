import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApprovalHandler, hashApprovalToken } from '../netlify/functions/seller-approval.mjs';
import { createCommitHandler } from '../netlify/functions/seller-commit.mjs';
import { COMMIT_ACTION_TOOL, getSellerAuthorization, requestSellerApproval } from '../public/app.js';

const sellerToken = 'a'.repeat(64);
const approvalToken = 'b'.repeat(64);
const now = new Date('2026-09-02T12:00:00.000Z');
const request = (path, body, method = 'POST', headers = {}) => new Request(`https://example.test${path}`, {
  method,
  headers: {
    'content-type': 'application/json',
    cookie: `__Host-autoshop_seller=${sellerToken}`,
    origin: 'https://example.test',
    ...headers
  },
  body: JSON.stringify(body)
});

const authenticatedRepository = overrides => ({
  async findSellerSession() {
    return { seller_user_id: 'seller_demo', username: 'seller', expires_at: '2026-09-02T20:00:00.000Z' };
  },
  ...overrides
});

test('human confirmation mints one hashed action-scoped approval', async () => {
  const calls = [];
  const repository = authenticatedRepository({
    async approveAction(...args) {
      calls.push(args);
      return {
        approval: {
          action_id: 'pending-1', order_id: 'order-1', quantity: 6,
          state: 'approved', expires_at: '2026-09-02T12:10:00.000Z'
        }
      };
    }
  });
  const handler = createApprovalHandler(async () => repository, {
    now: () => now,
    createToken: () => approvalToken
  });

  const response = await handler(request('/api/seller/approval', { action_id: 'pending-1', confirm: 'APPROVE' }));
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.approval.action_id, 'pending-1');
  assert.equal(result.confirm_token, approvalToken);
  assert.equal(calls[0][0], 'pending-1');
  assert.equal(calls[0][1], hashApprovalToken(approvalToken));
  assert.equal(calls[0][2].toISOString(), '2026-09-02T12:10:00.000Z');
  assert.equal(JSON.stringify(calls).includes(approvalToken), false);
});

test('approval requires seller authentication, same origin, and exact confirmation', async () => {
  let approvals = 0;
  const repository = authenticatedRepository({ async approveAction() { approvals += 1; } });
  const handler = createApprovalHandler(async () => repository, { now: () => now, createToken: () => approvalToken });

  const malformed = await handler(request('/api/seller/approval', { action_id: 'pending-1', confirm: true }));
  const extra = await handler(request('/api/seller/approval', { action_id: 'pending-1', confirm: 'APPROVE', extra: true }));
  const crossOrigin = await handler(request('/api/seller/approval', { action_id: 'pending-1', confirm: 'APPROVE' }, 'POST', { origin: 'https://evil.test' }));
  repository.findSellerSession = async () => null;
  const signedOut = await handler(request('/api/seller/approval', { action_id: 'pending-1', confirm: 'APPROVE' }));

  assert.deepEqual([malformed.status, extra.status, crossOrigin.status, signedOut.status], [400, 400, 403, 401]);
  assert.equal(approvals, 0);
});

test('commit hashes the token and returns the same receipt on exact replay', async () => {
  const calls = [];
  const receipt = { receipt_id: 'receipt-1', order_id: 'order-1', action_id: 'pending-1', items: [], total_cents: 7200, discount_percent: 0, issued_at: now.toISOString(), version: 1 };
  const repository = authenticatedRepository({
    async commitAction(...args) {
      calls.push(args);
      return { receipt, replayed: calls.length > 1 };
    }
  });
  const handler = createCommitHandler(async () => repository, { now: () => now });
  const input = { action_id: 'pending-1', confirm_token: approvalToken, idempotency_key: 'commit-key-1' };

  const first = await handler(request('/api/seller/commit', input));
  const replay = await handler(request('/api/seller/commit', input));

  assert.deepEqual([first.status, replay.status], [201, 200]);
  assert.deepEqual((await first.json()).receipt, receipt);
  assert.deepEqual((await replay.json()).receipt, receipt);
  assert.equal(calls[0][1], hashApprovalToken(approvalToken));
  assert.equal(JSON.stringify(calls).includes(approvalToken), false);
});

test('commit rejects malformed, forged, expired, stale, and conflicting work safely', async () => {
  const input = { action_id: 'pending-1', confirm_token: approvalToken, idempotency_key: 'commit-key-1' };
  for (const [repositoryError, expectedStatus] of [
    ['FORBIDDEN', 403], ['EXPIRED_APPROVAL', 409], ['STALE', 409], ['CONFLICT', 409], ['NOT_FOUND', 404]
  ]) {
    const repository = authenticatedRepository({ async commitAction() { return { error: repositoryError }; } });
    const response = await createCommitHandler(async () => repository, { now: () => now })(request('/api/seller/commit', input));
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error.code, repositoryError);
  }

  const malformed = await createCommitHandler(async () => authenticatedRepository())(
    request('/api/seller/commit', { ...input, extra: true })
  );
  assert.equal(malformed.status, 400);
});

test('repository and migration enforce current single-use approval before atomic commit', async () => {
  const repository = await readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../netlify/database/migrations/009_human-approval/migration.sql', import.meta.url), 'utf8');
  const approve = repository.slice(repository.indexOf('async approveAction'), repository.indexOf('async commitAction'));
  const commit = repository.slice(repository.indexOf('async commitAction'));

  assert.match(migration, /token_hash.*CHECK.*\^\[a-f0-9\]\{64\}\$/is);
  assert.match(migration, /UNIQUE.*token_hash|token_hash.*UNIQUE/is);
  assert.match(migration, /UNIQUE INDEX[\s\S]+action_id[\s\S]+WHERE state = 'active'/i);
  assert.match(approve, /FOR UPDATE[\s\S]+state = 'approved'[\s\S]+INSERT INTO approval_tokens[\s\S]+COMMIT/);
  assert.match(commit, /FOR UPDATE[\s\S]+token_hash[\s\S]+expires_at[\s\S]+state = 'consumed'/);
  assert.match(commit, /mandate_version[\s\S]+order_version[\s\S]+products[\s\S]+UPDATE products/);
  assert.match(commit, /UPDATE orders SET status = 'accepted'[\s\S]+UPDATE pending_actions SET state = 'committed'[\s\S]+INSERT INTO receipts[\s\S]+COMMIT/);
});

test('seller page requires a visible confirmation and commit_action uses the server endpoint', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /<form[^>]+id="seller-approval"/);
  assert.match(html, /name="confirm"[^>]+value="APPROVE"[^>]+required/);
  assert.match(html, /Approve this exceptional action/);
  assert.match(appSource, /sellerApprovalTimer[\s\S]+setTimeout[\s\S]+Approval expired\. Review and approve again\./);
  assert.match(appSource, /const approvalInput = Object\.fromEntries\(new FormData\(approvalForm\)\);[\s\S]+approvalFields\.disabled = true;[\s\S]+requestSellerApproval\(fetch, approvalInput\)/);

  let approvalRequest;
  const result = await requestSellerApproval(async (url, options) => {
    approvalRequest = { url, options };
    return new Response(JSON.stringify({
      ok: true,
      approval: { action_id: 'pending-1', order_id: 'order-1', quantity: 6, state: 'approved', expires_at: '2026-09-02T12:10:00.000Z' },
      confirm_token: approvalToken
    }), { status: 201 });
  }, { action_id: 'pending-1', confirm: 'APPROVE' });
  assert.equal(approvalRequest.url, '/api/seller/approval');
  assert.equal(result.authorization.confirm_token, approvalToken);

  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const commitRequests = [];
  globalThis.document = {};
  globalThis.fetch = async (url, options) => {
    commitRequests.push({ url, options });
    return new Response(JSON.stringify({ ok: true, replayed: commitRequests.length > 1, receipt: { receipt_id: 'receipt-1' } }), { status: commitRequests.length > 1 ? 200 : 201 });
  };
  try {
    const toolInput = { action_id: 'pending-1', confirm_token: 'caller_authorization', idempotency_key: 'commit-key-1' };
    const committed = await COMMIT_ACTION_TOOL.execute(toolInput);
    assert.equal(committed.ok, true);
    assert.equal(commitRequests[0].url, '/api/seller/commit');
    assert.equal(JSON.parse(commitRequests[0].options.body).confirm_token, 'caller_authorization');
    assert.equal(getSellerAuthorization(), undefined);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});
