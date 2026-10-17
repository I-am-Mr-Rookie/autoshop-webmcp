import { readFile, readdir } from 'node:fs/promises';
import { getDatabase } from './database.mjs';

const pool = getDatabase().pool;
const client = await pool.connect();
let current;
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(731904202)');
  await client.query(`CREATE TABLE IF NOT EXISTS autoshop_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const directory = new URL('./migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d+_/.test(name)).sort();
  for (const name of names) {
    const applied = await client.query('SELECT 1 FROM autoshop_migrations WHERE name = $1', [name]);
    if (applied.rowCount) continue;
    current = name;
    await client.query(await readFile(new URL(`${name}/migration.sql`, directory), 'utf8'));
    await client.query('INSERT INTO autoshop_migrations (name) VALUES ($1)', [name]);
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
} catch (error) {
  // A failed ROLLBACK (e.g. dropped connection) must not hide the original migration error.
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Database migration failed${current ? ` in ${current}` : ''}; no changes were committed.`, error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
