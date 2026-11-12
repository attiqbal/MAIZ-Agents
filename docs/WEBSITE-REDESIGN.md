# Website redesign: implementation brief

Status: **proposal, not approved. Nothing in `web/` changes until Atif signs off** (see "Decisions needed" at the end).

This brief turns Atif's redesign plan ("position MAIZ Agents as an AI workforce company") into something Claude Code can build. It reconciles the plan with the repo as it is today, so every claim below was checked against the code on `main` (commit `f6eb5fd`).

## 1. Where the site is today

- `web/` is a **multi-page static site built with Vite + TypeScript, no framework**. Fifteen HTML entry points (`index`, `pricing`, `employees`, `security`, `onboarding`, `signin`, `app`, owner pages, `404`) listed in `web/vite.config.ts`.
- Shared header, footer and `<head>` live once in `web/partials/` and are pasted in at build time (`<!--@include header-->`). A small SEO plugin fills canonical URLs, builds JSON-LD from the visible FAQ, and emits `robots.txt` and `sitemap.xml` (`INDEXED_PAGES`).
- The Node app **serves the built site itself**: `src/server/static.ts` serves `web/dist` (same security headers as `web/public/_headers`, `/foo` resolves to `/foo.html`, unknown paths get `404.html`). The `Dockerfile` builds web and API into **one container**; Caddy on Hetzner does HTTPS and proxies to it (`deploy/Caddyfile`).
- Marketing pages already share one stylesheet and one script bundle with the product (`web/src/styles.css`, `landing.ts`). Pricing numbers on the pricing page are overwritten at load from `GET /api/store` (`data-price` attributes), so the page cannot drift from `src/modules/pricing`.
- CSP is strict: `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`. Fonts: Inter Tight (headings) and Inter (body) from Google Fonts, which is the two-family limit in `CLAUDE.md`.

## 2. Recommendation: upgrade the existing pages, do not add a Next.js site

The plan proposes Next.js, Tailwind, Framer Motion and shadcn/ui as a separate marketing site. I recommend **against it for now**.

| Question | Existing Vite pages | Separate Next.js site |
|---|---|---|
| Deploy on the Hetzner box | No change: `docker compose ... up -d --build` | Second container (Node runtime), second Caddy route, second build and env, more RAM on a 8 GB box shared with Postgres |
| SEO | Already static HTML with JSON-LD and sitemap | Same result, more machinery |
| Prices stay true | Same origin: `/api/store` works under the current CSP | Cross-origin calls need CSP and CORS changes, or a build-time copy that can go stale |
| Design tokens | One `styles.css` shared by site and product (the owner's palette) | Tokens duplicated in Tailwind config; two systems drift |
| Performance budget (JS < 150 kB gz) | Landing JS today is tiny | React + Next + Framer Motion + shadcn eat much of the budget before any page code |
| Owner's rules | Matches "no framework", partials, `esc()`, QA gate | Needs new rules, new QA gate, new review skills |
| Cost of change | Edit HTML/CSS/TS we already test with Playwright + axe | Rebuild nav, auth links, footers, QA |

What the plan actually needs is available without Next.js:

- **Many SEO pages (employee, industry, use-case pages)**: generate them at build time from data the backend already has (`src/modules/workforce/job-descriptions.ts`, `blueprints.ts`, `onboarding/sectors.ts`) with a small Vite plugin, the same pattern as `partials()` and `seo()`. Output is plain `employees/finance-manager.html`; `static.ts` already resolves `/employees/finance-manager` to that file.
- **Animation**: CSS transitions plus a few lines of TypeScript for the demo (section 6). No Framer Motion needed.
- **Icons**: inline SVG (already the pattern).
- **Tailwind / shadcn/ui**: not needed. `styles.css` already is the design system.

**Revisit Next.js only if** pages need non-developer editing (a CMS), more than about 50 generated pages, or per-visitor personalisation. At that point the clean move is a separate `site/` app on its own subdomain behind the same Caddy, but that is a later decision with real traffic data.

## 3. Conflicts between the plan and the product (decide before building)

1. **Trial: no real conflict.** The product has a **7-day free trial, no card, with a 3,000-energy pool for the whole trial** (`src/modules/energy/index.ts`, `trial`). The plan's "7-day free trial" is correct; the "3,000 energy" detail is just missing from it. Copy must say both, e.g. "Free for 7 days, 3,000 energy, no card".
2. **Visual direction: this is a real conflict.** On 2026-11-11 Atif chose the light editorial "warm paper, one orange ember" style (tokens at the top of `web/src/styles.css`), replacing the dark aurora style. The plan proposes warm off-white plus **dark charcoal sections**, **electric lime/MAIZ green** accent, **Manrope or Inter**. Proposed reconciliation, to be approved:
   - Keep the paper canvas and tokens. The plan's "deep charcoal" is already in the palette as Graphite `#202020`: allow it for **one or two "product stage" bands** (the demo and the control-centre view) and the footer, never for whole pages.
   - Do not add lime. Introducing a second accent breaks "one orange ember". If Atif wants green, it must replace Ember everywhere, as a separate decision.
   - Keep Inter Tight + Inter. Manrope would be a third family and break the two-family limit.
   - Rounded cards vs the owner's square buttons and asymmetric cards: keep the owner's shapes.
3. **Sample prices in the plan must match pricing.** The plan's example "Finance Manager, £25/month, 2,000 energy, Available to hire" is wrong for this product. Finance is one of the five employees included in the **£100/month Team package (8,000 energy a week shared)**. Only **extra employees (£25/month, +2,000 energy/week)** and **specialists (£35/month, +2,000 energy/week)** are sold separately. The store cards must show store roles (not the five core ones) and read every price from `/api/store`, never from hard-coded text. Prices on the page stay labelled "draft list prices" until payments open.
4. **Claims that must stay honest.** Only claim what exists today:
   - Slack (live), Xero and Square (live, read only); other apps are CSV upload or via Zapier/Make (see `docs/INTEGRATIONS.md`). Show no logos for apps that are not live.
   - Security: use the existing `security.html` split of "In place today" and "Still to come". No SOC 2, ISO, encryption-at-rest or "enterprise-grade" claims; there has been no outside audit. Per-customer databases and prompt-injection defences are "still to come".
   - "Employees have portraits" (plan, section 6): use initials avatars or illustrated badges, not stock human photos, and say they are AI employees.
   - Industry examples must be framed as examples, not customer results. No testimonials or logos until there are real customers.
5. **Analytics (GA4 in the plan).** The CSP blocks third-party scripts and `connect-src` is `'self'`, and GA4 needs a UK cookie consent banner. Recommendation: Phase 5, choose a privacy-friendly tool (or PostHog) and extend the CSP deliberately; no tracking before that.
6. **"Live demo without registration".** `/app.html` already shows an example business to signed-out visitors (the "Explore the demo" link). The new "interactive demo" is a scripted, clearly labelled simulation on the homepage, not a second backend.

## 3a. Less text: copy and density rules (Atif, 2026-11-12: "like reading an essay, make it simple and less busy")

Today `index.html` has about 250 lines of prose-heavy cards (every employee card has a paragraph, three bullets and a "first deliverable"). The redesign must cut this hard. These rules apply to every page and are checked in review:

- **One idea per screen.** A section is a headline of at most 8 words, one line of support (at most 20 words), and one visual. No section has more than one paragraph.
- **Employee tile on the homepage: name, five-word job, one icon.** Nothing else. Responsibilities, deliverables and energy move to the profile page behind a "See job description" link.
- **At most 3 bullets, 6 words each**, only where a list beats a sentence. No bullet under a card that already has a paragraph.
- **Show, don't tell.** Prefer the demo stage, a real screenshot or a number over describing the product in words.
- **Homepage target: 6 sections** (hero, team tiles, demo stage, control centre, pricing teaser, final CTA). The 3-step "how it works", the long FAQ, security detail and industries each live on their own page or are linked, not stacked on the homepage. Cut the homepage to roughly a third of its current word count.
- **Pricing page: three cards and one line each**, then the team builder. Move the energy explanation and long FAQ answers behind `<details>` and keep each answer to two sentences.
- **Whitespace over dividers.** Larger section spacing, fewer cards and badges, one primary button per screen.
- **Plain words, no jargon**; the audience is small-business owners who know nothing about AI. Keep honesty notes (draft prices, simulated demo) as one short line, not a paragraph.
- QA addition: record the word count per page in `web/qa/evidence/evidence.json` and fail review if the homepage exceeds about 350 visible words.

## 4. Page structure and navigation

Keep flat file names (no framework router). New pages are added to `vite.config.ts` inputs and `INDEXED_PAGES`.

| Page | File | Status | Notes |
|---|---|---|---|
| Home | `index.html` | rebuild | Section 6 |
| AI employees | `employees.html` | upgrade | Already lists roles and job descriptions |
| Employee profile, one per role | `employees/<key>.html` | **new, generated** | From `job-descriptions.ts`; one H1, JSON-LD `Service`/`Product` only if prices are real |
| Employee store | `store.html` | **new** | Extra employees and specialists, prices from `/api/store`, "Hire" goes to onboarding or the app store screen |
| How it works | `how-it-works.html` | **new** | Onboarding in 3 steps, taken from the real signup flow |
| Control centre | `control-centre.html` | **new** | Screenshots of the real app, link to the demo |
| Pricing | `pricing.html` | upgrade | Add team builder (section 7); keep the hire-vs-MAIZ calculator |
| Security | `security.html` | keep | Edit only to match reality |
| Industries | `industries/<sector>.html` | **new, generated** | From `onboarding/sectors.ts` (13 sectors); Phase 4 |
| Sign in / Sign up | `signin.html`, `onboarding.html` | unchanged | `noindex` |

Header navigation (pill nav, from `partials/header.html`): Product (AI employees, Store, Control centre) · How it works · Pricing · Security · Sign in · **Start free trial**. Footer: all pages plus industries.

## 5. Design tokens and components

No new tokens file. The existing `:root` in `web/src/styles.css` stays the single source (palette, `--text-2`, `--text-muted`, `--accent-text`, `--line`, `--line-strong`, radii, spacing). Additions allowed:

- `--stage-bg: var(--color-graphite)` and `--stage-text: #fff`, used only on `.stage-band` sections.
- Components (all plain CSS classes + partials, no framework):
  - `employee-card` and `employee-profile` (initials avatar, title, department, responsibilities, example deliverables, integrations, energy per week, price from `/api/store`, job description link)
  - `store-card` (adds Hire button and "adds 2,000 energy a week")
  - `team-builder` (checkbox list + live price and energy total)
  - `demo-stage` (section 6) and `activity-feed` rows
  - `approval-card`, `status-pill` (queued / working / checking / waiting for you / done)
  - `industry-card`, `faq` (reuse `<details>`; the JSON-LD generator already reads this markup)
- Rules from `CLAUDE.md` stay: Orange never text or a button fill, Brass for readable accents, no `transition: all`, tabular numbers for figures, 40px+ hit areas, no shadows, no purple gradients, robots, glowing brains or particles.

## 6. Homepage specification

Headline from the plan: **"Hire a team. Not another tool."** with subline "Your AI employees manage the work behind your business. You stay in control." Final band: "Build your company. Hire your AI workforce. Stay in control."

Sections, in order:

1. **Hero**: H1 (the only one), subline, primary "Start free trial", secondary "Explore the demo" (`/app.html`), trust row ("7 days, 3,000 energy, no card", "Works in Slack", "You approve what leaves"). Right side: a still of the real control centre, not a mock.
2. **Your company, your AI team**: six employee tiles (Finance, Marketing, Business consultant, HR, Compliance, Admin manager "free"), each linking to its profile page.
3. **Demo stage** (Graphite band): the scripted walkthrough below.
4. **One command centre**: three real screenshots (needs-you, team, business health), the "does anything need me, is my team working, how is the business" framing already on the page.
5. **You approve, your team executes**: approval flow (nothing leaves without the owner; quality review; redo returns energy). Only describe behaviour that exists.
6. **Pricing teaser**: the three real cards (Team £100, extra employee £25, specialist £35) read from `/api/store`, plus the "draft prices" note.
7. **Industries** (Phase 4) and **FAQ** (existing, drives JSON-LD).
8. **Final CTA** band.

### Demo stage behaviour

Scripted client-side only, no API call, labelled "Example, simulated" on the stage.

1. Owner message appears: "Prepare a marketing campaign for our Christmas promotion."
2. Admin manager: "I'll bring in Marketing and Compliance." (task cards appear, status: queued)
3. Marketing manager: working (content calendar, three post drafts appear, energy counter ticks up with a plausible figure)
4. Quality check (status: checking)
5. Approval card for the owner: Approve / Redo / Open. Visitors can click **Approve**, which advances to "Ready to publish".

Implementation: one `web/src/demo-stage.ts` module (about 150 lines), a data array of steps, `setTimeout` sequence, IntersectionObserver to start when visible, Replay button. Accessibility: the stage is a labelled region, steps are real text in an `aria-live="polite"` log, a "Skip animation" button and `prefers-reduced-motion` show the final state at once, controls reachable by keyboard. All strings escaped with `esc()`.

## 7. Conversion features and where they live

| Feature | Plan | Build |
|---|---|---|
| Interactive team builder | yes | `pricing.html`; checkboxes for extra employees and specialists, total = £100 + £25 per extra + £35 per specialist, weekly energy = 8,000 + 2,000 per add-on. Constants come from `/api/store`, never hard-coded |
| ROI calculator | yes | Already exists (hire vs team package). Keep, label "estimate, not a guarantee" |
| Live demo | yes | `/app.html` demo plus the homepage stage |
| Industry pages | yes | Phase 4, generated from `sectors.ts` |
| Transparent trust | yes | A "What your team can see and do" block on `security.html`, built only from the implemented list (own workspace, row-level isolation, owner approval, audit trail, role permissions, per-employee data access) |

## 8. Responsive behaviour

Mobile first, breakpoints tested by the existing QA at 375, 768, 1440.

- 375: single column, hamburger nav (existing `initNav`), demo stage stacks messages above the approval card, tiles two per row, CTAs full width, no horizontal scroll.
- 768: two columns for employee tiles and pricing; demo stage keeps one column.
- 1440: container 1200px, hero two columns, demo stage two panes (chat left, tasks and energy right).
- Touch targets 40px or larger; body text at least 16px; the sticky header must not cover anchor targets (`scroll-margin-top`).

## 9. Hosting and deploy (Hetzner)

No new infrastructure. The redesign ships as part of the normal release:

1. Merge to `main`, then on the server `cd /opt/maiz && git pull && docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build` (`docs/INTERIM-HOSTING.md`). The Dockerfile builds `web/dist` with `SITE_URL=https://maizagents.com`.
2. New pages are included automatically because they are Vite inputs; sitemap and canonical URLs come from the SEO plugin.
3. If CSP is changed (analytics, fonts), update `web/public/_headers` only; the Node server and Caddy follow it.
4. Rollback: redeploy the previous git tag; there are no database changes in this project.
5. Because the app is a single instance, deploys cause a few seconds of downtime. Do them off-peak and check `/api/health` afterwards.

## 10. Phases

| Phase | Scope | Gate |
|---|---|---|
| 1. Foundation | Stage-band tokens, new components in `styles.css`, copy rewrite (headline, nav), content audit against section 3 | Atif approves the direction (decision 2) |
| 2. Homepage | Sections in section 6, demo stage, real screenshots | Finish gate below |
| 3. Product pages | Generated employee profiles, store page, how it works, control centre | Finish gate |
| 4. Commercial pages | Pricing team builder, security edits, FAQs, industry pages | Finish gate |
| 5. Polish and launch | Analytics (after consent decision), image optimisation, SEO check, performance run | Lighthouse and budget met |

Open **one PR per phase only if Atif prefers it**; the standing rule is one combined PR, so the default is a single PR built phase by phase.

Finish gate for every phase (from `CLAUDE.md`): `cd web && npm run build && npm run qa`, then `node ../.claude/skills/frontend-design-direction/scripts/check-evidence.js qa/evidence/evidence.json`, with `web/qa/evidence/evidence.json` updated from what was really checked and the screenshots looked at. Budgets: landing JS < 150 kB gz, CSS < 30 kB gz, at most two font families. WCAG 2.2 AA, one `main`, one H1 per page, honest titles of about 50 to 60 characters.

## 11. Decisions needed from Atif

1. **Approve upgrading the existing site instead of a new Next.js site** (recommended), or ask for the separate site anyway.
2. **Visual direction**: ~~keep the light editorial style with Graphite "product stage" bands, or switch to the plan's lime/charcoal look~~ **Decided by Atif 2026-11-12 (reply "B"): keep the light style with Graphite bands.** Still open: the plan to build, and the other items below.
3. **Typeface**: keep Inter Tight + Inter (recommended) or Manrope.
4. **Analytics**: which tool, and whether to add a cookie banner in Phase 5.
5. **Employee identity**: initials/illustrated avatars (recommended) or commissioned portraits.
6. Confirm the headline pair: "Hire a team. Not another tool." and "Build your company. Hire your AI workforce. Stay in control."
