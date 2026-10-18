# Local Setup

[Back to README](../README.md)

## Tests without an external database or account

Requirements: Node.js 22.12+ and npm.

```powershell
npm ci
npm test
```

The tests use synthetic repositories and PGlite (real PostgreSQL compiled to WASM). Google OAuth is not exercised by the automated suite.

## Full application

1. Copy `.env.example` to `.env`. Set your own local PostgreSQL URL and a dedicated Clerk application's publishable and secret keys. Never commit this file.
2. Enable Google in Clerk; disable password authentication. `clerk-config.demo.json` records the non-secret demo configuration. Explicitly target the AutoShop app before applying it; never modify another project's app.
3. Run:

```powershell
node --env-file=.env migrate.mjs
node --env-file=.env server.js
```

Open [the seller portal](http://localhost:3000/seller) and choose **Continue with Google**. The server creates a fresh shop for that verified account. Open the buyer portal in the same signed-in browser to generate orders for that shop.

`npm start` runs the same full HTTP server when environment variables are supplied by the host. It is not a static preview. Without Clerk/database configuration, static pages may load but authenticated operations fail closed.

## Isolation and reset

Never run an unscoped reset against production. Use the seller portal's explicit reset control; it is authenticated, same-origin checked, and restricted to the current account's schema. Historical shared data is not migrated into new accounts.

Use synthetic buyer details only. The demo has no payment or shipment flow.

## Hosted authentication

The current Railway demo uses a dedicated Clerk development instance, which supplies shared Google OAuth credentials. For production identity, configure a domain you control, a production Clerk instance, your own Google OAuth credentials, and exact permitted origins. Keep the Clerk secret key server-side.
