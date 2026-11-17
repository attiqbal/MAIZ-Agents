# Where the Approvals, Books and cash and calendar screens get their data

These three screens show a signed-in client only real records. Signed out, the website still shows labelled examples. Code: `src/modules/overview/`, routes in `src/server/overview-routes.ts`, screens in `web/src/approvals-live.ts`, `books-live.ts`, `calendar-live.ts`, and the shared count in `web/src/needs.ts`.

## Approvals (`GET /api/overview/approvals`, needs `task.read`)

One list of everything waiting for the client. The sidebar badge, the top bar and the "Needs you" tile on the Overview read the same list. Deciding needs `approval.decide`; people without it see the item but not the buttons.

| What waits | Read from | Decided with |
| --- | --- | --- |
| Outside AI tool job waiting for approval | agent jobs (`/agents/jobs`) | `POST /api/agents/jobs/:id/approve` or `refuse` (owner only) |
| Social post waiting | Meta posts | `POST /api/meta/posts/:id/approve` or `reject` (owner or admin) |
| Holiday or time-off request | staff records (people) | `POST /api/people/:staffId/leave/:leaveId/decide` |
| Question from a task | tasks waiting on the client | link to Tasks |
| Specialist employee to hire | specialist requests (shown 30 days after approval) | link to Team |
| Figures waiting to go into the books | app figures not yet posted | link to Apps and connections |
| First day not finished | setup state | link to First day |

Order: items due within 72 hours first (soonest first), then newest, then undated.

## Books and cash (`GET /api/overview/books?days=7|30|90`, needs `task.read`)

- Takings, refunds, fees, tips and number of sales: from the figures each connected till, payment or shop app sent. Named by app and day. Never added across apps by us, never across currencies.
- Pay runs: from a connected payroll app.
- Accounts month by month: only the figures an accounting app reported, labelled "as the app reported it".
- Recorded in your books: the ledger entries really posted, with income and expense movements.
- Nightly check: the last reconciliation run (counts of entries checked, problems, warnings).
- Where the figures come from: the connected apps and when each was last fetched.

## Compliance calendar (`GET /api/overview/calendar`, needs `task.read`)

- Staff: documents, checks and reviews with a date in staff records (people module).
- Plan: end of free trial, end of a plan, next monthly payment (paid orders).
- Connections: connected app, social account and key expiry, where the app really reports one.
- Added by you: dates the client adds (`POST /api/overview/calendar/dates`, change, done, remove). Owner and admin only. Stored per workspace as `cal_date`. A reminder goes to the bell and phone alerts from 8am client time, once each, 0 to 30 days before. The employee picked is told the date and title, never the note.

MAIZ adds no tax, filing or licence deadlines of its own: it has no checked list of official dates.

## Not available (left out on purpose)

- Approval of ordinary workforce tasks: they have no approval state.
- Paid outside services and data-mining runs: confirmed on the spot, so nothing waits.
- Growth and promoter approvals: decided by the platform owner, not the client.
- Specialists asked to change: no client endpoint exists.
- Bank balance, payouts, money owed, profit or runway of our own: no connected app sends them, so they are never shown or guessed.
- Statutory deadlines by country: no researched source with real dates.
- App sign-in expiry: real only for apps that cannot renew themselves (for example Square).

## Known issue

New workspaces get `baseCurrency` "USD" whatever the country (`src/modules/identity/index.ts`). Figures with no currency named are stored as USD, and posting skips records in a different currency from the books, so a UK client's pound takings cannot be posted to their books until the currency is set at signup. The Books screen shows each figure in the currency its record carries.
