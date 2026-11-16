# Connecting a client's existing agents

Stage 1 of the plan is built (16 November 2026): the key, the public API, the limits, owner approval and signed webhooks. The owner's screen is built too: "Your own AI tools" on Apps and connections (`web/src/agents.ts`), where the owner makes a connection, copies the key and signing secret once, chooses employees and limits, approves waiting jobs, pauses, replaces the key or removes it. The Admin manager planner is not built yet. The plan below was written on 12 November 2026 and revised the same day after Atif's feedback: connecting must be easy, the owner turns it on and sets the limits, it must work for any task, and the Admin manager plans it.

## What is built (Stage 1)

Code: `src/modules/agents` (service), `src/server/agent-routes.ts` (routes), tests in `test/agents.test.ts` and `test/agent-webhooks.test.ts`.

**In one paragraph.** The owner makes a *connection* for their own tool (Claude, ChatGPT, Zapier, Make, n8n or a script). The connection gets a key, shown once. The tool sends *jobs* to the employees the owner allowed and reads the answers, by asking again (polling) or by a signed webhook. Nothing is on until the owner makes a connection, and only the owner can change one.

### What the owner controls

| Setting | Starts at | Most the owner can set | When it is reached |
| --- | --- | --- | --- |
| Daily energy for this connection | 10% of the weekly team pool | 25% | New jobs are refused with `402` and `reason: "daily_limit"` until the client's next midnight. The owner is told once that day. |
| Energy for one job | 2% of the weekly team pool | 5% | A job expected to use more waits for the owner (`waiting_for_owner`). It is not refused. |
| Jobs an hour | 60 | 120 | `429` with `retryAfterSeconds` and a `Retry-After` header. |
| Employees it may use | Customer support only, if the client has that employee. Otherwise the owner must choose. | Any employee on the team except two | Any other employee gets `403`. |
| Approve every job first | Off | | Every job waits for the owner. |
| Key life | 12 months | | The key stops working. The owner is told 14 days before. |

- The Admin manager and the Finance manager can never be given to an outside tool. This is refused when the connection is made or changed, and checked again when each job arrives and when it runs.
- At most 10 connections for one client. A connection can be paused (calls are refused at once, history is kept), resumed, given a new key (the old one stops at once) or removed (its key, jobs and signing secret are forgotten).
- The key looks like `maiz_live_` plus 32 random characters. Only its SHA-256 and its first 12 characters are stored. The webhook signing secret (`whsec_...`) is stored encrypted, apart from the connection record. Neither can be shown again: if one is lost, replace it.
- A job runs through the same door as the ask bar, as a member of the workspace that is not a person (`agent:<connection id>`), so the team's energy, the audit log and the workspace wall all apply. It can only ever see its own workspace.
- What the tool sends is treated as a request and data, never as instructions: it is wrapped in a marked block before the employee reads it. The brief is at most 8,000 characters and `data` at most 16 KB.
- One connection's jobs run one at a time, in the order they came.
- The last 200 jobs of a connection are kept, and never fewer than everything from the last day or so: today's energy total, the hourly count and the repeat-request check are read from these records, so a busy tool cannot push its own recent jobs out and win back its limit. A job nobody approved is closed as refused after 7 days. The `data` sent with a job is dropped once the job has ended.
- An address that sends 20 wrong keys in 10 minutes is not answered again until that time is up.
- Every change and every job is in the client's audit log (`agent.created`, `agent.updated`, `agent.key_replaced`, `agent.paused`, `agent.resumed`, `agent.removed`, `agent.job_submitted`, `agent.job_waiting`, `agent.job_approved`, `agent.job_done`, `agent.job_refused`, `agent.job_failed`, `agent.callback_failed`, `agent.webhook_tested`). The log holds names, ids and sizes, never the brief, the answer or the key.

### The API the tool calls

Base `https://maizagents.com/api/agent/v1`. Every call needs `Authorization: Bearer maiz_live_...`. Errors always look like `{ "error": "plain words", "reason": "short_code" }`.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/me` | The connection's name, the employees it may use, its limits and what is left today |
| GET | `/employees` | The employees this key may use and what each can do |
| POST | `/jobs` | Send a job. Answers `202` with `{ job }` |
| GET | `/jobs/:id` | The job's status, and the answer once it is done |
| GET | `/jobs?limit=20&reference=...` | This key's recent jobs, newest first (50 at most) |

A job: `{ "employee": "customer-support", "brief": "what you need", "data": { ... }, "reference": "your own id", "idempotencyKey": "...", "urgent": false }`. Only `employee` and `brief` are required. Send the same `idempotencyKey` (or an `Idempotency-Key` header) again within 24 hours and you get the first job back instead of a second one.

Job status: `queued`, `working`, `waiting_for_owner`, `done`, `refused`, `failed`. The answer (`result`) is only there when the status is `done`.

| Answer | Means |
| --- | --- |
| `401` | The key is missing, wrong, expired or paused. The message is the same for all of them. |
| `400` | The job is not valid (for example `brief_too_long`, `data_too_big`). |
| `402` | `daily_limit` (this connection used its energy for today) or `no_energy` (the team has none left). `resetsAt` says when to try again. |
| `403` | `employee_not_allowed`: this key may not use that employee. |
| `404` | `not_found`: no such job for this key. |
| `429` | `rate_limit`: too many jobs this hour, or polling too fast (more than 120 status checks a minute). `too_many_waiting`: 50 jobs are already waiting for the owner. Wait `retryAfterSeconds`. |

Differences from the plan below: the paths are `/jobs` (the plan said `/tasks`), the instructions field is `brief` (the plan said `text`), limits are part of `/me` (the plan had `/limits`), and `expect` and a per-job `callbackUrl` are not built.

### Webhooks

Optional, one address per connection. It must be a public `https` address (port 443, no login in the address). MAIZ checks where the name points before every send and never follows a redirect. Each call waits at most 8 seconds.

Events: `job.done`, `job.refused`, `job.waiting_for_owner`, `job.failed`. The body is `{ "id", "type", "created", "connection": { "id", "name" }, "job": { ...the same job GET /jobs/:id returns } }`.

Every call carries `MAIZ-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t.body")>`. If your address does not answer with a 2xx, MAIZ tries again after 1 minute, 5 minutes, 30 minutes, 2 hours and then every 6 hours, and gives up 24 hours after the event. Polling `GET /jobs/:id` always works.

### The owner's routes (used by "Your own AI tools" on the Apps screen)

Signed-in session, same as the rest of the app. Anyone on the team may look; every change needs the owner (`workspace.manage`).

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/agents` | Connections, recent jobs (waiting ones first), defaults and maximums, which employees can be chosen |
| POST | `/api/agents` | Make a connection. `201` with `{ connection, key, signingSecret }`, both secrets shown this once |
| POST | `/api/agents/:id` | Change name, tool, employees, approval, limits or webhook address |
| POST | `/api/agents/:id/rotate` | New key. Send `{ "signingSecret": true }` to replace the signing secret too |
| POST | `/api/agents/:id/pause`, `/resume`, `/remove` | Pause, resume, remove |
| POST | `/api/agents/:id/test` | Send a signed test webhook. `{ delivered, status? }` |
| POST | `/api/agents/jobs/:id/approve`, `/refuse` | Decide a waiting job. Refuse takes an optional `{ "reason" }` |

### Not built yet

The Admin manager connection planner (the three questions, the proposal, the weekly note), active hours, a structured `json` answer, a per-job callback address, the usage page split by source, and MCP. Jobs always run now, never in the nightly batch. There is no link yet between a job and MAIZ quality review: a job is `done` when the employee's draft is ready, the same moment the ask bar shows it.

## Quick start

You need a key. The owner makes a connection (Apps and connections, "Your own AI tools", "Connect a tool") and copies the key. Keep it like a password.

### 1. Send a job and read the answer (curl)

```bash
export MAIZ_KEY="maiz_live_your_key_here"

# What may this key do?
curl -s https://maizagents.com/api/agent/v1/me -H "Authorization: Bearer $MAIZ_KEY"

# Send a job. You get a job id back straight away.
curl -s https://maizagents.com/api/agent/v1/jobs \
  -H "Authorization: Bearer $MAIZ_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ticket-9921" \
  -d '{
    "employee": "customer-support",
    "brief": "A customer asks where order 4471 is. Draft a short, friendly reply.",
    "data": { "orderId": "4471", "status": "shipped", "carrier": "DPD" },
    "reference": "TICKET-9921"
  }'
# -> 202 { "job": { "id": "JOB_ID", "status": "queued", "result": null, ... } }

# Ask again every few seconds until status is "done" (or use a webhook, below).
curl -s https://maizagents.com/api/agent/v1/jobs/JOB_ID -H "Authorization: Bearer $MAIZ_KEY"
# -> 200 { "job": { "id": "JOB_ID", "status": "done", "result": "Hi Sam, your order ...", "energyUsed": 12, ... } }
```

The answer is a draft. MAIZ never sends it to your customer: your tool decides what goes onward.

### 2. Zapier ("Webhooks by Zapier")

1. Trigger: whatever starts the work (a new helpdesk ticket, a new form entry).
2. Action: **Webhooks by Zapier**, event **Custom Request**. Method `POST`, URL `https://maizagents.com/api/agent/v1/jobs`. Headers: `Authorization` = `Bearer maiz_live_...` and `Content-Type` = `application/json`. Data: `{"employee":"customer-support","brief":"Draft a reply to: {{ticket text}}","reference":"{{ticket id}}","idempotencyKey":"{{ticket id}}"}`.
3. To get the answer, choose one:
   - **Webhook (best).** Make a second Zap with the trigger **Webhooks by Zapier, Catch Raw Hook**. Paste its address into the connection's webhook address in MAIZ. Filter on `type` = `job.done`, then use `job.result` and `job.reference` to update the ticket. Use *Catch Raw Hook*, not *Catch Hook*, if you want to check the signature in a Code step.
   - **Polling.** Add **Delay For** 1 minute, then **Webhooks by Zapier, GET** `https://maizagents.com/api/agent/v1/jobs/{{id from step 2}}` with the same `Authorization` header, and continue only if `job status` is `done`.

### 3. Make (HTTP module)

1. Add **HTTP, Make a request**. URL `https://maizagents.com/api/agent/v1/jobs`, method `POST`, header `Authorization: Bearer maiz_live_...`, body type **Raw**, content type **JSON (application/json)**, and the same JSON as above. Turn on **Parse response**.
2. For the answer, either start a second scenario with **Webhooks, Custom webhook** and paste its address into the connection's webhook address in MAIZ, or add **Tools, Sleep** (30 seconds) and a second **HTTP, Make a request** (`GET .../jobs/{{job.id}}`) inside a **Repeater** that stops when `job.status` is `done`.

### 4. n8n

1. **HTTP Request** node: method `POST`, URL `https://maizagents.com/api/agent/v1/jobs`, Authentication **Generic Credential Type, Header Auth** with name `Authorization` and value `Bearer maiz_live_...`, **Send Body** on, **JSON**, the same JSON as above.
2. For the answer, add a second workflow that starts with a **Webhook** node (method `POST`, and in Options turn on **Raw Body** if you check the signature). Paste its *production* URL into the connection's webhook address in MAIZ. Your n8n must be reachable from the internet over `https` on port 443. Or poll: a **Wait** node (30 seconds), then an **HTTP Request** `GET .../jobs/{{ $json.job.id }}`, then an **IF** node on `job.status` equals `done` that loops back to the Wait.

### 5. Check the webhook signature (Node)

Check it on the exact bytes you received, before parsing the JSON, and refuse anything older than five minutes.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// secret: the whsec_... value shown once when the connection was made. Keep it in an environment variable.
export function isFromMaiz(secret, signatureHeader, rawBody, toleranceSeconds = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader ?? "");
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}

// Example with Node's built-in server.
import { createServer } from "node:http";
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!isFromMaiz(process.env.MAIZ_WEBHOOK_SECRET, req.headers["maiz-signature"], rawBody)) { res.writeHead(401).end(); return; }
  const event = JSON.parse(rawBody);
  if (event.type === "job.done") console.log(event.job.reference, event.job.result);
  res.writeHead(200).end("ok"); // answer within 8 seconds; do slow work afterwards
}).listen(3000);
```

Answer with any 2xx quickly. The same event can arrive more than once (a retry after a slow answer), so use its `id` to ignore repeats.

## The plan (12 November 2026)

Everything below is the original plan, kept for the parts still to build. Where it differs from the section above, the section above is what the code does.

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
