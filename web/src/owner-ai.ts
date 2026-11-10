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
  const t = (k: number): Totals => ({ calls: 480 * k, cacheHits: 40 * k, runpodCalls: 420 * k, claudeDirect: 20 * k, fallbacks: 8 * k, reviews: 90 * k, reviewFails: 9 * k, reviewErrors: 0, escalations: 11 * k, lowConfidence: 0, budgetRefused: 0, failures: 1, runpodMicro: 9_400_000 * k, claudeMicro: 5_100_000 * k, baselineMicro: 31_000_000 * k, cacheSavedMicro: 1_900_000 * k, runpodSeconds: 41_000 * k });
  const std: Policy = { calls: 400, runpodMicro: 8_000_000, claudeMicro: 3_000_000, baselineMicro: 20_000_000, escalations: 7, reviewFails: 6 };
  return {
    configured: { runpod: true, claude: true }, status: { breakerOpen: false, breakerOpenUntil: null, consecutiveFailures: 0, cacheEntries: 112 },
    settings: demoSettings(), month: t(1), today: t(0.05), claudeMonthMicro: 5_100_000, claudeTodayMicro: 260_000, runpodMonthMicro: 9_400_000,
    byPolicy: { standard: std, premium: { ...std, calls: 70, baselineMicro: 9_000_000 }, "compliance-manager": { calls: 10, runpodMicro: 0, claudeMicro: 400_000, baselineMicro: 400_000, escalations: 0, reviewFails: 0 } },
    days: Array.from({ length: 7 }, (_, i) => ({ ...t(0.14), day: new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10), byPolicy: {} })) as Overview["days"],
  };
}
function demoSettings(): AiRoutingSettings {
  const p = (o: Partial<PolicySettings> = {}): PolicySettings => ({ primary: "runpod", claudeModel: "claude-haiku-5-5", baselineModel: "claude-haiku-5-5", reviewRate: 0.15, minScore: 7, escalate: true, escalationModel: "claude-sonnet-5-5", fallbackToClaude: true, allowOpenModel: true, cache: true, ...o });
  return {
    runpod: { enabled: true, model: "Qwen/Qwen3-30B-A3B-Instruct-2507", billing: "seconds", gpuUsdPerSecond: 0.00034, tokenPrice: { inputPer1k: 60, outputPer1k: 250 }, softDeadlineMs: 45000, hardTimeoutMs: 120000, attempts: 2, breakerFailures: 3, breakerCooldownMs: 60000 },
    reviewer: { enabled: true, model: "claude-haiku-5-5", maxInputChars: 12000, adaptive: true }, cache: { enabled: true, ttlSeconds: 3600, maxEntries: 500 },
    budgets: { claudeDailyUsd: 15, claudeMonthlyUsd: 200, claudePerWorkspaceMonthlyUsd: 20, runpodMonthlyUsd: 300, whenClaudeCapped: "degrade" }, prices: {},
    policies: { standard: p(), premium: p({ claudeModel: "claude-sonnet-5-5", baselineModel: "claude-sonnet-5-5", reviewRate: 0.5, minScore: 8 }), "compliance-manager": p({ primary: "claude", reviewRate: 0, escalate: false, fallbackToClaude: false, allowOpenModel: false }) },
  };
}

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
  { path: "budgets.whenClaudeCapped", label: "When Claude is capped", kind: "select", options: [["degrade", "Keep working, unchecked"], ["fail", "Stop Claude-only work"]] },
];

function input(f: { path: string; label: string; kind: Field["kind"]; options?: [string, string][]; step?: string }, v: unknown, bare = false): string {
  const k = `data-p="${esc(f.path)}" data-t="${f.kind}"`; const id = `ai-${f.path.replace(/\W/g, "-")}`;
  if (f.kind === "bool" && bare) return `<input type="checkbox" aria-label="${esc(f.label)}" style="width:20px;height:20px;accent-color:var(--color-aurora-purple)" ${k}${v ? " checked" : ""}>`;
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
  renderKpis(); renderStatus(); renderTables(); renderSettings();
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

void (async () => {
  const r = await ownerLoad<Overview>("/owner/ai");
  if (!r) return;
  if (r === "demo") { view = demo(); markDemo(); } else { view = r; live = true; }
  renderAll();
})();
