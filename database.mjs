import pg from 'pg';

let database;
export const getDatabase = () => {
  if (!database) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', () => console.error('database connection failed'));
    database = { pool };
  }
  return database;
};
