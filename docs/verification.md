# Verification Record

Revision: **October 18, 2026**. Baseline source synced to Railway-era commit `2a393c7`; earlier documentation edits were preserved before the fast-forward and reintegrated.

## Automated evidence

**82 tests passed, 0 failed, 0 skipped** after the Google-authentication and isolated-shop changes. The suite uses Node's test runner and PostgreSQL/WASM (PGlite).

New checks cover:
- anonymous and forged HTTP credentials rejected before shop provisioning;
- cross-origin writes rejected;
- old username/password payloads rejected;
- only verified Clerk request context can mint seller cookies;
- deterministic account-to-schema mapping and concurrent request context separation;
- separate PostgreSQL inventory, buyer/seller sessions, orders, pending actions, approvals, and receipts;
- one account's reset leaving another account's data unchanged;
- repeat provisioning preserving inventory;
- pooled connections rolling back failed transactions and clearing their tenant search path before reuse.

Existing checks cover buyer consent, seller mandates, expiring action-bound approvals, retries, transactional inventory/receipts, HTTP routing, and tool lifecycle.

## Live observations

Before this revision, the Railway landing page, buyer page, seller page, and `/healthz` returned HTTP 200; anonymous seller authentication returned 401. Railway reported a successful prior deployment.

Google sign-in configuration was created in a dedicated AutoShop Clerk development app with Google enabled and password authentication disabled. Configuration alone does not prove a completed OAuth session.

Post-change Railway deployment `e8197f6e-ab3b-4321-b84c-0fa7287373d1` reached **SUCCESS**. Live `/healthz`, `/buyer`, `/seller`, `/api/config`, and `/auth.js` returned HTTP 200. Anonymous buyer/seller API requests and a forged bearer token returned HTTP 401.

Koushik completed Google sign-in himself. The authenticated seller portal loaded its seeded mandate and four registered tools. Chrome's actual `document.modelContext.getTools()` exposed only the four seller tools; the buyer page exposed only its three buyer tools. Tools were invoked using their registered handles through Chrome's developer interface, not by calling exported application functions directly.

The live synthetic walkthrough passed:
- `get_mandate` returned the five-item limit and mandate version 1.
- `manage_cart` refused cart changes in Ask mode with `CONFIRMATION_REQUIRED`.
- After visible Auto selection, six RAM units were added; stock was initially 12.
- The exact cart was confirmed through the visible buyer form, using synthetic details only; `submit_order` created the requested order.
- `accept_order` returned `APPROVAL_REQUIRED`, and `commit_action` refused before visible seller approval.
- After checking and approving the displayed exception through the UI, `commit_action` returned a `human_exception` receipt.
- Reloading the buyer page recovered the accepted order and receipt; the catalogue reported stock 6.

One accepted synthetic verification order remains in Koushik's isolated demo shop. No real purchase or shipment occurred; no existing data was reset. The old seller-password variable was removed from Railway; a subsequent variable-name inventory confirmed its absence.

The initial live verification used local-source Railway deployment `e8197f6e-ab3b-4321-b84c-0fa7287373d1`. Koushik subsequently authorized committing and pushing the tested release to GitHub. Compare Railway's deployed commit with GitHub `main` for release provenance.

## Limits

- The automated unit suite does not complete Google OAuth; the separate live check above followed Koushik's own sign-in. A second real Google account was not tested live; two-account isolation is covered by PostgreSQL/WASM tests.
- Registered-tool calls prove this deterministic workflow, not general model-selection accuracy across arbitrary prompts.
- PGlite runs actual SQL/constraints, but does not prove all live PostgreSQL concurrency behavior.
- No real commerce, payments, shipments, production-identity certification, or independent penetration audit is claimed.
- The prior shared demo data is retained, not reset or exposed to new users.

## Reproduce

```powershell
npm ci
npm test
git diff --check
```
