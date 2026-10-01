import pg from 'pg';
import { getDatabase as getNetlifyDatabase } from '@netlify/database';

let database;
export const getDatabase = () => {
  if (!process.env.DATABASE_URL) return getNetlifyDatabase();
  if (!database) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', () => console.error('database connection failed'));
    database = { pool };
  }
  return database;
};

// Temporary write freeze while the production snapshot is transferred.
export const withMigrationLock = handler => request => {
  if (!process.env.DATABASE_URL && process.env.MIGRATION_READ_ONLY === 'true') {
    return Response.json({ ok: false, error: { code: 'UNAVAILABLE', message: 'AutoShop is migrating. Please retry shortly.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
  return handler(request);
};
