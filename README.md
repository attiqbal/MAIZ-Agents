# MAIZ agents

A store of AI employees for people who know nothing about AI. Browse, try, hire, and get work done, like shopping online.

Stage 1 is deliberately small: a basic package of AI employees (Finance manager, Marketing manager, Business consultant, HR manager) set up by a free Admin manager, one strong model, and the core platform they run on. Everything is a module so vendors, a marketplace, payments and integrations can be added later without rewrites.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module design and rules.

## Develop

```
npm install
npm run check   # typecheck and tests
```

Copy `.env.example` to `.env` for API keys. Never commit keys.

## Website

The marketing site, onboarding flow and control center live in `web/` (Vite + TypeScript, no framework).

```
cd web
npm install
npm run dev     # http://localhost:5173 (forwarded automatically in a Codespace)
npm run build
```

Before shipping a website change, run the browser QA (Playwright + axe-core at 375, 768 and 1440 wide) and update the evidence record, as described in [CLAUDE.md](CLAUDE.md):

```
npm run build && npm run qa
```

Set `SITE_URL` when building for the real domain (`SITE_URL=https://your-domain npm run build`); it fills the canonical link, Open Graph tags, `sitemap.xml` and `robots.txt`. Security headers for the host are in `web/public/_headers`.

Pages: `/` landing, `/onboarding.html`, `/app.html` (control center demo with example data; `/app.html#setup` is the Admin manager's setup form). Onboarding and the control center are front-end demos with simulated sign-in and data until the backend modules are wired in. Design tokens are in `web/src/styles.css`.

## Run it locally

```
npm install && (cd web && npm install)
npm run dev:api          # API on :8787 (mock AI unless ANTHROPIC_API_KEY is set; dev sign-up on)
cd web && npm run dev    # website on :5173, proxies /api to the API
```
Sign-up in development has no email check. Real sign-in (email link) is still to build, and the server will not start in production with dev sign-up on. Without `DATABASE_URL` data lives in memory and resets on restart; with it (plus `DATABASE_APP_URL` and `TOKEN_KEY`, see `.env.example`) everything is stored in Postgres and the API applies `db/*.sql` on start.

Tests: `npm run check` (fast, no database), `npm run db:test` (customer isolation) and `npm run db:int` (everything survives a restart). The last two start a throwaway local Postgres.

## Working with Claude Code

This repo uses the [ECC](https://github.com/affaan-m/ECC) agent harness. Website-relevant skills, agents and rules are pinned in `.claude/`; see [.claude/ECC.md](.claude/ECC.md) for how to enable the full ECC plugin, and [CLAUDE.md](CLAUDE.md) for the workflow.
