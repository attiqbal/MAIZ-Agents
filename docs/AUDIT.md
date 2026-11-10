# Audit of the combined release (10 November 2026)

What was checked before PRs #17, #18 and #19 were combined into one, what was fixed, and what is still open.

## How to repeat it

```
npm run check                      # typecheck + unit tests
npm run db:test && npm run db:int  # customer isolation and restart tests (needs PostgreSQL 16)
cd web && npm run build
ALLOW_DEV_AUTH=1 PORT=8787 WEB_DIST=web/dist npm start   # from the repo root, in another terminal
QA_URL=http://localhost:8787 npm run qa        # 17 pages and screens x 3 widths: axe, overflow, console
QA_URL=http://localhost:8787 npm run qa:flows  # 54 click-through checks
```

## Results

| Check | Result |
| --- | --- |
| Typecheck and unit tests | 165 pass, 1 skipped (the Postgres test, run separately) |
| Customer isolation (`db:test`) and restart (`db:int`) | pass |
| Website build | pass. Landing JS and CSS are inside the budget (CSS about 10 kB gzipped) |
| Accessibility and layout (`qa`) | 51 of 51 pass: 0 axe violations (WCAG 2.2 AA rules), no sideways scrolling, no console errors |
| Click-through (`qa:flows`) | 54 of 54 pass: every internal link and anchor, 404 page, security headers, sign-up to control center with the real API, ask bar, all ten control center screens, sign-off gate, role designer, store and cart, log in, mobile menus, skip link |
| Production dependencies (`npm audit --omit=dev`) | 0 known vulnerabilities |
| Security review of server, integrations, storage, website and deploy files | no critical or high findings; two medium findings fixed (below) |
| Secrets in the repository | none found (only test fixtures) |

## Problems found and fixed

- **Merging #18 and #19 broke the onboarding Slack step's layout.** Both used a CSS class called `app-row`. The Apps screen now uses `app-line`.
- **"Explore the demo" sent visitors to the log-in page** whenever the server was running. Logged-out visitors now see the example business with a clear bar saying so.
- **The demo banner was unstyled** and stretched over four lines.
- **Logged-out pages called the API and logged 401 errors.** They no longer ask.
- **Google and Microsoft buttons on sign-up did nothing** except say "coming soon". Removed until they work.
- **The logo was still a "V"** from the old name. It is now an "M".
- **The landing page said accounting and payments were "soon"** although Stripe, till uploads, BrightPay and Zapier or Make work. Xero and Square stay marked "soon" because they need app keys (see below).
- **Pricing's Custom plan mentioned sliders that do not exist.**
- **Heading order** on the employees and pricing pages (the h1 was a small label).
- **Signing up twice with the same email** said "opening it" and then showed the example business. It now asks the owner to log in.
- **Render blueprint and deploy guide did not list the Xero and Square settings** added by #19.
- **Security, medium: a connect link could be finished in someone else's browser.** An attacker could start "Connect Square" and send the approval link to a victim, attaching the victim's account to the attacker's organisation. App connections are now tied to the browser that started them (HttpOnly cookie) and work once. Slack install links now work once; they cannot be tied to a browser because the QR flow finishes on a phone.
- **Security, medium: one absurdly large amount could mark storage unhealthy until restart.** The ledger now refuses amounts above 10^15 minor units.

## Still open (not fixed here)

- **The control center's figures are examples.** Signed-in owners see their real team, energy, apps and setup; tasks, finance, usage, compliance and approvals show example data with an "Example data" tag. Each needs an API endpoint.
- **The sign-off gate and the role designer are not wired to the server.** The rules are tested (`src/modules/workforce/signoff.ts`, `custom-roles.ts`) and the screens work on example proposals, but proposals are not stored and a drafted specialist cannot be hired yet.
- **Payments.** Checkout is a placeholder. All prices are draft list prices.
- **Docker image.** There is no Docker daemon in the session that did this audit, so the image was not built locally. The CI `docker` job builds and starts it.
- **Screen readers.** Not tested with VoiceOver or NVDA.
- **Real services.** Not tested against real Slack, Resend, Neon, Anthropic, Stripe, Xero or Square. Xero and Square direct connections need `XERO_*` and `SQUARE_*` keys (docs/DEPLOY.md, 5b).
- **Low-risk security notes:** only POST requests are rate limited; sessions last 7 days with no server-side sign-out; the content security policy still allows inline styles; start-up does not check that `DATABASE_APP_URL` is the restricted database user; GitHub Actions and the base image are pinned by tag, not by hash.
- **Development tools.** `npm audit` in `web/` reports the Vite and esbuild development-server advisory. It affects local development only, and the fix is a major Vite upgrade.
