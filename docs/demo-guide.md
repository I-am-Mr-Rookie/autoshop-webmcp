# Human + Agent Demo Guide

[Back to README](../README.md)

## Prerequisites

- The Railway Node.js application, PostgreSQL, and dedicated Clerk Google sign-in configuration.
- A browser/agent combination that actually supports the page's WebMCP API. Check tool discovery; do not infer support from a page loading.
- A Google account. Choose **Continue with Google**; no shared seller credential is needed.
- Permission to create/reset synthetic demo state. Never use real customer details, cards, or inventory.

The hosted demo uses a Clerk development instance. Each signed-in Google account receives an isolated synthetic shop. Use the same account in both portals; another evaluator's orders will not appear. See the verification record for observed checks and remaining limits.

## 1. Establish the seller's authority

Open `/seller` and continue with Google. Verify four seller tools: `get_mandate`, `list_orders`, `accept_order`, `commit_action`. Ask the agent to read the live mandate. In the seeded scenario, the item cap is five; trust the returned live value if the environment has been changed.

## 2. Create an order with buyer consent

Open `/buyer`. Verify only `browse_products`, `manage_cart`, and `submit_order` are available. Ask the agent to find DDR memory. Select Auto mode, add six units of the seeded 16 GB DDR5 RAM, enter clearly synthetic buyer details, and visibly confirm the exact cart. Then ask the agent to submit the displayed order ID.

Expected boundary: the agent cannot submit an unconfirmed cart merely by asking for it. Keep the confirmation token out of prompts, screenshots, and tool arguments.

## 3. Trigger an exception

Return to `/seller`. Ask the agent to list orders and accept the six-unit order with a fresh idempotency key.

Expected result with the five-unit mandate: `APPROVAL_REQUIRED`, a visible pending action, and no stock mutation. Do not claim success if the environment's policy or order state differs.

## 4. Approve the exact action

Review the pending action in the seller UI and check its explicit approval control. Ask the agent to call `commit_action` with the displayed action ID and a new idempotency key. The page—not the agent—attaches the action-specific authorization.

Inspect the receipt for the mandate version and approved-exception decision path. Return to the buyer portal and refresh; the accepted result should remain visible.

## Optional failure demonstrations

- Try submission before cart confirmation: it must not commit.
- Retry the same permitted operation with the same idempotency key: stock must not be applied twice.
- Let an approval expire or change its action: a fresh human review is required.
- Log out of the seller portal: seller tools should disappear and unauthenticated backend requests must fail.

Use only your authorized synthetic environment. Record observed results separately from expected results. A scripted conversation, a screenshot, or an automated test alone is not a new real-browser verification.
