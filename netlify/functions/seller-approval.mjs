import { createHash, randomBytes } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { authenticateSeller } from './seller-auth.mjs';

const APPROVAL_MINUTES = 10;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const error = (code, message, status) => json({ ok: false, error: { code, message } }, status);
const errors = {
  FORBIDDEN: [403, 'This approval is not authorized.'],
  NOT_FOUND: [404, 'The pending action was not found.'],
  STALE: [409, 'The pending action changed. Refresh it and review again.'],
  CONFLICT: [409, 'This action already has an active approval.'],
  UNAVAILABLE: [503, 'Seller approval is temporarily unavailable.']
};

export const hashApprovalToken = token => createHash('sha256').update(token).digest('hex');

const readInput = async request => {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  let input;
  try { input = await request.json(); } catch { return null; }
  return input && !Array.isArray(input) && typeof input === 'object'
    && Object.keys(input).sort().join(',') === 'action_id,confirm'
    && idPattern.test(input.action_id) && input.confirm === 'APPROVE' ? input : null;
};

export const createApprovalHandler = (getRepository, options = {}) => async request => {
  if (request.method.toUpperCase() !== 'POST') return error('VALIDATION', 'Unsupported seller approval request.', 400);
  const now = (options.now ?? (() => new Date()))();
  try {
    const repository = await getRepository();
    const seller = await authenticateSeller(request, repository, now);
    if (!seller) return error('FORBIDDEN', 'Seller sign-in is required.', 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) return error('FORBIDDEN', 'Approval requires the seller portal.', 403);
    const input = await readInput(request);
    if (!input) return error('VALIDATION', 'Input does not match the seller approval contract.', 400);

    const token = (options.createToken ?? (() => randomBytes(32).toString('hex')))();
    const expiresAt = new Date(now.getTime() + APPROVAL_MINUTES * 60 * 1000);
    const result = await repository.approveAction(input.action_id, hashApprovalToken(token), expiresAt, seller.tokenHash, now);
    if (result?.error) return error(result.error, errors[result.error]?.[1] ?? errors.UNAVAILABLE[1], errors[result.error]?.[0] ?? 503);
    return json({ ok: true, approval: result.approval, confirm_token: token }, 201);
  } catch (caught) {
    console.error('seller approval failed:', caught instanceof Error ? caught.message : 'unknown error');
    return error('UNAVAILABLE', errors.UNAVAILABLE[1], 503);
  }
};

export default createApprovalHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/seller/approval', method: ['POST'] };
