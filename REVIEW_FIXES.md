# Review fixes

## What the project is

AutoShop is a Node 22 HTTP server (`server.js`) that serves framework-free buyer and seller pages and JSON APIs (`functions/*.mjs`) backed by PostgreSQL (`pg`, ordered SQL migrations in `migrations/`). The pages expose role-scoped WebMCP tools (`public/app.js`). A seller sets a numeric mandate. Orders within the mandate commit atomically. Orders outside it need an explicit, token-bound human approval before `commit_action` can succeed.

Overall the code is careful. It uses strict input contracts, parameterised SQL, row locks, idempotency keys, hashed one-time tokens, timing-safe scrypt login, same-origin checks on seller mutations, and a strict set of security headers. The review found no critical issues.

## Issues found and fixed

| Severity | Issue | Fix |
|---|---|---|
| Medium | **Unbounded `buyer_sessions` / `carts` growth.** Every cookie-less request to `/api/buyer` creates a session and a cart. An expired row was deleted only if its own cookie came back, which abandoned sessions never do. Crawlers or a simple loop could grow these tables forever. | `createBuyerSession` now deletes expired buyer sessions in the same transaction. Orders survive because the FK is `ON DELETE SET NULL` (migration 010). |
| Low | Expired `seller_sessions` were never swept, although an `expires_at` index exists for that purpose. | `createSellerSession` deletes expired seller sessions before inserting the new one. |
| Low | **LIKE wildcard injection in product search.** `%` and `_` in `query` acted as wildcards (for example, `_` matched every product). This is not SQL injection, because the query is parameterised, but it gave wrong search semantics. | `listProducts` escapes `\`, `%` and `_`. A test was added in `test/buyer.test.js`. |
| Low | An empty `APP_ORIGIN=` line (common when copying `.env.example`) made `new URL(req.url, '')` throw, so **every request returned 400**. | `server.js` falls back with `\|\|` instead of `??`. |
| Low | `migrate.mjs` swallowed the error, so a failed pre-deploy migration logged only a generic line. | It now logs the failing migration name and the error message, and still rolls back. |
| Low | Seller logout: if the `DELETE /api/seller/auth` fetch failed, the click handler raised an unhandled promise rejection. | The handler now catches the error. The UI still deactivates, as before. |
| Low | **Stale buyer cart after order submission.** The server empties the cart when an order is submitted, but the page kept showing the old items. Pressing `+` on a stale row then quietly re-added that product. | The buyer page reloads the cart after a successful submission, both from the button and from the `submit_order` tool. |
| Low | **"Authorization expired" shown after a successful agent submission.** `submit_order` cleared the token but left the page's expiry timer running, the Submit button visible, and the old status text. | The `autoshop:order-change` handler now calls `clearAuthorization()` (which clears the timer and hides the button), updates the status, and reloads the cart. |
| Low | **Cart rows lost product names and prices during a search.** Rows looked up products only in the current search results, so filtering for "SSD" showed a RAM row as `ram-1` at $0.00. | The page keeps a map of every product it has seen and uses it for cart rows. |
| Low | `migrate.mjs`: if `ROLLBACK` itself failed (for example, the connection dropped), it threw from the `catch` block and hid the real migration error. | `ROLLBACK` failures are ignored, so the original error is always logged. |
| Hygiene | Dead Netlify leftover: a special case for `/_redirects` in static serving. No such file exists, so it already returns 404. | Removed the special case. The existing test that `/_redirects` returns 404 still passes. |

## Deliberately not fixed

- **The CSP `script-src` allows a `sha256-…` hash that matches no inline script.** Neither HTML page has an inline script. The allowance is harmless, and `test/production-config.test.js` explicitly pins it. I left it alone so the frozen security config doesn't change without the owner's decision.
- **Seller account lockout can be triggered by anyone.** Five bad passwords lock the single seller account for 15 minutes, so a third party can lock out judges. Fixing this needs per-IP limiting or a captcha, which is an architecture change. Noted only.
- **No Origin check on seller login/logout (`/api/seller/auth`).** The session cookie is `__Host-` and `SameSite=Strict`, so login CSRF has very limited impact. Adding the check would break the current handler tests' request shape. Left as is.
- **Buyer endpoints have no Origin check.** The buyer cookie is `SameSite=Lax`, so cross-site POSTs arrive without it and only create a fresh, empty session. That is acceptable.
- **No rate limit on anonymous session creation.** Expired sessions are now swept, but live sessions (24 h) can still be created quickly. Rate limiting belongs at the platform edge.
- **`findBuyerSession` / `findSellerSession` run a DELETE on every authenticated read.** This is correct but costs a write per request. It's fine at demo scale, so I didn't change it.
- **When `APP_ORIGIN` is set, mutations from a different host alias are rejected** (for example, `127.0.0.1` vs `localhost` locally), because the Origin check compares against `APP_ORIGIN`. This is intended behaviour.
- **No index on `orders.buyer_session_id` or `buyer_sessions.expires_at`.** The expired-session sweep and the `ON DELETE SET NULL` cascade scan both tables in full. That's negligible at demo size. Adding an index needs a new migration that runs on production before deploy, so I'm leaving that decision to the owner.
- **Login can report success when the seller is disabled at the same moment.** If the seller is disabled between the password check and `createSellerSession`, the request returns 200 and sets a cookie, but no session row is written. The next request returns 401. This is a narrow race in a single-seller demo.
- **README:** no inaccuracies found. The tool counts, routes, health check, migration behaviour and local setup steps all match the code.

## Build / test results

- No build or lint step is defined. `npm test` runs `node --test`.
- Before installing dependencies, 12 of 34 reported tests failed because `pg` was missing (`node_modules` absent). After `npm ci`: **66/66 pass** before my changes.
- After all changes: **67/67 pass**, including one new test for LIKE escaping. `node --check` passes on the edited `public/app.js` and `migrate.mjs`.
- The buyer-page fixes are DOM-only code. No test harness covers it (the tests import `app.js` without a `document`), so I checked those changes only by reading the code. I didn't run them in a browser.
- None of the tests touch a real PostgreSQL database. They use in-memory or mocked repositories. The new expired-session `DELETE` statements and the LIKE escaping were **not run against a live Postgres**. The SQL is standard (Postgres's default LIKE escape character is `\`, and `standard_conforming_strings` is on by default).
