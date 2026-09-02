import { createHash, randomBytes } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { hashSessionToken, readBuyerToken } from './buyer.mjs';

const TEN_MINUTES = 10 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const readInput = async request => {
  let input;
  try { input = await request.json(); } catch { return null; }
  if (!input || Array.isArray(input) || typeof input !== 'object') return null;
  if (Object.keys(input).sort().join(',') !== 'buyer_country,buyer_email,buyer_name,cart_version,mode') return null;
  if (!['Ask', 'Auto'].includes(input.mode) || !validText(input.buyer_name, 80) || !validText(input.buyer_country, 56)) return null;
  if (typeof input.buyer_email !== 'string' || input.buyer_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.buyer_email)) return null;
  if (!Number.isInteger(input.cart_version) || input.cart_version < 1) return null;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
};

export const hashConfirmationToken = token => createHash('sha256').update(token).digest('hex');

export const createConfirmationHandler = (getRepository, options = {}) => async request => {
  if (request.method.toUpperCase() !== 'POST') return json({ ok: false, error: { code: 'VALIDATION', message: 'Use POST with the buyer confirmation fields.' } }, 400);
  const input = await readInput(request);
  if (!input) return json({ ok: false, error: { code: 'VALIDATION', message: 'Input does not match the buyer confirmation contract.' } }, 400);

  const rawSession = readBuyerToken(request);
  if (!rawSession) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Start or refresh the buyer session, then confirm again.' } }, 401);

  try {
    const now = (options.now ?? (() => new Date()))();
    const repository = await getRepository();
    const session = await repository.findBuyerSession(hashSessionToken(rawSession), now);
    if (!session) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Start or refresh the buyer session, then confirm again.' } }, 401);

    const rawToken = (options.createToken ?? (() => randomBytes(32).toString('hex')))();
    const orderId = (options.createOrderId ?? (() => `order_${randomBytes(16).toString('hex')}`))();
    const expiresAt = new Date(Math.min(new Date(session.expires_at).getTime(), now.getTime() + TEN_MINUTES));
    const confirmation = await repository.confirmBuyer(session.id, now, {
      mode: input.mode,
      buyerName: input.buyer_name,
      buyerEmail: input.buyer_email,
      buyerCountry: input.buyer_country,
      orderId,
      tokenHash: hashConfirmationToken(rawToken),
      expiresAt,
      reviewedCartVersion: input.cart_version
    });
    if (confirmation?.error === 'EMPTY_CART') return json({ ok: false, error: { code: 'EMPTY_CART', message: 'Add at least one item before final confirmation.' } }, 409);
    if (confirmation?.error === 'STALE') return json({ ok: false, error: { code: 'STALE', message: 'The cart changed. Review it again before confirming.' } }, 409);
    if (confirmation?.error === 'FORBIDDEN') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Start or refresh the buyer session, then confirm again.' } }, 401);
    if (!confirmation) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Start or refresh the buyer session, then confirm again.' } }, 401);

    return json({
      ok: true,
      mode: confirmation.mode,
      cart_version: confirmation.cart_version,
      order_id: orderId,
      confirm_token: rawToken,
      confirmation_expires_at: confirmation.expires_at
    });
  } catch (error) {
    console.error('buyer confirmation failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Buyer confirmation is temporarily unavailable.' } }, 503);
  }
};

export default createConfirmationHandler(async () => createPostgresRepository(getDatabase()));

export const config = { path: '/api/buyer/confirm', method: ['POST'] };
