import { getDatabase } from '@netlify/database';
import { resetDemoData } from '../../persistence.js';
import { createPostgresRepository } from './_shared/postgres-repository.mjs';

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

export const createHandler = (getRepository, options = {}) => async request => {
  let input;
  try { input = await request.json(); } catch { input = null; }
  if (!input || Object.keys(input).length !== 1 || input.confirm !== 'RESET') return json({
    ok: false,
    error: { code: 'VALIDATION', message: 'Send exactly {"confirm":"RESET"}.' }
  }, 400);

  try {
    return json(await resetDemoData(await getRepository(), options.passwordHash), 200);
  } catch (error) {
    console.error('demo-data reset failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Persistence is temporarily unavailable.' } }, 503);
  }
};

export default createHandler(async () => createPostgresRepository(getDatabase()), {
  passwordHash: process.env.SELLER_PASSWORD_HASH
});

export const config = { path: '/api/demo-data/reset', method: ['POST'] };
