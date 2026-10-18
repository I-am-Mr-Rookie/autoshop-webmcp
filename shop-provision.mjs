import { readFile, readdir } from 'node:fs/promises';
import { getBaseDatabase } from './database.mjs';
import { createSeedRecords } from './persistence.js';

const directory = new URL('./migrations/', import.meta.url);
const migrations = readdir(directory).then(async names => Promise.all(names.filter(name => /^\d+_/.test(name)).sort()
  .map(async name => [name, await readFile(new URL(`${name}/migration.sql`, directory), 'utf8')])));
const ready = new Set();

export const provisionShop = async (schema, db) => {
  if (!/^shop_[a-f0-9]{48}$/.test(schema)) throw new Error('Invalid shop schema.');
  const shared = !db;
  db ??= getBaseDatabase();
  if (shared && ready.has(schema)) return;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query('SELECT set_config(\'search_path\', $1, true)', [schema]);
    await client.query('CREATE TABLE IF NOT EXISTS autoshop_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    for (const [name, sql] of await migrations) {
      const applied = await client.query('SELECT 1 FROM autoshop_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      await client.query(sql);
      await client.query('INSERT INTO autoshop_migrations (name) VALUES ($1)', [name]);
    }
    await client.query('CREATE TABLE IF NOT EXISTS shop_initialized (id INTEGER PRIMARY KEY CHECK (id = 1))');
    const seeded = await client.query('INSERT INTO shop_initialized (id) VALUES (1) ON CONFLICT DO NOTHING RETURNING id');
    if (seeded.rowCount) {
      const records = createSeedRecords();
      for (const p of records.products) await client.query('INSERT INTO products (id, name, price_cents, stock, version) VALUES ($1,$2,$3,$4,$5)', [p.id,p.name,p.priceCents,p.stock,p.version]);
      const m = records.mandates[0];
      await client.query('INSERT INTO mandates (id,max_items,max_total_cents,max_discount_percent,min_remaining_stock,state,version) VALUES ($1,$2,$3,$4,$5,$6,$7)', [m.id,m.maxItems,m.maxTotalCents,m.maxDiscountPercent,m.minRemainingStock,m.state,m.version]);
      // Historical nullable password column retained for migration compatibility, not authentication.
      await client.query("INSERT INTO seller_users (id,username,password_hash,status,version) VALUES ('seller-1','seller',NULL,'active',1)");
    }
    await client.query('COMMIT');
    if (shared) {
      if (ready.size >= 1000) ready.delete(ready.values().next().value);
      ready.add(schema);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
};
