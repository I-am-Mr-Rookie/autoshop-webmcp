import { getDatabase } from '@netlify/database';
import { resetDemoData } from '../../persistence.js';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';
import { authenticateSeller } from './seller-auth.mjs';

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

export const createHandler = (getRepository, options = {}) => async request => {
  try {
    const now = (options.now ?? (() => new Date()))();
    const repository = await getRepository();
    const seller = await authenticateSeller(request, repository, now);
    if (!seller) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Seller sign-in is required.' } }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) {
      return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Demo reset requires the seller portal.' } }, 403);
    }
    let input;
    try { input = await request.json(); } catch { input = null; }
    if (request.method.toUpperCase() !== 'POST' || !input || Object.keys(input).length !== 1 || input.confirm !== 'RESET') return json({
      ok: false,
      error: { code: 'VALIDATION', message: 'Send exactly {"confirm":"RESET"}.' }
    }, 400);
    return json(await resetDemoData(repository, options.passwordHash), 200);
  } catch {
    console.error('demo-data reset failed');
    return json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Persistence is temporarily unavailable.' } }, 503);
  }
};

export default createHandler(async () => createPostgresRepository(getDatabase()), {
  passwordHash: process.env.SELLER_PASSWORD_HASH
});

export const config = { path: '/api/demo-data/reset', method: ['POST'] };
