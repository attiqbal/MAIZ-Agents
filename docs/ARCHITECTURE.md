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
| Integrations | `src/modules/integrations` | business apps (Xero, Square, Stripe live; BrightPay and any till by file; Zapier/Make webhook), encrypted credentials, per-employee access, pending records posted to the ledger on the owner's say. See `docs/INTEGRATIONS.md` |
| Admin manager | `src/modules/admin-manager` | welcomes the owner (dashboard or chat app), introduces the team, sends the setup form, then runs a journaled, rollbackable setup: profile, storage, models, training, checks |

### Signup to working team

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
- `src/modules/workforce/custom-roles.ts`: the Admin manager's role designer. `draftCustomRole` turns an owner's brief into a role blueprint and a full job description (same generator as blueprint specialists), flags regulated work and similar existing roles. The draft goes to the owner for sign-off.
- The rules are pure modules used by the website (`web/src/signoff-ui.ts` shows the client's tasks in review, `web/src/review.ts` is the platform owner's queue, `web/src/role-designer.ts`). Hiring a drafted specialist through the API is not built yet (see docs/AUDIT.md), and the agent run loop does not yet compile and submit briefs on its own.
- `web/src/dash.ts` holds the control center dashboards' example data in one place.

