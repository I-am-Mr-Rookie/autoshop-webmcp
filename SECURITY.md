# Security Boundaries

AutoShop is a synthetic agent-commerce demonstration, not a production payment or fulfilment system. Use only synthetic buyer details and inventory.

## Implemented controls

- Clerk Google sign-in; session token verification on every application API request, restricted to the configured application origin.
- No username/password login endpoint or seller password environment setting.
- Server-derived shop schemas selected from verified Clerk user IDs, never from URL parameters, headers, or tool arguments.
- Per-account products, carts, orders, mandates, approvals, receipts, and session tables. No fallback to the former shared shop.
- Connection leases reset their search path before returning to the shared PostgreSQL pool.
- Separate buyer/seller Secure, HttpOnly, SameSite cookies within the authenticated shop.
- Strict tool schemas, backend validation, same-origin writes, action-bound expiring approvals, transactions, and idempotency.
- CSP allows the configured Clerk frontend domain and documented protection services; it does not grant arbitrary script origins.
- Role-scoped tools and cleanup on logout, expiry, account changes, and navigation.

These are source/test-backed mechanisms, not an independent security audit. A verified identity does not authorize a transaction without the buyer/seller approval checks.

## Important limits

The hosted demo currently uses a dedicated Clerk **development instance**. Production requires a controlled domain, production OAuth credentials, identity configuration, operational controls, provisioning quotas, retention policy, and a separate review.

A compromised application database role could access more than one schema: these schemas implement an application-enforced tenant boundary, not database roles per tenant or PostgreSQL RLS. No route accepts SQL or a client-selected schema. SQL injection or arbitrary backend execution would require a broader threat response.

The application does not copy Google profile data into the shop, but Clerk processes identity for sign-in. Do not enter real customer data. Long-lived demo schemas need explicit retention/cleanup before broad public use.

## Reporting

Never publish credentials, session cookies, approval tokens, private data, or an exploit against a live system in a public issue. Use GitHub private vulnerability reporting if enabled; otherwise arrange a private maintainer channel first. No dedicated address or response-time guarantee is asserted.

See [architecture](docs/architecture.md) and [verification](docs/verification.md).
