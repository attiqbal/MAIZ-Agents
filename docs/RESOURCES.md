# What the employees can use (`src/modules/resources/`)

One place answers, for one client and one employee: what can I use right now, what is each thing good for, what does it
cost, and what must I ask first. The same answer writes the employee's instructions, the hints shown next to an answer,
the client's list on the employee's desk and the owner's usage table, so they cannot disagree.

## Where the answer comes from

`ResourceRegistry` stores nothing. On each question it reads the modules that own the data, through the functions their own
screens use (wired once in `src/server/platform.ts`, `ResourceSources`):

| Resource | Read from | Cost class |
|---|---|---|
| Business profile | `workforce.profileOf` | known |
| Connected apps (Xero, Square, Shopify, a till file ...) | `integrations.catalogue()` and `integrations.list()` | known (already read), or not connected |
| Staff records, the rota, the MAIZ books | `people`, `rota`, `ledger` through `records` in `platform.ts` | known |
| Saved datasets | `mining.overview()` | known |
| Public data sources (Reddit, news, economy figures ...) | `mining.overview().sources` | energy |
| Paid sources and services (X, Creatomate, Shotstack) | `mining.overview()`, `paid.list()` | double energy, with the quote |
| Writing and analysis on the open models | always there | energy |
| The client's own outside AI tools | `agents.overview()` | energy |

A service another module adds to its own list appears here by itself (the registry maps an app's capability to a tag by
its name, and an unknown one still appears under its own name). Nothing here sets a price: figures come from the owner of
each module, and the paid multiplier is the owner's existing setting.

Each resource carries: what it is, what it is good for, what it gives (tags), its state (`ready`, `not_connected`,
`waiting_approval`, `not_hired`), whether this employee may use it, its cost class and figure, whether the client must
confirm first, how fresh it is, a cheaper way when one is ready, and where the client fixes it (or that only MAIZ can).

## Who may use what

- Connected apps follow the owner's per-connection list (`integrations/access.ts`). The Admin manager never gets app data.
- Only the Data mining agent gathers public data. Everyone else works from the datasets shared with them.
- Media rendering is offered to content roles only.
- A person who is not a member of the workspace is refused (the registry reads the team through `workforce.team`, which
  checks `task.read`). An employee that is not on the team looks like one that does not exist. Another client's connections
  are never read: every source is asked for this workspace only.

## The choice rule (`rule.ts`)

Deterministic, tested, in this order:

1. what is already known (figures read from connected apps, saved datasets, the business profile);
2. free answers worked out from the records;
3. energy: the open models, and free public sources at a small flat figure;
4. double energy: an outside service that charges each time. Only when the task truly needs it (`essential`), only when
   nothing cheaper gives the same thing, and always with the quote shown and confirmed first;
5. money (hiring someone) is never chosen for the client, only suggested.

`chooseResource` picks the cheapest usable one and says why the others were passed over. `cheaperAlternatives` marks a paid
resource with the cheaper ready one that gives the same thing, which is how the brief says "Posts on X, but Reddit gives
the same for less".

Work that can wait still goes to the overnight batch (`batch/classify.ts`, unchanged). Short questions the records can
answer still skip the model altogether (`instant.ts`, unchanged).

## The employee's brief

`renderGuide` writes the "what you can use" part of the instructions at the time of the task. It replaces the job
description's hand-written "Tools you can use today" line (`renderJobDescription(jd, { tools: false })`), which is kept for
the skill files and as the fallback if the registry ever fails. It lists only what is ready and allowed, by cost class,
and then, only when the task is about it, what is not connected ("connect X and I can do this"). It is capped at 800
characters and drops whole items, never half a word. The business profile is now sent as compact JSON, not indented.

Size, in characters, on a real platform (instructions before / after): marketing, nothing connected, a thank-you note,
5,839 / 5,861; marketing with a till file connected, a sales task, 6,078 / 6,137; finance with a till file connected,
8,947 / 9,092. The guide adds a little where it has something to say and costs almost nothing where it does not.

## Missing-resource hints

When a task is about something that is not connected and the client could connect it, the answer carries
`hints: [{ id, title, detail, action: { label, href } }]` (same shape as the Home suggestions). `web/src/app.ts` shows each
as a card with a link to Apps and connections, the store or Market data. Hints are worded from templates: no model, no energy.
A resource only MAIZ can switch on (an app waiting for the provider, a service with no key) is not offered to the client.

## Quality checks

`worthSampling` stops the routine spot-check (Claude Haiku) on a one-line answer with no figure in it. It never touches:
answers that look wrong (empty, cut off, looping, too short for the task), the strongest lane (`premium`: books, forecasts,
advice), the Claude-only policies, the specialist sign-off or any safety check.

## Screens and routes

- `GET /api/resources/employee/<template key>`: the client's list for one of their own employees. Shown on the employee's
  desk as "What this employee can use" (`web/src/desk-resources.ts`). Hidden without a login.
- `GET /api/owner/resources`: the owner's table, shown on the AI page (`owner-ai.html`) as "What the employees use and what
  it costs". Owner only; everyone else gets 403.

## What is recorded

Each finished task keeps `used` (the resource keys it was given) next to its energy and real cost (in `state_records` kind
`task`, as before). Paid services and data gathering already book their own energy and real cost under `paid:<key>` and
`mine:<source>` in the energy meter. The owner's table adds those two records together for the month: nothing new is
stored and nothing is estimated. "Given" rows share the energy of the tasks they were in, so they do not add up.
Only tasks finished after this change carry `used`.

## What is not tested against a real service

Everything above is tested with fake modules and with the real platform in memory. Not tested: the wording against the real
RunPod models, how often the shorter brief changes answers, and the pages in a real browser.
