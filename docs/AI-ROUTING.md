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

## Owner controls (`/owner-ai.html`, `GET /api/owner/ai`, `POST /api/owner/ai/settings`, `GET /api/owner/ai/health`)

Models, prices, thresholds, rates, caps and per-policy rules are data. Anything can be changed without a deploy; bad values are refused. Keys and the endpoint id are **only** environment variables (`RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `ANTHROPIC_API_KEY`) and never appear in any response.

## Not verified without real keys

See the thread summary: real RunPod latency and cold start, the exact `usage` field in RunPod responses (estimated from characters when absent), that the model name matches what the worker serves, real GPU prices, and the reviewer's agreement with human judgement.
