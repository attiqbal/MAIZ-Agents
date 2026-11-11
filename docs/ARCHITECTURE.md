# Architecture (Stage 1)

A modular monolith in TypeScript: one application, strict module boundaries.

## Rules

1. Each module owns its own data. No module reads another module's storage directly.
2. Modules call each other through published interfaces and communicate by domain events (`src/core/events.ts`).
3. AI employees never touch storage or the system directly. Every action goes through a capability that checks permission, budget and audit.
4. Every record carries a workspace id. One workspace must never see another's data. Tests enforce this.
5. Global from day one: English at launch but text in translation files, money as smallest unit plus currency code, times in UTC, per-country tax rules as add-on packs.
6. AI costs: all model calls go through the Model Gateway. Cheap open models serve routine work, a stronger model serves hard steps and acts as fallback.

## Modules built so far

| Module | Path | Status |
|---|---|---|
| Events | `src/core/events.ts` | in-process bus |
| Audit | `src/modules/audit` | append-only, in memory |
| Identity | `src/modules/identity` | workspaces, roles, permissions, in memory |
| Model Gateway | `src/modules/model-gateway` | tier routing and fallback; Anthropic, OpenAI-compatible (vLLM on RunPod, hosted open models) and mock adapters |
| Model routing | `src/modules/model-gateway/routing` | RunPod first, Claude as supervisor. See `docs/AI-ROUTING.md` |
| Integrations | `src/modules/integrations` | business apps (Xero, Square, Stripe live; BrightPay and any till by file; Zapier/Make webhook), encrypted credentials, per-employee access, pending records posted to the ledger on the owner's say. See `docs/INTEGRATIONS.md` |
| Admin manager | `src/modules/admin-manager` | welcomes the owner (dashboard or chat app), introduces the team, sends the setup form, then runs a journaled, rollbackable setup: profile, storage, models, training, checks |

### Signup to working team

0. The signup screens ask three things by tapping: kind of business, what the owner wants help with, and apps already in use. `planSignup` in `src/modules/onboarding/recommend.ts` turns those into a plan by fixed rules (no AI call, no API key): which employees lead and their first jobs, add-ons to offer, apps and how each connects, currency, and answers for the setup form. Sector, need, app and country data live in `sectors.ts`. The website runs the same code to show the plan before the account exists; `POST /api/signup` reads the answers with `readSignupAnswers` (unknown keys dropped, text capped) and stores the plan on the blueprint as `signup`. `GET /api/setup` returns it as `prefill`, so the setup form arrives filled in with each answer labelled "you" or "guess". Design and research: https://claude.ai/artifact/2NNT6WwgaFF4Me4cL5uUtX
1. `OnboardingService.signUp` creates the workspace, books, trial energy, the basic team (Finance, Marketing, Business consultant, HR) and the free Admin manager.
2. `AdminManager.welcome` posts a welcome that lists every employee's capabilities, then the setup form link, to the dashboard inbox and to the owner's chosen chat app (held until connected).
3. `AdminManager.submitForm` validates the answers and runs the setup steps through `StepRunner`. Every step records its output and has an undo; a failure rolls back finished steps newest first. `AdminManager.rollback` lets the owner undo a finished setup.
4. Events `setup.completed`, `setup.failed` and `setup.rolled_back` are published for other modules.

## Next

PostgreSQL storage with row-level security by workspace, then Workforce (employee templates), Work (tasks), Messaging, Agent Runtime, Capability Registry, Metering and Budgets, Approvals, and the Catalogue (agent store). Storage is currently in memory behind simple classes so the real database can replace it module by module.

## Sign-off gate and custom roles

- `src/modules/workforce/signoff.ts`: specialised tasks (consultants, task-menu work) are proposals. The specialist compiles a brief and the directions it could take. The rules: `signOff` refuses while required information is missing or no direction is chosen, and `mayStart` is true only afterwards.
- `src/modules/review` (`QualityReviewService`): MAIZ quality review, the server-side gate. **The platform owner signs off, not the client.** Roles:
  - *Client* (a business that hires MAIZ employees, workspace role `owner`/`admin`/`member`): asks for the work, answers the specialist's questions, follows status ("In quality review"). Cannot approve, pick a direction, or see review notes and unchosen directions.
  - *Specialist*: compiles the brief and directions and submits it.
  - *Platform owner* (MAIZ): signed-in emails listed in `PLATFORM_OWNER_EMAILS`. Sees one queue across every client (`GET /api/owner/reviews`, page `web/review.html`), approves a direction or asks for more information. Every other user gets 403.
  - Status: `gathering_info` (client still answering) -> `in_review` (platform owner emailed) -> `more_info_requested` (back to the specialist) -> `in_review` ... -> `approved` (client told through the Admin manager; `mayStart` true). Every step is in the client's audit log with the actor (`user:`, `employee:`, `platform-owner:`). Items are stored as `state_records` kind `review` under the client's workspace.
  - Client routes: `GET /api/reviews`, `POST /api/reviews` (submit a compiled brief, until the agent run loop does it itself), `POST /api/reviews/:id/answer`. Owner routes: `POST /api/owner/reviews/:id/approve` (`direction`, `noteToClient`, `note`), `POST /api/owner/reviews/:id/request-info` (`question`, `note`).
- A setup that cannot undo itself (`rollback_failed`) emails the platform owner, since the client is told MAIZ has been alerted.
- `src/modules/workforce/custom-roles.ts`: the Admin manager's role designer. `draftCustomRole` turns an owner's brief into a role blueprint and a full job description (same generator as blueprint specialists), flags regulated work and similar existing roles. The client sends the draft to MAIZ.
- The rules are pure modules used by the website (`web/src/signoff-ui.ts` shows the client's tasks in review, `web/src/review.ts` is the platform owner's queue, `web/src/role-designer.ts`). Hiring an approved specialist and charging for it are not built yet (see docs/AUDIT.md), and the agent run loop does not yet compile and submit briefs on its own.
- `src/modules/review/specialists.ts` (`SpecialistReviewService`): custom specialists the client asks for (`POST /api/specialists`, needs `employee.hire`, at most 10 open per client) wait for the platform owner, who approves at a price, asks for changes or declines (`GET /api/owner/specialists`, `POST /api/owner/specialists/:id/decide`, page `web/owner-specialists.html`). `mayTrain` is false until approved. The owner is emailed; the client hears back through the Admin manager. Stored as `state_records` kind `specialist_req`.
- `src/modules/pricing` (`PriceBook`): the platform owner's prices and packages (`web/owner-prices.html`, `GET /api/owner/prices`, `POST /api/owner/prices/changes`, `DELETE /api/owner/prices/changes/:id`). Launch defaults plus dated changes: package prices, specialist prices, extra energy, trial length, default daily energy, each store item's price, energy, days and visibility, and each agent's own daily energy. A change can start now or on a date up to a year ahead, records what it replaced, and can be called off before it starts. The store (`/api/store`), cart quotes, new trials and the energy meter read it live. Changes are platform data, kept in `platform_records` (`db/003_platform.sql`), which the restricted app user cannot read.
- `GET /api/owner/clients` (`web/owner-clients.html`): every client with owner email, sign-up and trial dates, setup state, team size, energy today and this month, AI cost this month, and open reviews and specialists. The four owner pages share one menu (`web/partials/owner-nav.html`) and are `noindex`.
- `web/src/dash.ts` holds the control center dashboards' example data in one place.

## Payments, rota, nightly books check, live dashboard, hiring a specialist (added 10 November 2026)

- `src/modules/payments`: `PaymentProvider` is the only thing MAIZ code knows about a payment company (`createCheckout`, `cancelSubscription`, `parseWebhook`). `PaymentService` turns a cart into an `Order` priced on the server from the live price book (a price in the request is ignored), asks the provider to take payment, and on confirmation hires what was bought (`fulfil` in `platform.ts`) exactly once, even if the webhook is replayed. A paid order that cannot be fulfilled emails the platform owner. `MockPaymentProvider` charges nobody and signs webhooks with HMAC-SHA256 in `x-mock-signature`. With no provider (production today) `POST /api/checkout` answers "payments are not switched on yet". Routes: `POST /api/checkout`, `GET /api/orders`, `POST /api/orders/:id/cancel`, public `POST /api/payments/webhook`. A real provider (Stripe) is one class implementing the interface, see "Needs real keys" in docs/INTEGRATIONS.md.
- `src/modules/rota`: staff and shifts per client. Overlaps, 11 hours rest between shifts, a weekly cap (48 hours unless set per person) and a 16 hour shift limit are enforced in code; hours and labour cost are sums, never model arithmetic. The Rota coordinator and HR manager are given the real week and next week as context. Routes under `/api/rota/` (`week`, `staff`, `staff/:id/leave`, `shifts`, `shifts/:id/assign`, `DELETE shifts/:id`). There is no rota screen yet.
- `src/modules/reconciliation`: a read-only nightly check of every client's books. It runs once per client after their own local midnight (the time zone from their batch schedule), from the same one-minute timer as the batch dispatcher. It checks balanced and valid entries, the trial balance, reversals, one source booked twice, app records against ledger entries, paid orders never delivered, and a negative bank balance. Findings are questions for a person, nothing is changed. The platform owner is emailed once per client per day when a check finds errors; `GET /api/owner/reconciliation`, `POST /api/owner/reconciliation/run`, and a `books` field on `GET /api/owner/clients`.
- `GET /api/dashboard`: the client's control center from real records (each employee's energy per day, the task board from the batch queue, finished tasks and open questions from specialised tasks, the week's totals). Finished tasks are now stored (`state_records` kind `task`). `web/src/dash-live.ts` swaps these four screens from example data to real data when signed in; Approvals, Finance desk and Compliance calendar are still examples and keep their tag.
- `POST /api/specialists/:id/hire`: after the platform owner approves a custom specialist its client can hire it once, at the price MAIZ confirmed. The approved role and job description become a template only that client's workspace can use (`WorkforceService.registerCustomTemplate`), restored after a restart.
- New client records of these kinds go through one `Sink.record(workspaceId, kind, id, data)` method into `state_records`, so they need no new table.
