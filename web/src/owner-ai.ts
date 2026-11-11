// AI spend and savings (owner-ai.html): what AI cost this month against a Claude-only setup, how the
// RunPod / Claude split is behaving, and the editable models, thresholds and budget caps.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import type { AiRoutingSettings, PolicySettings } from "../../src/modules/model-gateway/routing/settings";
import type { AiDay, Totals } from "../../src/modules/model-gateway/routing/ledger";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Policy = { calls: number; runpodMicro: number; claudeMicro: number; baselineMicro: number; escalations: number; reviewFails: number };
interface Overview {
  configured: { runpod: boolean; claude: boolean };
  status: { breakerOpen: boolean; breakerOpenUntil: string | null; consecutiveFailures: number; cacheEntries: number } | null;
  settings: AiRoutingSettings;
  month: Totals; today: Totals; claudeMonthMicro: number; claudeTodayMicro: number; runpodMonthMicro: number;
  byPolicy: Record<string, Policy>;
  days: Omit<AiDay, "claudeByWorkspace">[];
}

const usd = (micro: number): string => `$${(micro / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: micro < 1e5 ? 4 : 2 })}`;
const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : "–");

function demo(): Overview {
  const t = (k: number): Totals => ({ batchJobs: 310 * k, batchRuns: 22 * k, batchActualMicro: 5_200_000 * k, batchBaselineMicro: 19_000_000 * k, coldStartSavedMicro: 2_100_000 * k, calls: 480 * k, cacheHits: 40 * k, runpodCalls: 420 * k, claudeDirect: 20 * k, fallbacks: 8 * k, reviews: 90 * k, reviewFails: 9 * k, reviewErrors: 0, escalations: 11 * k, lowConfidence: 0, budgetRefused: 0, failures: 1, runpodMicro: 9_400_000 * k, claudeMicro: 5_100_000 * k, baselineMicro: 31_000_000 * k, cacheSavedMicro: 1_900_000 * k, runpodSeconds: 41_000 * k });
  const std: Policy = { calls: 400, runpodMicro: 8_000_000, claudeMicro: 3_000_000, baselineMicro: 20_000_000, escalations: 7, reviewFails: 6 };
  return {
    configured: { runpod: true, claude: true }, status: { breakerOpen: false, breakerOpenUntil: null, consecutiveFailures: 0, cacheEntries: 112 },
    settings: demoSettings(), month: t(1), today: t(0.05), claudeMonthMicro: 5_100_000, claudeTodayMicro: 260_000, runpodMonthMicro: 9_400_000,
    byPolicy: { standard: std, premium: { ...std, calls: 70, baselineMicro: 9_000_000 }, "compliance-manager": { calls: 10, runpodMicro: 0, claudeMicro: 400_000, baselineMicro: 400_000, escalations: 0, reviewFails: 0 } },
    days: Array.from({ length: 7 }, (_, i) => ({ ...t(0.14), day: new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10), byPolicy: {} })) as Overview["days"],
  };
}
function demoBatch(): BatchView {
  const run = (i: number) => ({ id: `r${i}`, trigger: i % 5 === 4 ? "size" : "schedule", startedAt: new Date(Date.now() - i * 86_400_000).toISOString(), jobs: 14 - i, done: 14 - i, failed: 0, retried: i % 3, clients: 4, actualMicro: 240_000, baselineMicro: 880_000, savedMicro: 640_000, coldStartSavedMicro: 95_000 });
  return {
    queued: 9, running: 0, estTokens: 41_000, oldestMinutes: 410, nextDueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    byClient: [{ id: "a", name: "Kestrel Coffee", queued: 5, nextAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }, { id: "b", name: "Loaf Bakery", queued: 4, nextAt: new Date(Date.now() + 5 * 3_600_000).toISOString() }],
    runs: [1, 2, 3, 4, 5].map(run),
    gpuPlan: { pending: 9, taskSeconds: 30, windowHours: 10, sizeGb: 80, gpus: 1, runHours: 0.01, costUsd: 0.02, current: { gpus: 1, sizeGb: 48, runHours: 0.01, costUsd: 0.01, finishesInWindow: true }, advice: "1 GPU is more than enough for 9 tasks, but your model needs 80 GB cards (you have 48 GB)." },
    latency: { total: 412, liveShare: 0.38, stats: [{ kind: "instant", count: 96, p50Ms: 3, p95Ms: 11, targetMs: 100, overTarget: false }, { kind: "lookup", count: 71, p50Ms: 1800, p95Ms: 3900, targetMs: 5000, overTarget: false }, { kind: "live", count: 85, p50Ms: 9500, p95Ms: 41000, targetMs: 30000, overTarget: true }, { kind: "batch_wait", count: 160, p50Ms: 21600000, p95Ms: 39600000, targetMs: 43200000, overTarget: false }] },
    realTime: [{ what: "The Admin manager", why: "People wait on it during sign-up" }, { what: "Anything marked urgent", why: "The person chose speed" }, { what: "Quick questions about status or the rota", why: "Answered at once by a cheap Claude model" }],
  };
}
function demoSettings(): AiRoutingSettings {
  const p = (o: Partial<PolicySettings> = {}): PolicySettings => ({ primary: "runpod", claudeModel: "claude-haiku-5-5", baselineModel: "claude-haiku-5-5", reviewRate: 0.15, minScore: 7, escalate: true, escalationModel: "claude-sonnet-5-5", fallbackToClaude: true, allowOpenModel: true, cache: true, ...o });
  return {
    runpod: { enabled: true, model: "Qwen/Qwen3-30B-A3B-Instruct-2507", billing: "seconds", gpuUsdPerSecond: 0.00034, tokenPrice: { inputPer1k: 60, outputPer1k: 250 }, softDeadlineMs: 20000, hardTimeoutMs: 120000, attempts: 2, breakerFailures: 3, breakerCooldownMs: 60000 },
    reviewer: { enabled: true, model: "claude-haiku-5-5", maxInputChars: 12000, adaptive: true }, cache: { enabled: true, ttlSeconds: 3600, maxEntries: 500 },
    budgets: { claudeDailyUsd: 15, claudeMonthlyUsd: 200, claudePerWorkspaceMonthlyUsd: 20, runpodMonthlyUsd: 300, whenClaudeCapped: "degrade" }, prices: {},
    policies: { live: p({ primary: "claude", reviewRate: 0, escalate: false, fallbackToClaude: false, allowOpenModel: false }), standard: p(), premium: p({ claudeModel: "claude-sonnet-5-5", baselineModel: "claude-sonnet-5-5", reviewRate: 0.5, minScore: 8 }), "compliance-manager": p({ primary: "claude", reviewRate: 0, escalate: false, fallbackToClaude: false, allowOpenModel: false }) },
    batch: { enabled: true, sizeTrigger: 20, tokenTrigger: 200_000, maxQueueAgeHours: 24, concurrency: 6, gpuWorkers: 1, gpuSizeGb: 48, windowHours: 10, maxAttempts: 3, retryBackoffMinutes: 15, qaRateMin: 0.3, claudeAfterFailures: true, coldStartSeconds: 40, flushAfterUrgent: true, liveDuringTrial: true, liveFirstTasks: 20, liveTemplates: ["admin-manager"] },
  };
}

interface BatchView {
  queued: number; running: number; estTokens: number; oldestMinutes: number; nextDueAt: string | null;
  byClient: { id: string; name: string; queued: number; nextAt: string }[];
  runs: { id: string; trigger: string; startedAt: string; jobs: number; done: number; failed: number; retried: number; clients: number; actualMicro: number; baselineMicro: number; savedMicro: number; coldStartSavedMicro: number }[];
  gpuPlan: { pending: number; taskSeconds: number; windowHours: number; sizeGb: number; gpus: number; runHours: number; costUsd: number; current: { gpus: number; sizeGb: number; runHours: number; costUsd: number; finishesInWindow: boolean }; advice: string };
  realTime: { what: string; why: string }[];
  /** How long clients wait, by kind of request (kept in memory since the last restart). */
  latency?: { stats: { kind: string; count: number; p50Ms: number | null; p95Ms: number | null; targetMs: number; overTarget: boolean }[]; total: number; liveShare: number | null };
}
let batchView: BatchView | null = null;
const TRIGGER_LABEL: Record<string, string> = { schedule: "Closing time", size: "Enough work gathered", age: "Waited too long", run_now: "Client pressed Run now", owner: "You pressed Run all now", urgent: "After an urgent task" };
const when = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let view: Overview;
let live = false;
/** Pending edits keyed by settings path, for example "runpod.model" or "policies.standard.minScore". */
const edits = new Map<string, string | number | boolean | null>();

const tile = (label: string, value: string, note: string, tone = "") => `<div class="tile-kpi"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span><span class="dl ${tone}">${esc(note)}</span></div>`;

function renderKpis(): void {
  const m = view.month;
  const actual = m.runpodMicro + m.claudeMicro;
  const saved = m.baselineMicro - actual;
  const served = m.runpodCalls + m.claudeDirect + m.fallbacks;
  $("ai-kpis").innerHTML = [
    tile("AI spend this month", usd(actual), `RunPod ${usd(m.runpodMicro)} · Claude ${usd(m.claudeMicro)}`),
    tile("Claude-only would be", usd(m.baselineMicro), "Same work, priced on the baseline Claude models"),
    tile(saved >= 0 ? "Saved" : "Costing more", usd(Math.abs(saved)), m.baselineMicro > 0 ? `${saved >= 0 ? "" : "-"}${pct(Math.abs(saved), m.baselineMicro)} against Claude only` : "No work yet", saved >= 0 ? "up" : "warn"),
    tile("Done on RunPod", pct(m.runpodCalls, served), `${m.runpodCalls.toLocaleString("en-GB")} of ${served.toLocaleString("en-GB")} tasks`),
    tile("Claude checks", m.reviews.toLocaleString("en-GB"), m.reviews ? `${pct(m.reviews - m.reviewFails, m.reviews)} passed · ${m.escalations} redone` : "None sampled yet"),
    tile("Done in batches", m.batchJobs.toLocaleString("en-GB"), m.batchRuns ? `${m.batchRuns} runs · ${usd(m.batchBaselineMicro - m.batchActualMicro)} saved against Claude only` : "No batch has run yet"),
    tile("GPU starts avoided", usd(m.coldStartSavedMicro), "Estimated: one cold start per batch instead of one per task"),
    tile("Saved by the cache", usd(m.cacheSavedMicro), `${m.cacheHits.toLocaleString("en-GB")} repeat requests`),
  ].join("");
}

function meter(label: string, used: number, capUsd: number | null, note: string): string {
  const ratio = capUsd ? Math.min(1, used / (capUsd * 1e6)) : 0;
  const tone = ratio >= 1 ? "warn" : "";
  return `<div class="field"><span class="lbl">${esc(label)}</span><strong style="font-variant-numeric:tabular-nums">${usd(used)}${capUsd !== null ? ` of ${usd(capUsd * 1e6)}` : " (no cap)"}</strong>${capUsd !== null ? `<progress max="100" value="${Math.round(ratio * 100)}" aria-label="${esc(label)} used"></progress>` : ""}<span class="hint ${tone}">${esc(ratio >= 1 ? "Cap reached" : note)}</span></div>`;
}

function renderStatus(): void {
  const s = view.status; const b = view.settings.budgets;
  const provider = (name: string, on: boolean, extra: string) => `<div class="field"><span class="lbl">${esc(name)}</span><span class="status ${on ? "good" : "warn"}"><span class="dot"></span>${on ? "Connected" : "Not set up"}</span><span class="hint">${esc(extra)}</span></div>`;
  $("ai-status").innerHTML = [
    provider("RunPod (does the work)", view.configured.runpod, !view.configured.runpod ? "Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID on the server. Until then Claude does everything." : s?.breakerOpen ? `Paused after ${s.consecutiveFailures} failures; Claude is covering until ${new Date(s.breakerOpenUntil!).toLocaleTimeString("en-GB")}` : view.settings.runpod.enabled ? "Taking work" : "Switched off in the settings below"),
    provider("Claude (checks and backs up)", view.configured.claude, view.configured.claude ? "Spot-checks RunPod answers, redoes weak ones, covers outages" : "Set ANTHROPIC_API_KEY on the server. Without it nothing is checked."),
    meter("Claude today", view.claudeTodayMicro, b.claudeDailyUsd, "Daily cap"),
    meter("Claude this month", view.claudeMonthMicro, b.claudeMonthlyUsd, "Monthly cap"),
    meter("RunPod this month", view.runpodMonthMicro, b.runpodMonthlyUsd, view.settings.runpod.billing === "seconds" ? "Estimated from GPU seconds; compare with the RunPod invoice" : "Estimated from tokens"),
  ].join("");
}

function renderTables(): void {
  const pr = Object.entries(view.byPolicy).sort((a, b) => b[1].baselineMicro - a[1].baselineMicro).map(([k, p]) => {
    const actual = p.runpodMicro + p.claudeMicro;
    return `<tr><td class="ow-title"><b>${esc(k)}</b></td><td class="num">${p.calls.toLocaleString("en-GB")}</td><td class="num">${usd(actual)}</td><td class="num">${usd(p.baselineMicro)}</td><td class="num">${usd(p.baselineMicro - actual)}</td><td class="num">${p.escalations}</td><td class="num">${p.reviewFails}</td></tr>`;
  }).join("");
  $("ai-policies").innerHTML = `<thead><tr><th scope="col">Work</th><th scope="col" class="num">Tasks</th><th scope="col" class="num">Spend</th><th scope="col" class="num">Claude-only</th><th scope="col" class="num">Saved</th><th scope="col" class="num">Redone</th><th scope="col" class="num">Failed checks</th></tr></thead><tbody>${pr || '<tr><td colspan="7" class="muted">No work yet this month.</td></tr>'}</tbody>`;
  const rows = [...view.days].reverse().map((d) => {
    const actual = d.runpodMicro + d.claudeMicro;
    return `<tr><td>${esc(new Date(d.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</td><td class="num">${d.calls.toLocaleString("en-GB")}</td><td class="num">${d.cacheHits}</td><td class="num">${d.fallbacks}</td><td class="num">${d.escalations}</td><td class="num">${usd(actual)}</td><td class="num">${usd(d.baselineMicro)}</td><td class="num">${usd(d.baselineMicro - actual)}</td></tr>`;
  }).join("");
  $("ai-days").innerHTML = `<thead><tr><th scope="col">Day</th><th scope="col" class="num">Tasks</th><th scope="col" class="num">From cache</th><th scope="col" class="num">Claude covered RunPod</th><th scope="col" class="num">Redone</th><th scope="col" class="num">Spend</th><th scope="col" class="num">Claude-only</th><th scope="col" class="num">Saved</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">No work yet.</td></tr>'}</tbody>`;
}

const KIND_LABEL: Record<string, string> = { instant: "Answered from records", lookup: "Quick questions", live: "Live work (RunPod)", batch_wait: "Batched work, queue to filed" };
/** Human duration: 3 ms, 4.2 s, 6 h. */
function span(ms: number | null): string {
  if (ms === null) return "no data yet";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${Math.round(ms / 100) / 10} s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 360_000) / 10} h`;
}
/** How long clients really wait against the targets, and how much work skips the batch. */
function speed(l: BatchView["latency"]): string {
  if (!l) return "";
  const rows = l.stats.map((x) => `<tr><td class="ow-title"><b>${esc(KIND_LABEL[x.kind] ?? x.kind)}</b></td><td class="num">${x.count.toLocaleString("en-GB")}</td><td class="num">${esc(span(x.p50Ms))}</td><td class="num">${esc(span(x.p95Ms))}</td><td class="num">${esc(span(x.targetMs))}</td><td>${x.p95Ms === null ? "" : x.overTarget ? "Slower than target" : "Within target"}</td></tr>`).join("");
  const share = l.liveShare === null ? "No model work yet" : `${Math.round(l.liveShare * 100)}% of model-answered work skipped the batch`;
  const warn = l.liveShare !== null && l.liveShare > 0.4 ? "warn" : "";
  return `<section class="panel" aria-labelledby="ai-speed-h" style="margin:0 0 16px"><div class="panel-h"><h2 id="ai-speed-h">How fast clients are served</h2></div>
    <p class="muted" style="margin:0 0 8px">Measured since the last restart. ${esc(share)}${warn ? ". Above about 40% the batch saving is shrinking: check the free-trial and first-tasks settings." : "."}</p>
    <div class="tbl-wrap" tabindex="0" role="region" aria-label="Waiting time by kind of request, scrolls sideways on small screens"><table class="tbl"><thead><tr><th scope="col">Kind</th><th scope="col" class="num">Count</th><th scope="col" class="num">Typical</th><th scope="col" class="num">Slowest 1 in 20</th><th scope="col" class="num">Target</th><th scope="col">Result</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderBatch(): void {
  const b = batchView;
  const box = $("ai-batch");
  if (!b) { box.innerHTML = '<p class="muted">The batch queue could not be loaded.</p>'; return; }
  const tiles = [
    tile("Waiting", String(b.queued), b.running ? `${b.running} running now` : "Sent at closing time"),
    tile("Next run due", b.nextDueAt ? when(b.nextDueAt) : "Nothing waiting", b.queued ? `Oldest has waited ${Math.round(b.oldestMinutes / 60 * 10) / 10} h` : "Queue is empty"),
    tile("Estimated size", `${b.estTokens.toLocaleString("en-GB")} tokens`, `Early run at ${view.settings.batch.sizeTrigger} tasks or ${view.settings.batch.tokenTrigger.toLocaleString("en-GB")} tokens`),
  ].join("");
  const g = b.gpuPlan;
  const plan = `<section class="panel" aria-labelledby="ai-gpu-h" style="margin:0 0 16px"><div class="panel-h"><h2 id="ai-gpu-h">Tonight's GPU plan</h2></div>
    <p style="margin:0 0 10px"><b>${esc(g.advice)}</b></p>
    <div class="kpis">${[
      tile("Recommended", `${g.gpus} x ${g.sizeGb} GB`, `Finishes in about ${g.runHours < 0.1 ? "minutes" : `${Math.round(g.runHours * 10) / 10} h`}, window ${g.windowHours} h`),
      tile("Set now", `${g.current.gpus} x ${g.current.sizeGb} GB`, g.current.finishesInWindow ? "Finishes inside the window" : "Too slow for the window"),
      tile("Estimated cost", usd(Math.round(g.costUsd * 1_000_000)), `${g.pending} tasks at about ${g.taskSeconds} s each`),
    ].join("")}</div>
    <p class="muted" style="margin:8px 0 0">Planning figures, not an invoice. Set the GPU count and size under Settings, and make the RunPod endpoint's workers match.</p></section>`;
  const clients = b.byClient.map((c) => `<tr><td class="ow-title"><b>${esc(c.name)}</b></td><td class="num">${c.queued}</td><td>${esc(when(c.nextAt))}</td></tr>`).join("");
  const runs = b.runs.map((r) => `<tr><td>${esc(when(r.startedAt))}</td><td>${esc(TRIGGER_LABEL[r.trigger] ?? r.trigger)}</td><td class="num">${r.jobs}</td><td class="num">${r.done}</td><td class="num">${r.retried}</td><td class="num">${r.failed}</td><td class="num">${r.clients}</td><td class="num">${usd(r.actualMicro)}</td><td class="num">${usd(r.savedMicro)}</td></tr>`).join("");
  box.innerHTML = `${plan}${speed(b.latency)}<div class="kpis">${tiles}</div>
    <div class="tbl-wrap" tabindex="0" role="region" aria-label="Clients with waiting tasks, scrolls sideways on small screens"><table class="tbl"><thead><tr><th scope="col">Client</th><th scope="col" class="num">Waiting</th><th scope="col">Next scheduled run</th></tr></thead><tbody>${clients || '<tr><td colspan="3" class="muted">Nothing is waiting.</td></tr>'}</tbody></table></div>
    <div class="tbl-wrap" tabindex="0" role="region" aria-label="Recent batch runs, scrolls sideways on small screens"><table class="tbl"><thead><tr><th scope="col">Started</th><th scope="col">Why it ran</th><th scope="col" class="num">Tasks</th><th scope="col" class="num">Filed</th><th scope="col" class="num">Retry later</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Clients</th><th scope="col" class="num">Spend</th><th scope="col" class="num">Saved</th></tr></thead><tbody>${runs || '<tr><td colspan="9" class="muted">No batch has run yet.</td></tr>'}</tbody></table></div>
    <h3 style="font-size:1rem;margin:16px 0 6px">Always real-time, never batched</h3>
    <ul class="ow-list">${b.realTime.map((r) => `<li><b>${esc(r.what)}.</b> ${esc(r.why)}.</li>`).join("")}</ul>`;
}

const val = (path: string): unknown => path.split(".").reduce<any>((o, k) => o?.[k], view.settings);

interface Field { path: string; label: string; kind: "text" | "number" | "cap" | "bool" | "select"; hint?: string; options?: [string, string][]; step?: string }
const FIELDS: Field[] = [
  { path: "runpod.model", label: "RunPod model name", kind: "text", hint: "Exactly the model the endpoint serves, for example a Qwen model" },
  { path: "runpod.enabled", label: "Use RunPod", kind: "bool", hint: "Off sends everything to Claude" },
  { path: "runpod.billing", label: "Count RunPod cost by", kind: "select", options: [["seconds", "GPU seconds"], ["tokens", "Tokens"]], hint: "GPU seconds overstates when requests share a GPU" },
  { path: "runpod.gpuUsdPerSecond", label: "GPU price per second ($)", kind: "number", step: "0.00001", hint: "From the RunPod pricing page for your GPU" },
  { path: "runpod.softDeadlineMs", label: "Hand over to Claude after (ms)", kind: "number", step: "1000", hint: "Covers a cold start" },
  { path: "reviewer.model", label: "Claude model that checks", kind: "text" },
  { path: "reviewer.enabled", label: "Claude checks answers", kind: "bool" },
  { path: "budgets.claudeDailyUsd", label: "Claude cap per day ($)", kind: "cap", hint: "Blank = no cap" },
  { path: "budgets.claudeMonthlyUsd", label: "Claude cap per month ($)", kind: "cap", hint: "Blank = no cap" },
  { path: "budgets.claudePerWorkspaceMonthlyUsd", label: "Claude cap per client per month ($)", kind: "cap", hint: "Blank = no cap" },
  { path: "budgets.runpodMonthlyUsd", label: "RunPod cap per month ($)", kind: "cap", hint: "Blank = no cap" },
  { path: "batch.enabled", label: "Batch non-urgent work", kind: "bool", hint: "Off runs everything at once, as before" },
  { path: "batch.sizeTrigger", label: "Run early at this many waiting tasks", kind: "number", step: "1", hint: "Across all clients" },
  { path: "batch.tokenTrigger", label: "Or at this many estimated tokens", kind: "number", step: "1000" },
  { path: "batch.maxQueueAgeHours", label: "Never wait longer than (hours)", kind: "number", step: "1", hint: "Runs even if closing time is far off" },
  { path: "batch.gpuWorkers", label: "GPUs for the overnight run", kind: "number", step: "1", hint: "Fixed, so the night's cost is known. The GPU plan above recommends a number" },
  { path: "batch.gpuSizeGb", label: "GPU memory (GB)", kind: "number", step: "1", hint: "24, 48 or 80. Set the endpoint's workers to match" },
  { path: "batch.windowHours", label: "Overnight window (hours)", kind: "number", step: "1", hint: "From closing time until results must be in" },
  { path: "batch.concurrency", label: "Tasks each GPU serves at once", kind: "number", step: "1", hint: "Keep within what one GPU holds in memory" },
  { path: "batch.maxAttempts", label: "Tries before a task fails", kind: "number", step: "1" },
  { path: "batch.retryBackoffMinutes", label: "Wait between tries (minutes)", kind: "number", step: "1", hint: "Multiplied by the try number" },
  { path: "batch.qaRateMin", label: "Claude reads at least this share of batch answers", kind: "number", step: "0.05", hint: "0 to 1. Nobody waits on the answer, so this can be generous" },
  { path: "batch.claudeAfterFailures", label: "Claude finishes a task after the last failed try", kind: "bool", hint: "Off means a pod outage leaves tasks failed, never on Claude" },
  { path: "batch.flushAfterUrgent", label: "Urgent work also clears the queue", kind: "bool", hint: "The pod is warm, so everything waiting runs right after an urgent task, at any time" },
  { path: "batch.liveDuringTrial", label: "Free-trial clients get answers at once", kind: "bool", hint: "Ordinary work is not held for the evening batch while a client is on a trial" },
  { path: "batch.liveFirstTasks", label: "Answer a client's first tasks at once", kind: "number", step: "1", hint: "Number of answers per client, whatever their plan. 0 switches it off" },
  { path: "batch.coldStartSeconds", label: "Cold start length (seconds)", kind: "number", step: "1", hint: "Only used to estimate the saving" },
  { path: "budgets.whenClaudeCapped", label: "When Claude is capped", kind: "select", options: [["degrade", "Keep working, unchecked"], ["fail", "Stop Claude-only work"]] },
];

function input(f: { path: string; label: string; kind: Field["kind"]; options?: [string, string][]; step?: string }, v: unknown, bare = false): string {
  const k = `data-p="${esc(f.path)}" data-t="${f.kind}"`; const id = `ai-${f.path.replace(/\W/g, "-")}`;
  if (f.kind === "bool" && bare) return `<input type="checkbox" aria-label="${esc(f.label)}" style="width:20px;height:20px;accent-color:var(--color-graphite)" ${k}${v ? " checked" : ""}>`;
  if (f.kind === "bool") return `<label class="ow-check"><input type="checkbox" ${k}${v ? " checked" : ""}>${esc(f.label)}</label>`;
  if (f.kind === "select") return `<select class="input" id="${id}" ${k}${bare ? ` aria-label="${esc(f.label)}" style="min-width:130px"` : ""}>${f.options!.map(([o, l]) => `<option value="${esc(o)}"${o === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  if (f.kind === "text") return `<input class="input" id="${id}" type="text" maxlength="120" ${bare ? `aria-label="${esc(f.label)}" style="min-width:190px" ` : ""}${k} value="${esc(String(v ?? ""))}">`;
  return `<input class="input" id="${id}" type="number" min="0" step="${f.step ?? "0.01"}" inputmode="decimal" ${bare ? `aria-label="${esc(f.label)}" style="min-width:80px" ` : ""}${k} value="${v === null || v === undefined ? "" : esc(String(v))}">`;
}

function renderSettings(): void {
  $("ai-settings").innerHTML = FIELDS.map((f) => f.kind === "bool"
    ? `<div class="field">${input(f, val(f.path))}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}</div>`
    : `<div class="field"><label for="ai-${f.path.replace(/\W/g, "-")}">${esc(f.label)}</label>${input(f, val(f.path))}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}</div>`).join("");
  const cell = (key: string, name: string, kind: Field["kind"], v: unknown, extra: Partial<Field> = {}) => `<td>${input({ path: `policies.${key}.${name}`, label: `${key} ${name}`, kind, ...extra }, v, true)}</td>`;
  const rows = Object.entries(view.settings.policies).map(([k, p]) => `<tr><td class="ow-title"><b>${esc(k)}</b></td>
    ${cell(k, "primary", "select", p.primary, { options: [["runpod", "RunPod first"], ["claude", "Claude only"]] })}
    ${cell(k, "reviewRate", "number", p.reviewRate, { step: "0.05" })}${cell(k, "minScore", "number", p.minScore, { step: "0.5" })}
    ${cell(k, "escalate", "bool", p.escalate)}${cell(k, "allowOpenModel", "bool", p.allowOpenModel)}${cell(k, "fallbackToClaude", "bool", p.fallbackToClaude)}
    ${cell(k, "claudeModel", "text", p.claudeModel)}${cell(k, "escalationModel", "text", p.escalationModel)}${cell(k, "baselineModel", "text", p.baselineModel)}</tr>`).join("");
  $("ai-rules").innerHTML = `<thead><tr><th scope="col">Work</th><th scope="col">First choice</th><th scope="col">Check rate (0-1)</th><th scope="col">Pass mark (1-10)</th><th scope="col">Redo if weak</th><th scope="col">Claude covers outages</th><th scope="col">Open model if Claude is capped</th><th scope="col">Claude model</th><th scope="col">Redo model</th><th scope="col">Savings measured against</th></tr></thead><tbody>${rows}</tbody>`;
  for (const [p, v] of edits) {
    const el = document.querySelector<HTMLInputElement>(`[data-p="${CSS.escape(p)}"]`);
    if (el) { if (el.type === "checkbox") el.checked = Boolean(v); else el.value = v === null ? "" : String(v); }
  }
}

function track(el: HTMLInputElement | HTMLSelectElement): void {
  const p = el.dataset.p!; const t = el.dataset.t!;
  const raw = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value.trim();
  let v: string | number | boolean | null = raw;
  if (t === "number" || t === "cap") v = raw === "" ? (t === "cap" ? null : NaN) : Number(raw);
  const bad = typeof v === "number" && (!Number.isFinite(v) || v < 0);
  el.toggleAttribute("aria-invalid", bad);
  if (bad || v === val(p)) edits.delete(p); else edits.set(p, v);
  $("ai-changed").textContent = edits.size ? `${edits.size} change${edits.size === 1 ? "" : "s"} to save` : "No changes yet";
  $<HTMLButtonElement>("ai-save").disabled = edits.size === 0;
}

/** Turns "policies.standard.minScore" edits into a nested patch for the API. */
function patch(): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [path, v] of edits) {
    const keys = path.split(".");
    let o = out;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
    o[keys[keys.length - 1]!] = v;
  }
  return out;
}

function renderAll(): void {
  edits.clear();
  renderKpis(); renderStatus(); renderTables(); renderBatch(); renderSettings();
  $("ai-changed").textContent = "No changes yet";
  $<HTMLButtonElement>("ai-save").disabled = true;
}

const form = $<HTMLFormElement>("ai-form");
const onEdit = (e: Event) => { const el = e.target as HTMLInputElement; if (el.dataset?.p) track(el); };
form.addEventListener("input", onEdit);
form.addEventListener("change", onEdit);
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!edits.size) return;
  if (!live) { toast("Example data: connect the API to save settings."); return; }
  $<HTMLButtonElement>("ai-save").disabled = true;
  const r = await api<Overview & { error?: string }>("/owner/ai/settings", { body: patch() });
  if (!r.ok || !r.data) { $<HTMLButtonElement>("ai-save").disabled = false; toast(r.data?.error ? `${r.data.error[0]!.toUpperCase()}${r.data.error.slice(1)}` : "Could not save. Try again."); return; }
  view = r.data; renderAll(); toast("Saved. The next task uses these settings.");
});
$("ai-health").addEventListener("click", async () => {
  const out = $("ai-health-out");
  if (!live) { out.textContent = "Example data: connect the API to check RunPod."; return; }
  out.textContent = "Checking…";
  const r = await api<{ reachable: boolean; workers?: Record<string, number>; jobs?: Record<string, number>; error?: string }>("/owner/ai/health");
  const h = r.data;
  if (!h) { out.textContent = "Could not check. Try again."; return; }
  const list = (o?: Record<string, number>) => Object.entries(o ?? {}).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  out.textContent = h.reachable ? `RunPod answers. Workers: ${list(h.workers)}. Jobs: ${list(h.jobs)}.` : `RunPod did not answer${h.error ? `: ${h.error}` : ""}.`;
});

$("ai-run-all").addEventListener("click", async () => {
  if (!live) { toast("Example data: connect the API to run a batch."); return; }
  const btn = $<HTMLButtonElement>("ai-run-all");
  btn.disabled = true;
  const r = await api<BatchView & { started?: boolean; error?: string }>("/owner/batch/run-now", { body: {} });
  btn.disabled = false;
  if (!r.ok || !r.data) { toast(r.data?.error ?? "Could not start the batch. Try again."); return; }
  batchView = r.data;
  const o = await api<Overview>("/owner/ai");
  if (o.ok && o.data) view = o.data;
  renderAll();
  toast(r.data.started ? "Batch finished." : "Nothing was waiting.");
});

void (async () => {
  const r = await ownerLoad<Overview>("/owner/ai");
  if (!r) return;
  if (r === "demo") { view = demo(); batchView = demoBatch(); markDemo(); } else {
    view = r; live = true;
    const b = await api<BatchView>("/owner/batch");
    batchView = b.ok && b.data ? b.data : null;
  }
  renderAll();
})();
