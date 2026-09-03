import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('production configuration freezes security headers, generated-state ignores, and migration order', async () => {
  const [config, ignore, migrations] = await Promise.all([
    readFile(new URL('../netlify.toml', import.meta.url), 'utf8'),
    readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
    readdir(new URL('../netlify/database/migrations/', import.meta.url))
  ]);

  for (const header of [
    'Content-Security-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Permissions-Policy'
  ]) assert.match(config, new RegExp(header));
  assert.match(config, /sha256-mTJ4cJaTm2Gw95GeXEpZdvEEY9ybh6FZu1bwcNE7QlY=/);
  assert.match(ignore, /^\.playwright-cli\/$/m);
  assert.deepEqual(migrations.sort(), [
    '001_initial-schema',
    '002_buyer-confirmation',
    '003_order-submission',
    '004_seller-authentication',
    '005_mandate-versioning',
    '006_receipt-retention',
    '007_pending-idempotency',
    '008_approval-token-retention',
    '009_human-approval',
    '010_order-retention',
    '011_seller-sessions'
  ]);
});
