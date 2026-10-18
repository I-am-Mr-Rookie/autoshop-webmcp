# Deepen notes (second pass)

Superpowers skills used: `superpowers:test-driven-development` (the bug fix was test-first, and the new tests were mutation-checked), `superpowers:verification-before-completion` (fresh full `npm test` runs before every claim), and `superpowers:systematic-debugging` (root-causing the ROLLBACK error masking before changing code).

I didn't redo anything from `REVIEW_FIXES.md`.

## What I examined

- `functions/_shared/postgres-repository.mjs`, in full: every transaction, lock order, idempotency/replay branch, snapshot comparison, mandate re-evaluation and stock decrement.
- All handlers in `functions/`, `server.js`, `database.mjs`, `migrate.mjs`, `persistence.js`, `domain.js`, and all 11 migrations, checking constraints, FKs and partial unique indexes against the code paths.
- `public/app.js` async handlers, looking for unhandled rejections. All of them already catch their errors.
- README setup commands. I ran them as far as is possible without a Postgres server.

Points I checked and found sound:
- Every seller mutation locks the seller row first, so all transactions take locks in the same order and cannot deadlock.
- JSONB key reordering doesn't break the `JSON.stringify` snapshot comparisons, because both sides of each comparison are read from JSONB.
- `TRUNCATE ... CASCADE` in reset also clears `seller_sessions`.
- Replay and conflict branches return the right result for each idempotency key.

## Biggest gap found: the repository SQL was never executed by any test

Before this pass, all 68 tests used in-memory or mocked repositories. The first pass said so explicitly. I added `test/postgres-repository.test.js`, which runs the **real migrations and real repository SQL** on PGlite (PostgreSQL compiled to WASM, running in-process). `npm test` still needs no database server.

### Tests added: 10 (suite went from 68 to 78, all passing)

| Test | Covers |
|---|---|
| migrations + seed | All 11 migrations apply in order. Reset and seed work through the repository's `TRUNCATE`. LIKE escaping: `_` and `100%` match nothing, `ddr` matches RAM. |
| buyer submission | Cart → confirm → submit. The order total matches the cart snapshot, the cart is emptied, a replay makes no duplicate order, and another session can't claim the order ID. |
| stale confirmation | A wrong cart version returns `STALE`, quantity over 20 returns `QUANTITY`, and an unknown product returns `null`. |
| in-mandate accept | Stock is decremented exactly once. Same key replays the receipt, same key with a different request returns `CONFLICT`, a fresh key on an accepted order returns `STALE`, and a bad seller session returns `FORBIDDEN`. |
| human exception | `APPROVAL_REQUIRED` leaves stock unchanged and reuses the live action. Commit before approval returns `STALE`, a second approval returns `CONFLICT`, and a wrong token returns `FORBIDDEN`. Commit writes a `human_exception` receipt, and a commit replay doesn't decrement again. `listSellerOrders` reflects all of this and is empty for an invalid session. |
| expired approval | Returns `EXPIRED_APPROVAL`. The token is persisted as `expired` and stock is untouched. |
| mandate change | A stale version is rejected. A pending order is re-evaluated to eligible, its approval is invalidated (the old approval can no longer commit), and a later accept goes through the mandate path at v2. |
| session sweeps | Expired buyer and seller sessions are deleted. The order survives with `buyer_session_id = NULL`. |
| login lockout | The 5th failure locks the account, and a failure after the lock expires restarts the count at 1. |
| ROLLBACK masking (regression) | See the fix below. |

**Mutation check:** I broke the code three ways: removed the LIKE escaping, stopped invalidating approval tokens on a mandate change, and removed the stock decrement in `commitAction`. Each time exactly the matching test failed (8/9 passed). The source was restored afterwards.

## Fix made

| Severity | Issue | Fix |
|---|---|---|
| Low–Medium | **A failed ROLLBACK hid the real error.** All 10 repository `catch` blocks ran `await client.query('ROLLBACK')`. If the connection had dropped, ROLLBACK threw too, so the caller got the ROLLBACK error instead of the original one. In `acceptOrder`/`approveAction`/`commitAction` this also skipped the `23505 → CONFLICT` mapping. The first pass fixed this only in `migrate.mjs`. | A one-line `rollback()` helper swallows ROLLBACK failures, and all 10 catch blocks use it. pg-pool already discards clients that are no longer queryable (`pg-pool/index.js` `_release`), so a dead client is never reused. The regression test was written first and failed for the expected reason ("connection lost" instead of "insert failed"); it now passes. |

## Dependency updates

- **No updates were available.** `npm outdated` reports nothing. `pg@8.23.1` is the latest version, and `npm audit` reports 0 vulnerabilities.
- **Added:** `@electric-sql/pglite@^0.5.10` as a **devDependency** only, for the real-SQL tests. It has no runtime effect, and the production dependency list is unchanged. If the Railway build doesn't prune dev dependencies, the image will be slightly larger (WASM Postgres).

## README / setup

- I ran the password-hash generation command and it works. The seed and `migrate.mjs` commands parse and run up to the database connection. With no server they fail with `ECONNREFUSED`, as expected. I couldn't run them against a real Postgres here.
- I corrected the one sentence that was now inaccurate ("tests use … in-memory repositories") to mention the PGlite test. Nothing else needed changing.

## Intentionally left alone

- **Missing indexes**: `pending_actions.order_id` (non-partial), `orders.created_at`, `orders.buyer_session_id`, `buyer_sessions.expires_at`. `listSellerOrders` and the session sweeps scan in full. That's negligible at demo scale, and adding them needs a new migration that runs on production, so it's the owner's call. The first pass made the same decision.
- **`migrate.mjs` on connection failure** throws from `pool.connect()` (outside the `try`) with a stack trace and exit code 1. The deploy still fails loudly, and no credentials are printed, so I left it.
- **Buyer 503 drops a fresh session's `Set-Cookie`.** If the session was created but a later query failed, the row is orphaned. It expires and is swept, so the impact is negligible.
- **Locked-account 429 is returned before scrypt runs.** This reveals timing for a locked username. There is only one, publicly documented, seller, so I left it.
- **Concurrency is not tested against real Postgres.** PGlite is single-connection, so the row-lock serialisation is verified only by reading the code (every seller transaction locks `seller_users` first). This is noted in a `shortcut:` comment in the test.
- **Demo reset `TRUNCATE ... CASCADE`.** The production-only `autoshop_data_imports` audit table (mentioned in the README) isn't in `migrations/`. If someone ever added an FK from it to an app table, a reset would wipe it. I couldn't verify this without production access. Worth a quick look by the owner.
- The other items in the first pass's "Deliberately not fixed" list are unchanged, for the same reasons.

## Final verification

`npm test` gives **78 tests, 78 pass, 0 fail** (fresh run after all changes). `npm audit` reports 0 vulnerabilities. Nothing was committed or pushed.
