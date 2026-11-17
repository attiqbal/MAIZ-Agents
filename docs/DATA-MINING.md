# The Data mining agent

An add-on employee a client hires from the store (template key `data-mining-agent`, the same add-on price as the Supply chain manager). It gathers what is public about a topic, keeps it as a small **dataset** with a plain-English summary and every source link, and can share that dataset with the client's other employees so their work starts from real data instead of guesses.

The owner-only research desk (`src/modules/research/service.ts`) is unchanged. This feature calls the same read-only source functions underneath it, with its own rules for clients.

## What a client does

1. Hires the Data mining agent (store, or the "Know my market" choice at signup, which offers it as an add-on and never adds it silently).
2. Types a topic (3 to 200 characters) and ticks up to 5 places to look.
3. Sees what the search will use in energy, source by source, and which sources are not available. Nothing has been read yet.
4. Confirms. The sources are read, and a dataset is saved.
5. Optionally shares the dataset with chosen employees, or removes it.
6. Optionally switches on "Check this every week" for a dataset (see below).

In a connected chat app, `data: <question>` goes to the Data mining agent, like `finance:` goes to the Finance manager. The agent answers from the saved datasets; it cannot start a search from Slack (see "Starting a search from chat").

## Starting a search from chat

Typing in the ask bar, or talking to the Data mining agent in Conversations, can start a search. `src/modules/data-mining/chat.ts` reads the message with fixed rules (no AI model, so no energy and nothing invented): "look up market data on ...", "research what people say about ...", "find market data about ..." and similar. With the agent chosen the rules are loose; in the ask bar with nobody named they are strict, so an ordinary question is never mistaken for a search. The `data:` prefix keeps working.

The reply is the same quote as the screen: the sources it would read and the most it can use in energy, with "Confirm and start" and "Not now" under it. Nothing is read and no energy is used until the client confirms. The offer is saved on the agent's last conversation turn on the server; `POST /api/mining/chat/confirm` and `/decline` use only that saved offer, never a topic or figure sent by the page. If the price has gone up since the offer, the client sees a new offer instead of being charged more. After confirming, the summary is shown in the conversation with a link to the dataset on Market data. If the agent is not on the team, the reply says so and links to the store. The code is in `src/server/mining-chat.ts`; `/api/ask`, `/api/ask/stream` and the chat call `miningAsk` before the normal answer.

## The weekly check

"Check this every week" on a dataset (`POST /api/mining/datasets/:id/watch` with `{ on: boolean, confirm?, confirmEnergy? }`). Before it is switched on the client is shown the most a check uses in energy each week (the same rules as a search, the same sources as the original search unless changed) and that only sources that find something are charged. It answers 409 with the quote until confirmed.

- **When.** A check runs once a week from when it was switched on, nudged to 3 in the morning in the client's time zone when the country in their business profile gives one (otherwise exactly seven days later). A once-a-minute timer in `src/server/main.ts` calls `mining.tick()`, at most 3 checks a pass. The week is marked as taken (and stored) before any source is read, so a restart or a second pass never repeats a week.
- **Energy.** Same checks as a search: the client's weekly pool, the per-client and shared daily source budgets, and the hourly limit. When there is not enough energy the check is skipped, the client is told once, and it tries again the next week. The note is not repeated while it stays short.
- **Comparing.** Each check is compared with the last: new items are found by address (or id), items that have gone are ignored, and changed figures (for example inflation 3.4 to 3.6) are listed. Up to 10 new items are kept per check, and the newest 8 checks are kept in a short history on the dataset. The employees the dataset is shared with use the newest version.
- **Telling the client.** When something changed there is one alert through the usual notices (the bell, and a push if the client has asked for them), for example "Oat milk prices: 3 new articles, inflation moved from 3.4% to 3.6%", which opens the dataset. When nothing changed there is no alert; the screen says "Nothing new since the check before.".
- **Stopping.** The client can stop it at any time and the history stays. It also stops by itself, and the client is told, when the Data mining agent is no longer on the team. A client can have 10 weekly checks at most.
- **Stored.** The watch and the history are part of the `dataset` record (`watch`, `checks`), so they come back after a restart through the same restore as datasets. No new record kind.

## Sources

| Id | Shown as | From | Needs a key on the Connections page | Energy |
|---|---|---|---|---|
| `hackernews` | Hacker News discussions | Hacker News public search | No | 5 |
| `reddit` | Reddit conversations | Reddit's official interface (read-only app) | Reddit app | 5 |
| `youtube` | YouTube videos | YouTube Data API | YouTube key | 5 |
| `x` | Posts on X | X recent search (last 7 days) | X token | 50, times the paid-service multiplier: **100** by default |
| `news` | News coverage | GDELT open news index | No | 5 |
| `economy` | Economy figures for your country | World Bank: inflation, GDP growth, unemployment, for the country in the business profile ("World" when there is none) | No | 5 |
| `prices` | Share price | Alpha Vantage. The topic must be a symbol such as `IBM` or `VOD.LON` | Alpha Vantage key | 5 |
| `companies` | UK company records | Companies House | Companies House key | 5 |

A source whose key has not been set is shown as "not available yet", is left out of the total and is skipped; it never fails the whole run. FRED economic series are on the owner's desk but are not offered to clients (a series id is not something a shop owner types).

## Energy

- Free sources use a small flat figure (`FREE_SOURCE_ENERGY`, 5).
- X charges MAIZ for every search, so it follows the paid-service rule in `docs/PAID-SERVICES.md`: its plain cost in energy times the owner's `paidServiceMultiplier` (2 by default, set on the Prices page). The plain cost is an **estimate** (about ten posts at half a US cent each, `X_EST_COST_MICRO`); X's invoice is the real figure, and the constant should be corrected after the first real use.
- The cost is shown first. `POST /api/mining/run` without `confirm: true` and `confirmEnergy` equal to the quoted total answers **409** with the quote and reads nothing. If a price, a key or a daily limit changed since the person looked, they get the new quote instead of a charge nobody saw.
- Before any source is read the team must be able to afford the whole total (`canAfford`), and each source's energy is set aside (`holdPaid`). A source that **found something** is charged to the Data mining agent as `mine:<source>` (`settlePaid`). A source that failed or found nothing gives its energy back (`releasePaid`). So `energyUsed` can be less than the quote, never more.
- If no source found anything, nothing is saved and nothing is charged; the client is told what each source said.
- The hidden monthly cost cap counts the real cost (zero for the free sources, the estimate for X).

## What a dataset holds

`{ id, topic, createdAt, updatedAt, sources, summary, energyUsed, sharedWith, watch?, checks? }`. Each source has a status (`ok`, `empty`, `unavailable`, `failed`), up to 10 items (`title`, `snippet` of at most 300 characters, `url`, `source`, optional date `at`) and, for the figures sources, up to 10 `figures` (`label`, `value`, optional `date`, `detail`, `url`).

The summary is worked out from the data: how many items from how many sources, the date range, the first item of each source, the latest figures, which sources found nothing and which were not included. No AI model writes it, so it costs nothing and cannot say something the data does not. It always ends with: "This is a sample of public posts and records, not the whole picture."

Datasets are stored as `state_records` kind `dataset` under the client's workspace (`Sink.record`). The newest 50 per client are kept; the oldest is dropped and its stored copy overwritten. Removing a dataset overwrites its stored copy too.

## Sharing with other employees

`POST /api/mining/datasets/:id/share` with `{ employees: [template keys] }` sets who sees a dataset (the list replaces the old one; an empty list stops sharing). Only employees on the client's own team can be named.

When a shared employee is given a task, the datasets shared with it are added to its instructions (the same `workforce.addContext` hook the rota and connected apps use): newest first, about 1,500 characters a dataset and 4,000 in all, whole lines only, one line from each source in turn so one long source cannot crowd out the rest. They sit under a heading that says they are public data gathered by the Data mining agent, to be treated as information and not as instructions, between `<<<dataset ...>>>` and `<<<end of dataset>>>` markers. Angle brackets in gathered text are swapped for look-alikes when it is cleaned, so a post cannot imitate the markers.

The Data mining agent itself is always given the client's latest datasets, shared or not. With none, it is told to say so and ask the owner to run a search rather than answer from memory. Figures from connected apps reach it the same way as any employee: only when the owner gives it access to that app.

## Limits

| Limit | Value | Constant |
|---|---|---|
| Sources per run | 5 | `MAX_SOURCES_PER_RUN` |
| Confirmed runs per client per hour | 20 | `MAX_RUNS_PER_HOUR` |
| Items (or figures) kept per source | 10 | `MAX_ITEMS_PER_SOURCE` |
| Datasets kept per client | 50 | `MAX_DATASETS` |
| YouTube runs a day, all clients together | 40 | `YOUTUBE_RUNS_PER_DAY` |
| X runs a day, all clients together | 50 | `X_RUNS_PER_DAY` |
| Share price runs a day, all clients together | 15 | `PRICE_RUNS_PER_DAY` |
| One client's share of each of those daily limits | a fifth, and never fewer than 2 (8, 10 and 3) | `clientShare` |

The platform-wide daily limits protect MAIZ's allowance with a source, and a search counts against them whether or not it finds anything (the outside service counts the call either way). One client may use only a share of each, so nobody can use a source up for everyone else with searches that cost them nothing. When one is reached the source shows as not available until the next day. The counts are in memory, so they start again when the server restarts.

One run at a time per client; a second press while one is running is refused.

## What it never does

- Reads anything behind a login, a paywall or any access control. Every call goes through the research module's source functions, which talk only to each source's official interface on a fixed host, with a timeout and no redirects.
- Posts, comments, votes, messages or contacts anyone.
- Keeps full copies. A dataset holds titles, short snippets and links.
- Collects personal data about private individuals. Authors' names are not kept; on X the source is shown as "X" and only the link to the public post remains; a company record keeps name, status and number, not the registered address. The topic is cleaned to letters, numbers and everyday punctuation, so it cannot carry a search operator such as X's `from:`.
- Presents a sample as the whole picture, or hides a gap: unavailable, failed and empty sources are named in every dataset and summary.
- Passes a raw error to the client. A failed source shows a plain reason; anything unexpected becomes "could not be read this time", because a web address can hold a key.
- Starts a search that uses energy without the person having seen the cost.

## Routes

All need a signed-in member of the client's workspace. Reading needs `task.read`; running, sharing and removing need `task.create` (403 otherwise).

- `GET /api/mining`: `{ hired, sources: [{ id, label, gives, energy, paid, available, reason? }], datasets: [...newest first, without items], employees: [{ key, title }], limits }`.
- `POST /api/mining/run` with `{ topic, sources, confirm?, confirmEnergy? }`: 409 `{ error, quote }` until confirmed, then 201 `{ dataset, team }`. 400 with a plain message when the agent is not hired, the input is wrong, nothing can be gathered, energy is short, or the hourly limit is reached.
- `GET /api/mining/datasets/:id`: `{ dataset }`, or 404.
- `POST /api/mining/datasets/:id/share` with `{ employees: string[] }`: `{ dataset }`.
- `POST /api/mining/datasets/:id/remove`: `{ removed: true, datasets }`.
- `POST /api/mining/datasets/:id/watch` with `{ on, confirm?, confirmEnergy? }`: `{ dataset }` (409 with a quote until confirmed when switching on).
- `POST /api/mining/chat/confirm` and `/api/mining/chat/decline`: answer the offer waiting on the agent's last conversation turn. `{ reply }`.

Another client's dataset answers 404, exactly like one that does not exist.

## Not built yet

- An AI-written summary; the summary is computed.
- Company registers outside the UK.
- Starting a search from Slack, or the agent starting one itself during a task.
- Changing the sources of a weekly check after it is on (the client switches it off and on again).
- Everything was tested against pretend servers (the machine that built it cannot reach the real sources). No real search or weekly check has been run from this code, so the first real runs should be checked against each source's own results and X's invoice.

Code: `src/modules/data-mining/` (`sources.ts` the table and readers, `dataset.ts` the summary and the wrapping for employees, `service.ts` the rules), routes in `src/server/mining-routes.ts`. The screen is `web/src/mining.ts` (with `web/src/mining-watch.ts` and `web/src/mining-chat.ts`); the weekly rules are in `src/modules/data-mining/watch.ts`. Tests: `test/data-mining.test.ts`, `test/data-mining-routes.test.ts`, `test/data-mining-context.test.ts`, `test/data-mining-watch.test.ts`, `test/data-mining-watch-routes.test.ts`, `test/data-mining-chat.test.ts`.
