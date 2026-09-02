import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('creates or safely refreshes one versioned pending snapshot without stock mutation', async () => {
  const source = await readFile(new URL('../netlify/functions/_shared/postgres-repository.mjs', import.meta.url), 'utf8');
  const acceptOrder = source.slice(source.indexOf('async acceptOrder'), source.indexOf('\n  }\n});', source.indexOf('async acceptOrder')));
  const pendingBranch = acceptOrder.slice(acceptOrder.indexOf('if (!isOrderEligible'), acceptOrder.indexOf('const accepted'));

  assert.ok(acceptOrder.indexOf('FROM pending_actions WHERE idempotency_key') > acceptOrder.indexOf('FROM orders WHERE id = $1 FOR UPDATE'));
  assert.match(pendingBranch, /pending_actions[\s\S]+idempotency_key/);
  assert.match(pendingBranch, /current\.idempotency_key !== idempotencyKey[\s\S]+error: 'CONFLICT'/);
  assert.match(pendingBranch, /mandate_version[\s\S]+order_version[\s\S]+items[\s\S]+products/);
  assert.match(pendingBranch, /state = 'replaced'[\s\S]+approval_tokens SET state = 'invalidated'/);
  assert.ok(pendingBranch.indexOf("UPDATE orders SET status = 'pending'") < pendingBranch.indexOf("state = 'replaced'"));
  assert.match(pendingBranch, /ROLLBACK[\s\S]+db\.pool\.query[\s\S]+replayed: true/);
  assert.match(pendingBranch, /UPDATE orders SET status = 'pending'/);
  assert.match(pendingBranch, /INSERT INTO pending_actions[\s\S]+COMMIT/);
  assert.doesNotMatch(pendingBranch, /UPDATE products|INSERT INTO receipts/);

  const migration = await readFile(new URL('../netlify/database/migrations/007_pending-idempotency/migration.sql', import.meta.url), 'utf8').catch(() => '');
  assert.match(migration, /ADD COLUMN idempotency_key TEXT UNIQUE/);
  assert.match(migration, /FOREIGN KEY \(order_id\) REFERENCES orders\(id\) ON DELETE CASCADE/);
  const tokenMigration = await readFile(new URL('../netlify/database/migrations/008_approval-token-retention/migration.sql', import.meta.url), 'utf8').catch(() => '');
  assert.match(tokenMigration, /FOREIGN KEY \(action_id\) REFERENCES pending_actions\(id\) ON DELETE CASCADE/);
});
