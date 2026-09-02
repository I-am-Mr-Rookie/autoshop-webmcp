import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { authenticateSeller } from './seller-auth.mjs';
import { hashApprovalToken } from './seller-approval.mjs';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{16,256}$/;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const error = (code, message, status) => json({ ok: false, error: { code, message } }, status);
const errors = {
  FORBIDDEN: [403, 'This approval token is not valid for the action.'],
  NOT_FOUND: [404, 'The pending action was not found.'],
  EXPIRED_APPROVAL: [409, 'The approval expired. Review and approve the action again.'],
  STALE: [409, 'The approved action changed. Refresh it and review again.'],
  CONFLICT: [409, 'The idempotency key belongs to a different commit.'],
  UNAVAILABLE: [503, 'Approved action commit is temporarily unavailable.']
};

const readInput = async request => {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== 'action_id,confirm_token,idempotency_key') return null;
  return idPattern.test(input.action_id) && tokenPattern.test(input.confirm_token)
    && keyPattern.test(input.idempotency_key) ? input : null;
};

export const createCommitHandler = (getRepository, options = {}) => async request => {
  if (request.method.toUpperCase() !== 'POST') return error('VALIDATION', 'Unsupported approved action request.', 400);
  const now = (options.now ?? (() => new Date()))();
  try {
    const repository = await getRepository();
    const seller = await authenticateSeller(request, repository, now);
    if (!seller) return error('FORBIDDEN', 'Seller sign-in is required.', 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) return error('FORBIDDEN', 'Approved commits require the seller portal.', 403);
    const input = await readInput(request);
    if (!input) return error('VALIDATION', 'Input does not match the commit_action contract.', 400);

    const result = await repository.commitAction(
      input.action_id, hashApprovalToken(input.confirm_token), input.idempotency_key, seller.tokenHash, now
    );
    if (result?.error) return error(result.error, errors[result.error]?.[1] ?? errors.UNAVAILABLE[1], errors[result.error]?.[0] ?? 503);
    return json({ ok: true, replayed: result.replayed, receipt: result.receipt }, result.replayed ? 200 : 201);
  } catch {
    console.error('approved action commit failed');
    return error('UNAVAILABLE', errors.UNAVAILABLE[1], 503);
  }
};

export default createCommitHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/seller/commit', method: ['POST'] };
