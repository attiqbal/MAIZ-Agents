# Connecting a client's existing agents

Plan, not built yet. Written 12 November 2026, revised the same day after Atif's feedback: connecting must be easy, the owner turns it on and sets the limits, it must work for any task, and the Admin manager plans it.

## Recommendation

Treat an outside agent as a **teammate with a key that the owner switches on**. It gets one scoped API key, can hand MAIZ employees any job and read the answer, and MAIZ calls it back when something happens. The **Admin manager plans the whole connection with the owner**, so the owner never has to read API documentation.

Four parts, built in this order:

1. **Inbound task API with scoped keys** (the door for any task).
2. **Outbound signed webhooks** (answer ready, needs approval, energy low).
3. **Owner controls**: off by default, on only when the owner turns it on and sets limits.
4. **Admin manager connection planner**: interviews the owner, proposes the setup, applies it after the owner confirms, and can roll it back.

Zapier and Make reuse parts 1 and 2 with recipes, not new server code. MCP comes later as a thin wrapper. Skip A2A.

## What exists today (checked in the repo)

- `src/modules/integrations`: connectors for business **data** (sales, payroll, accounts). The private webhook link (`POST /api/integrations/hooks/:id/:secret`, secret hashed, shown once) accepts only those three record shapes. It cannot submit a task or return an answer.
- `workforce.assign(userId, orgId, employeeId, text, opts)` is the single door for work. The ask bar and `ChannelRouter` (Slack, Teams) both use it, so energy, permissions, the owner sign-off gate and MAIZ quality review already apply. Outside agents use this same door.
- `AdminManager` (`src/modules/admin-manager`) already plans and applies a client's setup: a form, `submitForm`, provisioning steps, `startFirstJobs`, and `rollback`. The connection planner is a second job for it, not a new system.
- `AuditLog` is append-only per workspace. `EnergyMeter` holds and charges energy per workspace. Tasks are limited by energy, not by request count.
- Sessions are people. There are no machine credentials yet. That is the real gap.
- The account page has an **Apps** screen (`web/app.html`, `data-screen="apps"`) with connection cards and per-employee access chips. There is no Services tab yet, so outside agents go on the Apps screen and can move later.

## Design: easy to connect

The owner should reach "working" in about five minutes, with no code.

**Step 0, a plain-language entry.** On the Apps screen, a card "Connect your own assistant". Off until the owner presses it.

**Step 1, the Admin manager asks three questions** in the chat the owner already uses, as tap choices where possible:

1. What does your assistant do today? (Customer service, order tracking, bookings, something else you type.)
2. Where does it live? (Helpdesk or shop app by name, Zapier or Make, a website chat, custom code, not sure.)
3. What should it be allowed to hand to your MAIZ team? (Suggested from step 1.)

**Step 2, the Admin manager proposes a connection plan** the owner can read in one screen:

- Which MAIZ employees receive its jobs and which kinds of job (the routing).
- Limits (see below), already filled in with safe defaults for that business.
- The exact way to connect, picked for their tool: a Zapier or Make recipe, a copy-paste snippet for developers, or "send this page to whoever built your assistant".
- What happens when an answer needs the owner, and who is told.

**Step 3, the owner confirms** and the key appears once, with a **Send test job** button. The card turns **Connected** only after a test job succeeds end to end. A failed test shows the reason in plain words and the Admin manager suggests the fix.

Every step is reversible: the Admin manager's existing `rollback` removes the connection and its key.

## Design: owner turns it on and sets limits

Off by default for every organisation. Only the owner or an admin of the workspace (`workspace.manage`) can switch it on, change limits, or revoke. Neither the Admin manager nor the outside agent can raise a limit or turn anything on by itself. The Admin manager can only **propose**; the owner presses confirm.

Limits the owner sets on each connection (all shown on its card, all editable any time):

| Limit | Default proposed | Effect when reached |
| --- | --- | --- |
| Daily energy ceiling | 10 percent of the weekly pool | Jobs refused with a clear reason until tomorrow, owner told once |
| Energy per job | 2 percent of the weekly pool | A bigger job waits for the owner instead of running |
| Jobs per hour | 60 | Further calls get `429` with a retry time |
| Employees it may use | Customer support only | Other employees return `403` |
| Active hours (optional) | Always | Outside hours, jobs queue for the next window |
| Needs my approval first (optional) | Off | Every job waits in Approvals until the owner approves |
| Key expiry | 12 months | Key stops working, owner told two weeks before |

Admin and Finance employees can never be added to an outside agent's list, matching the existing rule that the Admin manager cannot see app data.

## Design: flexible for any task

The API does not know about "customer service" or "orders". A job is just **an employee, instructions, and optional structured data**:

```
POST /api/agent/v1/tasks
{ "employee": "customer-support",
  "text": "Customer asks where order 4471 is. Draft a reply.",
  "data": { "orderId": "4471", "status": "shipped", "carrier": "DPD" },   // optional, any JSON, size-limited
  "reference": "TICKET-9921",                                             // their own id, echoed back
  "expect": "text" | "json",                                              // json asks for a structured answer
  "callbackUrl": "https://…" }                                            // optional, overrides the connection default
```

- Anything an employee can do from the ask bar, an outside agent can ask for, inside its allowed employee list. New employees and new task types need no API change.
- `data` is passed to the employee as quoted input (never as instructions) and is size-limited, so an outside system cannot inject orders to the employee.
- Presets only pre-fill the plan: "Customer service", "Order tracking", "Bookings", "Reports", "Custom". The owner and Admin manager can change everything, and Custom starts blank.
- The Admin manager records the plan as a **connection profile** (routing rules, limits, notify rules). Later changes to a client's needs mean editing the profile, not new code.

## Admin manager as planner

New job for the Admin manager, using the setup machinery it already has:

- **Plan**: interview as above, write the connection profile, estimate typical weekly energy from the answers ("about 15 percent of your pool at 40 tickets a day") so limits are chosen with a number in front of the owner.
- **Apply**: create the connection in a disabled state, wire routing, pre-fill the recipe. Enable only on the owner's confirm.
- **Watch**: weekly note to the owner: jobs handled, energy used against the ceiling, refusals, failures. It proposes limit changes ("raised ceiling to 15 percent? you hit it twice") but never applies them.
- **Troubleshoot**: if callbacks fail or the test breaks, it explains the fix in plain words and can re-run the test.
- **Boundaries**: it never sees the key after creation, never changes limits or access without the owner, and every change is audited as `admin-manager`.

## Patterns and verdict

| Pattern | Verdict |
| --- | --- |
| Inbound API + scoped key | **Build first.** The door for any task. |
| Outbound webhook | **Build with it.** |
| Zapier / Make | Recipes on the same API. The Admin manager picks the right one in step 2. |
| Slack / email handoff | Slack already works for people. Add an agent sender only if asked. Email ingest is blocked on a mail provider. |
| MCP server | Later. Wrap the API as tools (`ask_employee`, `get_answer`, `list_approvals`) when a client's agent speaks MCP. |
| A2A agent cards | Skip until a client needs it. |

## Inbound API

Base `https://maizagents.com/api/agent/v1`, JSON, `Authorization: Bearer maiz_live_…`.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/tasks` | submit a job (above); supports `Idempotency-Key` |
| GET | `/tasks/:id` | status (`queued`, `working`, `waiting_for_owner`, `done`, `refused`), answer, energy used |
| GET | `/tasks?reference=…` | find by their id |
| GET | `/employees` | which employees this key may use |
| GET | `/limits` | remaining ceiling today, so their agent can slow itself down |

- A job runs `workforce.assign` as a **service principal** of the organisation, never as the owner, and never beyond the key's scopes.
- The owner sign-off gate and MAIZ quality review are unchanged. A job needing sign-off returns `waiting_for_owner`. The outside agent cannot approve its own work.
- MAIZ never sends answers to the client's customers. Their agent decides what goes onward.

## Outbound events

One HTTPS URL per connection. MAIZ POSTs `{ type, taskId, reference, … }` for `task.done`, `task.needs_owner`, `task.refused`, `energy.low`. Requests are signed (`MAIZ-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`, as in `verifySlackSignature`), retried with backoff for 24 hours, and the URL must be public HTTPS (block private and link-local addresses against server-side request forgery). Polling `GET /tasks/:id` always works as a fallback.

## How it appears on the account page

An **Outside agents** section on the Apps screen, same card style as app connections:

- Name, status chip (**Off**, **Waiting for test**, **Connected**, **Quiet for 7 days**, **Key revoked**), last used.
- On/off switch. Off rejects calls at once and keeps history.
- Limits editable inline, each with a plain sentence ("Stops at 10 percent of your weekly energy a day. Used today: 4 percent.").
- **Replace key** (shows once, first 8 characters afterwards), **Send test job**, **Remove**.
- Recent jobs: who asked, which employee, energy used, a link to Approvals if the owner is needed.
- Wording stays plain: "Lets your own assistant send jobs to your MAIZ team and read the answers."

## Auth and permissions

- Key `maiz_live_<random>`, only a SHA-256 stored (same as webhook links), shown once, never logged.
- Scopes per key: `tasks.create`, `tasks.read`, plus the employee list.
- Per-key request and energy limits as above.
- Revoke or switch-off takes effect on the next call.

## Energy

- A job is charged exactly like one typed in the ask bar: hold before work, release with the real cost, from the same team pool.
- A refused or failed job refunds, as the fair-billing rules already require.
- When the pool or the ceiling is empty the API returns `402` with `{ reason, resetsAt }` and fires `task.refused`. Nothing queues silently.
- The usage page splits spend by source (You, Slack, each outside agent).
- No per-task limit and no extra price in Stage 1.

## Audit

Every call writes to `AuditLog`: actor `agent:<connectionId>` for the outside agent and `admin-manager` or `user:<id>` for changes. Events: `agent.proposed`, `agent.enabled`, `agent.disabled`, `agent.limits_changed`, `agent.key_replaced`, `agent.task_submitted` (employee, reference, energy), `agent.task_refused` (reason), `agent.callback_failed`. Bodies are not stored in the audit log, only ids and sizes. The owner sees "Recent activity" on the card.

## Stage 1 build

One PR, tests first.

1. `src/modules/agents`: `AgentConnections` (profile, hashed keys, scopes, limits, enable/disable, revoke) persisted through the sink like other connections.
2. `/api/agent/v1` router: bearer auth, service principal, limit checks, calls `workforce.assign`, idempotency.
3. Outbound sender with signing, retry via the Batch queue, and an SSRF guard.
4. Admin manager planner: the three questions, the proposal, apply-disabled, enable on owner confirm, test job, rollback, weekly note.
5. Apps screen section and the connect flow (steps 0 to 3).
6. Docs page with recipes for curl, Zapier "Webhooks by Zapier" and the Make HTTP module.
7. Tests: key hashed and shown once; disabled or revoked key gets `401`; out-of-scope employee `403`; off by default; Admin manager cannot enable or raise limits; ceiling returns `402`; per-job cap holds the job; idempotent retry does not double-charge; sign-off still blocks delivery; SSRF URLs rejected; audit rows written; rollback removes the connection.

Not in Stage 1: MCP, A2A, two-way sync of customer records, an SDK, mid-job back and forth between their agent and a MAIZ employee.

## Open questions for Atif

1. Is the Apps screen the right home, or do you already have the Services tab design in mind?
2. Are the proposed defaults right (10 percent of the weekly pool a day, 2 percent a job, 60 jobs an hour, Customer support only)?
3. Which first client use case should we test with: customer service tickets or order tracking? It sets the default employee and the example recipe.
