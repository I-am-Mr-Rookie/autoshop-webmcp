# Frontend notes

## What existed before

AutoShop already had a complete frontend. It is static HTML/CSS/JS with no framework and no build step, kept in `public/` and served by `server.js`:

- `public/home.html`: the landing page at `/`.
- `public/index.html`: the buyer and seller portal at `/buyer` and `/seller`. Its CSS is inline, and the two portal views are switched by `data-role-view`.
- `public/app.js`: an ES module with the portal logic and WebMCP tool registration.
- `public/img/*.svg`: illustrations and empty-state art.

The design was already deliberate: a token system, a 12-column grid, breakpoints at 1100/900/640px, reduced-motion handling and visible focus styles. So I kept the stack, structure and visual direction as they were, and made targeted fixes only.

## What I changed

| File | Change | Why |
|---|---|---|
| `public/index.html`, `public/home.html` | `--muted` changed from `#66747d` to `#5c6a73` | The old value measured 4.36:1 on the page canvas, below WCAG AA (4.5:1), and it is used for the eyebrow and footer text that sit directly on the canvas. The new value is ≥4.5:1 on every surface and tint it appears on. |
| `public/index.html`, `public/home.html` | At ≤640px, `.topbar .wrap` can now wrap (`flex-wrap: wrap; row-gap: 8px; padding-block: 6px`) | At about 320px, the brand plus three nav links are wider than the viewport. Because `body` has `overflow-x: clip`, the GitHub link was cut off. Now the nav moves to a second row only when it doesn't fit. |
| `public/index.html` | Moved `<nav class="topbar">` out of `<main>` and changed the active-link selector from `main:has(...)` to `body:has(...)` | Fixes the landmark structure (site nav inside the main landmark) and matches `home.html`. |
| `public/index.html` | In the seller login aside, moved `<p class="hint">` out of the `<dl>`. The box styling moved from the `dl` to a new `.tool-box` wrapper. | A `<p>` inside a `<dl>` is invalid HTML. The same bug had already been fixed in `home.html`. It looks the same as before. |
| `public/app.js` | Product-specific `aria-label`s on "Add to cart", the quantity −/+ buttons and "Remove" (e.g. "Increase DDR5 RAM quantity") | Previously every cart row read "Decrease quantity / Increase quantity / Remove", so screen-reader users couldn't tell which item a button belonged to. |
| `public/app.js` | Sets `aria-current="page"` on the active portal link (Seller/Buyer) | The active state was only visual (CSS); now assistive technology announces it too. |
| `test/lighthouse.test.js` | Added a test: no `<p>` inside `<dl>` in `index.html`, and the topbar comes before `<main>` | Guards the two markup fixes, the same way the existing `home.html` test does. |

There are no new dependencies, files or build steps.

## How to run

```bash
npm install
cp .env.example .env    # set DATABASE_URL etc. — API routes need PostgreSQL
npm run migrate         # first run only
npm start               # http://localhost:3000  (PORT overrides)
```

- `/` is the landing page, `/buyer` the buyer portal and `/seller` the seller portal.
- The static pages load without a database. The catalogue, cart and order panels then show API error messages.
- `npm test` runs the full suite. There is no frontend build; edit the files in `public/` and refresh the browser.

## Not verified

- No visual or browser check was done. The cached Playwright Chromium can't start on this host because the `libatk-1.0` system library is missing. Layout fixes were checked by working through the CSS by hand, and contrast by calculating the WCAG ratios.
