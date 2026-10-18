# Architecture and Trust Boundaries

[Back to README](../README.md)

AutoShop is a browser-agent integration and an authorization demonstration. It does not contain an embedded model, model training, payment processing, or a general agent framework.

## Source map

| Layer | Location | Responsibility |
|---|---|---|
| Human-facing pages | `public/home.html`, `public/index.html` | Product overview, buyer and seller portals |
| Browser integration | `public/app.js` | Seven tool contracts, UI state, API calls, role registration/cleanup |
| Domain rules | `domain.js`, `persistence.js` | Mandate decisions and deterministic state behavior |
| Server boundary | `functions/` | Request validation, authentication, confirmation, order/approval endpoints |
| Database operations | `functions/_shared/postgres-repository.mjs` | State checks, transactions, inventory and receipts |
| Schema | `migrations/` | Ordered database migrations |
| HTTP and security headers | `server.js`, `clerk-auth.mjs` | Routing, Clerk verification, same-origin writes, CSP |
| Account isolation | `shop-context.mjs`, `shop-provision.mjs`, `database.mjs` | Verified identity, transactional schema provisioning, scoped pooled connections |
| Automated checks | `test/` | Synthetic contracts, handlers, state transitions, browser doubles |

## Account boundary

Google sign-in is handled by a dedicated AutoShop Clerk app. The HTTP adapter verifies a Clerk session for every application API call, checks the authorized origin, and derives a schema from the verified user ID. Neither a tool nor a client header can select another account's shop.

The first request transactionally applies the ordered migrations and synthetic seed records inside that schema. Existing stock is not reset on subsequent requests. Buyer and seller portals in the same signed-in account operate on that account's shop.

Each database connection lease sets its tenant search path and clears it before the shared pool can reuse the connection. Request identity uses AsyncLocalStorage so concurrent requests cannot change a global current-tenant variable. The old shared schema is retained but is not an API fallback. This is application-level isolation, not a database role per tenant or RLS.

## Three different kinds of permission

1. **Tool availability:** the current page and authenticated role determine which tools are registered.
2. **Buyer consent:** a specific cart needs visible human confirmation before order submission. The browser supplies the resulting authorization internally; the agent does not invent it or pass it as a schema field.
3. **Seller authority:** the current mandate permits a bounded acceptance. Anything outside that mandate requires a specific pending action and human approval before commit.

A tool name, schema annotation, model statement, DOM change, or buyer-supplied note grants none of these permissions by itself. The backend rechecks the operation.

## Within the mandate

`accept_order` sends a bounded order/quantity request with an idempotency key. The authenticated backend revalidates live order state, mandate, and inventory. Inventory mutation and receipt creation are transactional. A successful receipt identifies the mandate version and authority path.

## Outside the mandate

1. Acceptance returns `APPROVAL_REQUIRED` and a pending action, without changing stock.
2. A seller reviews that action and explicitly approves it in the UI.
3. The browser receives a short-lived action-specific authorization.
4. `commit_action` invokes the backend with that authorization attached internally, not exposed as a tool parameter.
5. The backend checks session, binding, expiry, current state, and idempotency before committing.

Reusing a token for another action, an expired approval, a changed action, or an incompatible idempotency key must not authorize the mutation. Repository and handler tests exercise these failure paths; see [verification limits](verification.md).

## Untrusted content

Buyer-authored order text is marked untrusted by `list_orders`. Tool descriptions remind the agent that it cannot authorize an operation. This annotation is a useful signal, not proof that every model will resist every prompt injection. Server-side authorization is the enforceable boundary.

## Lifecycle

Registration uses an `AbortController` signal. Seller tools become available after authentication and are removed on logout, expiry, or navigation away from seller scope. Read the lifecycle tests before changing registration; do not turn role isolation into a global tool registry.

## Deliberate simplicity

One seeded seller and a fixed synthetic catalogue per account, no real payments, and no multi-store administration keep the demonstration centered on authority. Extending it to real commerce would require a separate threat model, privacy/data-retention policy, operational controls, and substantially broader validation.
