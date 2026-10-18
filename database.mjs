import pg from 'pg';
import { currentShop } from './shop-context.mjs';

let database;
export const getBaseDatabase = () => {
  if (!database) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', () => console.error('database connection failed'));
    database = { pool };
  }
  return database;
};

// Each lease owns its search_path until cleanup completes. Never return a tenant-configured
// connection to the shared pool, including on failed/aborted transactions.
export const scopedDatabase = (db, schema) => {
  if (!/^shop_[a-f0-9]{48}$/.test(schema)) throw new Error('Invalid shop schema.');
  const connect = async () => {
    const client = await db.pool.connect();
    try { await client.query('SELECT set_config(\'search_path\', $1, false)', [schema]); }
    catch (error) { client.release(error); throw error; }
    let released = false;
    return {
      query: (...args) => {
        if (released) throw new Error('Connection already released.');
        return client.query(...args);
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query('ROLLBACK');
          await client.query('RESET search_path');
          client.release();
        } catch (error) { client.release(error); }
      }
    };
  };
  return { pool: {
    connect,
    query: async (...args) => {
      const client = await connect();
      try { return await client.query(...args); } finally { await client.release(); }
    }
  } };
};

export const getDatabase = () => {
  const base = getBaseDatabase();
  const shop = currentShop();
  return shop ? scopedDatabase(base, shop.schema) : base;
};
