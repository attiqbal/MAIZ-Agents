# AI routing: RunPod does the work, Claude supervises

Goal: minimise Anthropic spend without letting quality slip. Open models (Qwen) on a RunPod Serverless
endpoint answer every task. Claude is a light supervisor: it reads a sample of the answers, redoes weak ones,
covers RunPod when it is down or cold, and keeps regulated work.

## What happens to one request (`routing/router.ts`)

1. **Policy.** The employee template key picks a policy (`compliance-manager`, ...), else the tier (`standard` / `premium`).
2. **Cache.** An identical request from the same client (same policy, messages, token limit) is answered from memory for $0, for one hour by default. The client id is part of the key, so answers never cross clients. Answers accepted below the pass mark are never cached.
3. **RunPod.** `https://api.runpod.ai/v2/<endpoint>/openai/v1/chat/completions` with the key from `RUNPOD_API_KEY`.
   - Retries transient errors (429/5xx/network) with backoff, `attempts` times.
   - **Cold start:** when Claude may cover, the wait is the *soft deadline* (45 s). If RunPod has not answered, the request moves to Claude and is not retried. With no Claude cover it waits the hard timeout (120 s).
   - **Circuit breaker:** 3 failures in a row stop sending work to RunPod for 60 s (all editable). Claude covers in the meantime.
4. **Claude spot-check.** Claude Haiku scores a sample of answers 1 to 10 (`reviewRate`; standard 15%, premium 50%) and **every suspicious answer** (empty, cut off, looping, unfinished reasoning). The sample rate rises automatically while recent checks keep failing (`adaptive`).
5. **Redo.** A score below `minScore` (standard 7, premium 8) redoes the work on Claude Sonnet, passing the reviewer's issues as a hint. If Claude is over budget the RunPod answer is kept and counted as *low confidence*.
6. **Claude only.** Policies with `primary: "claude"` (default: `compliance-manager`) never touch RunPod, unless a Claude cap is hit and `whenClaudeCapped` is `degrade`.

The reviewer treats the answer as data (delimited, told to ignore instructions inside it) and its reply is parsed strictly; an unreadable reply is *never* a pass, it is counted as a review error.

## Budgets

Daily, monthly, per-client Claude caps and a monthly RunPod cap (US dollars, blank = none). Checked before every Claude call, including checks. Over a Claude cap: checks stop and RunPod keeps serving; Claude-only work either degrades to RunPod or stops (`whenClaudeCapped`). Over the RunPod cap: work goes to Claude if its caps allow, otherwise the task fails with a plain budget message.

## Cost and savings

- Each task's real cost (RunPod + checks + redo) is passed to the energy meter, so clients' energy and the per-client cost cap follow real spend.
- **Baseline** = the same answer's tokens priced on the policy's `baselineModel` (default: Haiku 5.5 standard, Sonnet 5.5 premium). Savings = baseline - actual. It can be negative, and the page says so.
- RunPod cost is estimated from **GPU seconds** (wall time x `gpuUsdPerSecond`) or from tokens (`tokenPrice`). Wall time overstates the bill when requests share a GPU, so reconcile with the RunPod invoice.
- Cache savings are shown separately (a Claude-only setup could cache too).
- Stored per day in `platform_records` (`ai_day`), settings in `ai_settings`; no migration needed.

## Batch system (`src/modules/batch/`)

Most work does not need an answer this second, and a RunPod GPU that starts once for many tasks is cheaper than one that starts for each. So work is sorted when it arrives (`classify.ts`):

| Kind | Examples | What happens |
|---|---|---|
| **Lookup** | "what's the status?", "how does the rota look?" | Answered at once by a cheap Claude model (`live` policy, no checks) reading a short digest of the queue and recent filings |
| **Urgent** | marked urgent (start with `urgent:`), or words like asap, today, before my meeting; the Admin manager always | Normal real-time route (RunPod now) |
| **Batch** | drafts, reports, bookkeeping, analysis | Queued. The client sees "queued, runs at 6 pm" |

**When a batch runs** (`tick()` every minute): at a client's closing time (default 18:00 UTC, set per client with timezone, optional extra runs and skip weekends), early when waiting work reaches `sizeTrigger` tasks or `tokenTrigger` tokens, when anything has waited `maxQueueAgeHours`, or when a client presses Run now (or the owner presses Run all now). Every ready task from every client goes out together, so the GPU starts once. Run now is rate limited per address. **After urgent work completes** (the pod is warm) everything waiting is sent too, at any time of day (`flushAfterUrgent`; lookups and the Admin manager do not trigger it). A **midnight catch-up run** also happens at 00:00 in the business's own time zone, so work queued after closing does not wait for the next evening. The zone defaults from the business's country (`zones.ts`, the main zone of big countries) and the client can change it.

**Overnight GPUs:** the batch runs on a fixed number of GPUs of one size (`gpuWorkers` x `gpuSizeGb`), `concurrency` tasks per GPU at a time, so the night's cost is known in advance. The owner page shows a GPU plan from the tasks waiting, the measured seconds a task takes and the `windowHours` before morning: how many GPUs of which size are needed (the size follows the model name, for example 14B needs 48 GB), whether the current setting finishes in time, and a cost estimate (planning figures, check the invoice). Set the RunPod endpoint's workers to match. Code: `src/modules/batch/gpu-plan.ts`.

**In the batch:** `concurrency` tasks per GPU at a time (times `gpuWorkers` GPUs). Claude reads at least `qaRateMin` of the answers (nobody is waiting, so this is generous). A failed task is retried later with growing waits up to `maxAttempts`. **Claude finishes a task only on its last attempt** (`claudeAfterFailures`), so a pod outage never silently spends Claude money. Results are filed on the job, the client gets one Admin-manager message per batch, and the ledger records batch jobs, runs, savings against Claude-only and the estimated cold starts avoided (`coldStartSeconds` x GPU price x (tasks - 1)).

**Stays real-time on purpose:** the Admin manager, urgent and time-sensitive work, lookups, sign-off decisions, sign-in and payments (listed on the owner page and in `REAL_TIME_RULES`).

**Limits:** the dispatcher lives in one server process (single instance, as the rest of the in-memory services). Jobs are saved to Postgres and a restart puts running jobs back in the queue. Classification is keyword based and visible: an unusual urgent request may be queued, and the client can always press Run now or write `urgent:`. There is no rota module yet, so "how does the rota look" answers from whatever records exist.

API: `POST /api/ask` (`urgent`), `GET /api/queue`, `POST /api/queue/run-now`, `POST /api/queue/:id/cancel`, `GET|POST /api/batch/schedule`, owner `GET /api/owner/batch`, `POST /api/owner/batch/run-now`. Settings: `batch.*` on the owner AI page.

## Owner controls (`/owner-ai.html`, `GET /api/owner/ai`, `POST /api/owner/ai/settings`, `GET /api/owner/ai/health`)

Models, prices, thresholds, rates, caps and per-policy rules are data. Anything can be changed without a deploy; bad values are refused. Keys and the endpoint id are **only** environment variables (`RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `ANTHROPIC_API_KEY`) and never appear in any response.

## Not verified without real keys

See the thread summary: real RunPod latency and cold start, the exact `usage` field in RunPod responses (estimated from characters when absent), that the model name matches what the worker serves, real GPU prices, and the reviewer's agreement with human judgement.
