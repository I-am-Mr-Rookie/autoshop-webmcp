import { getDatabase } from './database.mjs';
import { tables, fingerprint } from './netlify/functions/migration-export.mjs';

const pool = getDatabase().pool;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query('SELECT pg_advisory_xact_lock(731904202)');
  await client.query(`CREATE TABLE IF NOT EXISTS autoshop_data_imports (
    source TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), counts JSONB NOT NULL, hashes JSONB NOT NULL
  )`);
  const source = 'netlify:ebc6f6d4-26d4-47ec-b574-b6388efa690c';
  if ((await client.query('SELECT 1 FROM autoshop_data_imports WHERE source = $1', [source])).rowCount) {
    console.log('Netlify data already imported; preserving current database.');
  } else {
    if (!process.env.MIGRATION_EXPORT_TOKEN) throw new Error('Missing export token');
    const response = await fetch('https://autoshop-webmcp.netlify.app/api/migration-export', {
      headers: { authorization: `Bearer ${process.env.MIGRATION_EXPORT_TOKEN}` }, signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error('Export unavailable');
    const snapshot = await response.json();
    if (snapshot.version !== 1 || tables.some(table => !Array.isArray(snapshot.data?.[table])
      || snapshot.counts[table] !== snapshot.data[table].length || fingerprint(snapshot.data[table]) !== snapshot.hashes[table])) throw new Error('Invalid snapshot');
    for (const table of tables) {
      if ((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount) throw new Error('Destination is not empty');
      const columns = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [table])).rows.map(row => row.column_name);
      for (const row of snapshot.data[table]) {
        const keys = Object.keys(row);
        if (keys.some(key => !columns.includes(key))) throw new Error('Unknown source column');
        const values = keys.map(key => row[key] !== null && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]);
        await client.query(`INSERT INTO ${table} (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, values);
      }
      const key = table === 'seller_sessions' ? 'token_hash' : 'id';
      const rows = (await client.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY ${key}`)).rows.map(row => row.record);
      if (fingerprint(rows) !== snapshot.hashes[table]) throw new Error('Imported records differ');
    }
    await client.query('INSERT INTO autoshop_data_imports (source, counts, hashes) VALUES ($1, $2, $3)', [source, snapshot.counts, snapshot.hashes]);
    console.log('Verified Netlify import:', JSON.stringify(snapshot.counts));
  }
  await client.query('COMMIT');
} catch {
  await client.query('ROLLBACK');
  console.error('Netlify import failed; no data was committed.');
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
