# Connecting a client's existing agents

Plan, not built yet. Written 12 November 2026.

A client may already run an agent of their own: customer service on their helpdesk, order tracking on their shop, a bot in their CRM. This plan says how that agent and MAIZ Agents work together without the client rebuilding anything.

## Recommendation

Treat an outside agent as a **teammate with a key**, not as an app. It gets one scoped API key, it can hand MAIZ employees work and read the answers, and MAIZ can call it back when something happens. Everything else (Zapier, MCP, Slack handoff) is a different front door onto the same two pipes.

Build in this order:

1. **Inbound API with scoped keys** (the one thing that unlocks every other pattern).
2. **Outbound signed webhooks** for events (answer ready, approval needed).
3. **Zapier and Make** reuse pipe 1 and 2 with no new server code, just a documented recipe.
4. **MCP server** later, as a thin wrapper over pipe 1 once a client asks for it.

Stage 1 ships only 1 and 2, plus one card on the Apps screen.

## What exists today (checked in the repo)

- `src/modules/integrations`: connectors for business **data** (sales, payroll, accounts). The private webhook link (`POST /api/integrations/hooks/:id/:secret`, secret hashed, shown once) already accepts data from Zapier or Make, but only the three record shapes. It cannot submit a task or return an answer.
- `workforce.assign(userId, orgId, employeeId, text, opts)` is the single door for work. The website ask bar and `ChannelRouter` (Slack and Teams) both go through it, so energy, permissions, the owner sign-off gate and MAIZ quality review already apply. An outside agent must use this same door.
- `AuditLog` is append-only and per workspace. `EnergyMeter` holds and charges energy per workspace. `rate-limit.ts` limits by address, and tasks are limited by energy, not request count.
- Sessions are people (`session(req)`). There are no machine credentials yet. This is the real gap.
- The account page today has an **Apps** screen (`web/app.html`, `data-screen="apps"`) with connection cards and per-employee access chips. There is no "Services" tab yet, so the plan adds external agents to the Apps screen and they can move under Services when that tab exists.

## Patterns and verdict

| Pattern | Use | Verdict |
| --- | --- | --- |
| Inbound API + scoped key | Their agent sends a job, polls or receives the result | **Build first.** |
| Outbound webhook | MAIZ tells their agent "answer ready", "needs approval", "energy low" | **Build with it.** |
| Zapier / Make | Clients with no developer | Recipes on pipes 1 and 2. No server work. |
| Slack / email handoff | Their agent posts into a shared channel or inbox | Slack already works for people; add an agent sender only if asked. Email ingest is blocked on a mail provider. |
| MCP server | Their agent is Claude, ChatGPT or similar and already speaks MCP | Later. Wrap pipe 1 as tools: `ask_employee`, `get_answer`, `list_approvals`. |
| A2A-style agent cards | Agent-to-agent discovery | Skip. No client demand and the spec is still moving. |

## Inbound API

Base: `https://maizagents.com/api/agent/v1`, JSON, `Authorization: Bearer maiz_live_…`.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/tasks` | `{ employee, text, reference?, callbackUrl? }` returns `{ id, status }`. `reference` is the client's own ticket or order id, echoed back. Supports `Idempotency-Key`. |
| GET | `/tasks/:id` | status (`queued`, `working`, `waiting_for_owner`, `done`, `refused`), answer, energy used |
| GET | `/tasks?reference=…` | find by their id |
| GET | `/employees` | which employees this key may talk to |

Rules:

- A task from a key runs `workforce.assign` as a **service principal** belonging to the organisation, not as the owner. It can never exceed the key's scopes.
- The owner sign-off gate and MAIZ quality review are unchanged. A task that needs sign-off returns `waiting_for_owner`; the external agent cannot approve its own work. Approvals stay a human action in the app.
- Answers are for the client's systems only, never routed to the client's customers by MAIZ. Their agent decides what to send onward.

## Outbound events

The client registers one HTTPS URL per connection. MAIZ POSTs `{ type, taskId, reference, … }` for `task.done`, `task.needs_owner`, `task.refused`, `energy.low`. Each request is signed (`MAIZ-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`, same scheme as Slack in `verifySlackSignature`), retried with backoff for 24 hours, and the URL must be public HTTPS (block private and link-local addresses to stop server-side request forgery). Polling `GET /tasks/:id` always works as a fallback.

## How it appears on the account page

A new **Outside agents** section on the Apps screen, same card style as app connections:

- Name the client gave it ("Zendesk bot"), status chip (**Connected**, **Quiet for 7 days**, **Key revoked**), last used.
- On/off switch. Off rejects its calls immediately with a clear error and keeps history.
- **Connect** opens a short form: name, which MAIZ employees it may talk to (the existing access chips), optional callback URL. The key is shown once, then only its first 8 characters. **Replace key** and **Remove** sit on the card.
- Plain words, no jargon: "Lets your own assistant send jobs to your MAIZ team and read the answers."
- Beside each recent job: who asked (the agent's name), the employee, energy used, and a link into the existing Approvals screen if the owner is needed.

## Auth and permissions

- Key format `maiz_live_<random>`; only a SHA-256 is stored, same as webhook links. Shown once. Never in logs.
- Scopes per key: `tasks.create`, `tasks.read`, and an explicit employee list. Default is Customer support only. **The Admin manager and Finance are never allowed**, matching the existing rule that the Admin manager cannot see app data.
- Owner or admin only can create, change or revoke a key (`workspace.manage`).
- Limits per key: requests per minute, plus a **daily energy ceiling** the owner sets on the card (default 10 percent of the weekly pool) so a looping outside agent cannot drain the team.
- Keys can expire (default 12 months). Revoke takes effect on the next call.

## Energy

- An externally triggered task is charged exactly like one typed in the ask bar: the energy meter holds before work starts, releases with the real cost afterwards, and draws from the same team pool.
- If the pool or the key's ceiling is empty, the API returns `402` with `{ reason, resetsAt }` and a `task.refused` event. Nothing queues silently.
- The usage page shows energy by source (You, Slack, each outside agent) so the owner sees what their bot costs.
- No per-task limit and no extra price in Stage 1. A separate "integration" price tier can come later if usage justifies it.

## Audit

Every call writes to `AuditLog` with actor `agent:<connectionId>`: `agent.connected`, `agent.key_replaced`, `agent.disabled`, `agent.task_submitted` (employee, reference, energy), `agent.task_refused` (reason), `agent.callback_failed`. Request bodies are not stored in the audit log, only ids and sizes. The owner sees these on the connection card as "Recent activity".

## Minimal Stage 1 build

Small, one PR, test first:

1. `src/modules/agents` : `AgentConnections` (create, hash key, scopes, enable/disable, revoke, daily ceiling) behind the sink so it persists like other connections.
2. Server: a `/api/agent/v1` router that authenticates the bearer key, maps it to a service principal and calls `workforce.assign`. Reuse the idempotency pattern from `receiveWebhook` and the existing JSON error shape.
3. Outbound sender with signing and retry, using the Batch module's queue for retries.
4. One card section on the Apps screen, reusing the connection card and access chips.
5. `docs/` page with three copy-paste recipes: curl, Zapier "Webhooks by Zapier", Make HTTP module.
6. Tests: key is hashed and shown once; wrong, revoked and disabled keys get 401; out-of-scope employee gets 403; idempotent retry does not double-charge; ceiling returns 402; owner sign-off still blocks delivery; SSRF URLs rejected; audit rows written.

Not in Stage 1: MCP, A2A, two-way sync of customer records, an SDK, agent-to-agent chat between a client's agent and MAIZ employees mid-task.

## Open questions for Atif

1. Is "Outside agents" on the Apps screen fine for now, or do you already have the Services tab design in mind?
2. Should the daily ceiling default be 10 percent of the weekly pool, or should outside agents be off until the owner turns them on and sets it (safer, my pick)?
3. Which first client use case do you want to test with: customer service tickets or order tracking? It decides which employee is the default and the example recipe.
