import { timingSafeEqual, createHash } from 'node:crypto';
import { getDatabase } from '@netlify/database';

export const tables = ['products', 'buyer_sessions', 'carts', 'mandates', 'seller_users', 'orders', 'pending_actions', 'approval_tokens', 'receipts', 'seller_sessions'];
export const fingerprint = rows => {
  const canonical = value => value instanceof Date ? value.toISOString() : value === null || typeof value !== 'object' ? value
    : Array.isArray(value) ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
};

export const createExportHandler = (getPool, token) => async request => {
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  if (!token || request.method !== 'GET' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return new Response('Not found', { status: 404 });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = {};
    for (const table of tables) {
      const key = table === 'seller_sessions' ? 'token_hash' : 'id';
      data[table] = (await client.query(`SELECT * FROM ${table} ORDER BY ${key}`)).rows;
    }
    await client.query('COMMIT');
    return Response.json({ version: 1, data, counts: Object.fromEntries(tables.map(table => [table, data[table].length])),
      hashes: Object.fromEntries(tables.map(table => [table, fingerprint(data[table])])) },
    { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    await client.query('ROLLBACK');
    console.error('migration export failed');
    return Response.json({ error: 'Export unavailable' }, { status: 503 });
  } finally {
    client.release();
  }
};

export default createExportHandler(() => getDatabase().pool, process.env.MIGRATION_EXPORT_TOKEN);
export const config = { path: '/api/migration-export', method: ['GET'] };
