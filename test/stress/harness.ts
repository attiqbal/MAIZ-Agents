/**
 * Stress-test harness: builds the real platform (every module, real routing gateway) with fake RunPod and Claude
 * endpoints behind the same `http` hook the adapters use, a controllable clock, and an in-memory mailbox.
 * No real keys and no network. Each scenario records its numbers with `metric()`; `npm run stress` writes them
 * to test/stress/out/report.json.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createApp, makeToken, type Req, type Res } from "../../src/server/app.js";
import { userIdFor } from "../../src/server/identity.js";
import { createPlatform, type PlatformConfig } from "../../src/server/platform.js";
import { MemoryEmailSender } from "../../src/server/email.js";
import { MockPaymentProvider } from "../../src/modules/payments/index.js";

export const OWNER = "owner@maiz.test";
export const SECRET = "stress-secret";

/** How a fake provider behaves right now. Change it mid-test to simulate an outage or a recovery. */
export type Mode = "ok" | "http500" | "http429" | "http401" | "hang" | "network" | "garbage" | "empty" | "loop";
export interface ProviderSim {
  mode: Mode;
  latencyMs: number;
  calls: number;
  failures: number;
  /** Reviewer score Claude gives when asked to review (only for the anthropic fake). */
  reviewScore: number;
  /** Fail only the next n calls, then go back to ok. */
  failNext: number;
  failMode: Mode;
}
const sim = (): ProviderSim => ({ mode: "ok", latencyMs: 0, calls: 0, failures: 0, reviewScore: 9, failNext: 0, failMode: "http500" });

const OUT_TEXT = "Here is the finished work for your business. It covers what you asked, step by step, with figures taken from your records and clear next actions for you to approve.";

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })); }, { once: true });
  });
}

/** Builds a fake `fetch` for RunPod (OpenAI-compatible route) and Anthropic, plus no-op answers for anything else. */
export function fakeHttp(runpod: ProviderSim, claude: ProviderSim) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const s = u.includes("api.runpod.ai") ? runpod : u.includes("api.anthropic.com") ? claude : undefined;
    if (!s) return respond(200, { ok: true });
    s.calls++;
    let mode = s.mode;
    if (s.failNext > 0) { s.failNext--; mode = s.failMode; }
    if (u.endsWith("/health")) return respond(200, { workers: { idle: 1 }, jobs: { inQueue: 0 } });
    if (mode === "hang") { s.failures++; await wait(10 * 60_000, init?.signal); }
    await wait(s.latencyMs, init?.signal);
    if (mode === "network") { s.failures++; throw new TypeError("fetch failed"); }
    if (mode === "http500") { s.failures++; return respond(500, { error: "boom" }); }
    if (mode === "http429") { s.failures++; return respond(429, { error: "slow down" }); }
    if (mode === "http401") { s.failures++; return respond(401, { error: "bad key" }); }
    if (mode === "garbage") { s.failures++; return respond(200, "<html>gateway</html>"); }
    const req = JSON.parse(String(init?.body ?? "{}"));
    const msgs: { role: string; content: string }[] = req.messages ?? [];
    const promptChars = msgs.reduce((n, m) => n + String(m.content).length, 0) + String(req.system ?? "").length;
    const isReview = String(req.system ?? "").includes("strict quality reviewer");
    const text = mode === "empty" ? "" : mode === "loop" ? "again and again and again ".repeat(20) : isReview ? JSON.stringify({ score: s.reviewScore, issues: s.reviewScore < 7 ? ["vague"] : [] }) : OUT_TEXT;
    const inTok = Math.ceil(promptChars / 4);
    const outTok = Math.ceil(text.length / 4) + (isReview ? 0 : 600);
    if (s === runpod) return respond(200, { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: inTok, completion_tokens: outTok } });
    return respond(200, { content: [{ type: "text", text }], usage: { input_tokens: inTok, output_tokens: outTok }, stop_reason: "end_turn" });
  }) as unknown as typeof fetch;
}

export interface World {
  platform: ReturnType<typeof createPlatform>;
  handle: (req: Req) => Promise<Res>;
  call: (method: string, path: string, body?: unknown, auth?: Record<string, string>, query?: string, rawBody?: string) => Promise<Res>;
  clock: { d: Date };
  mail: MemoryEmailSender;
  runpod: ProviderSim;
  claude: ProviderSim;
  payments: MockPaymentProvider;
  sessionFor: (email: string) => Record<string, string>;
  owner: Record<string, string>;
  signUp: (email: string, businessName: string, extra?: Record<string, unknown>) => Promise<{ auth: Record<string, string>; workspaceId: string; status: number }>;
}

/** The whole platform with fake AI providers. `ai: false` uses the built-in mock answers (no routing gateway). */
export function world(opts: { ai?: boolean; start?: string; cfg?: Partial<PlatformConfig>; payments?: MockPaymentProvider } = {}): World {
  const clock = { d: new Date(opts.start ?? "2026-11-16T09:00:00Z") }; // a Monday morning
  const mail = new MemoryEmailSender();
  const runpod = sim();
  const claude = sim();
  const payments = opts.payments ?? new MockPaymentProvider();
  const ai = opts.ai ?? true;
  const platform = createPlatform({
    sessionSecret: SECRET,
    allowDevAuth: true,
    email: mail,
    appUrl: "https://app.test",
    platformOwners: [OWNER],
    now: () => clock.d,
    http: fakeHttp(runpod, claude),
    payments,
    ...(ai ? { runpod: { apiKey: "rp-test", endpointId: "stresstest01" }, anthropicApiKey: "sk-test" } : {}),
    ...opts.cfg,
  });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, auth: Record<string, string> = {}, query = "", rawBody?: string) =>
    handle({ method, path, query: new URLSearchParams(query), headers: auth, rawBody: rawBody ?? (body === undefined ? "" : JSON.stringify(body)) });
  const sessionFor = (email: string) => ({ authorization: `Bearer ${makeToken(SECRET, { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string, businessName: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/signup", { email, businessName, sector: "food-drink", needs: ["get-paid"], size: "2-10", country: "GB", ...extra });
    const b = r.body as { token?: string; workspaceId?: string };
    return { auth: { authorization: `Bearer ${b.token}` }, workspaceId: b.workspaceId ?? "", status: r.status };
  };
  return { platform, handle, call, clock, mail, runpod, claude, payments, sessionFor, owner: sessionFor(OWNER), signUp };
}

/** Wall time of fn in milliseconds. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

export function percentiles(xs: number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(s[s.length - 1] ?? 0) };
}

/** Runs fn over items with at most `limit` at once. */
export async function inParallel<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- the report ----------
const OUT_DIR = join(import.meta.dirname, "out");
const OUT = join(OUT_DIR, "report.json");

/** Records one scenario's numbers. Merged into one report file so every stress file adds to the same run. */
export function metric(scenario: string, data: Record<string, unknown>): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const cur: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  cur[scenario] = { ...data, at: new Date().toISOString() };
  writeFileSync(OUT, JSON.stringify(cur, null, 2));
}

export const uid = userIdFor;
