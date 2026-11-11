/**
 * The real server process (src/server/main.ts) on a local port: rate limits, body limits, forged client
 * addresses, many connections at once, and graceful shutdown. Mock AI (no keys), memory storage.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inParallel, metric, percentiles } from "./harness.js";

const PORT = 18_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let log = "";

async function up(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}

function start(extra: Record<string, string> = {}): ChildProcess {
  const p = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../../src/server/main.ts")], {
    env: { ...process.env, PORT: String(PORT), ALLOW_DEV_AUTH: "1", NODE_ENV: "development", PLATFORM_OWNER_EMAILS: "owner@maiz.test", WEB_DIST: "/nonexistent", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout!.on("data", (d) => { log += d; });
  p.stderr!.on("data", (d) => { log += d; });
  return p;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** A request on its own new connection (fetch may reuse one the server closed after a 413). */
function rawPost(path: string, body: string, ip: string): Promise<number> {
  return new Promise((resolve) => {
    const r = httpRequest({ host: "127.0.0.1", port: PORT, path, method: "POST", agent: false, headers: { "content-type": "application/json", "x-forwarded-for": ip, "content-length": Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", () => resolve(-1));
    r.end(body);
  });
}

beforeAll(async () => { proc = start({ TRUST_PROXY: "1" }); await up(); });
afterAll(() => { proc?.kill("SIGKILL"); });

describe("the real server under abuse", () => {
  it("sign-up is limited to 10 per address per 10 minutes, and a forged X-Forwarded-For does not get round it", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await post("/api/signup", { email: `rl${i}@x.test`, businessName: `RL ${i}` }, { "x-forwarded-for": `${i}.1.1.1, 9.9.9.9` })).status);
    const ok = statuses.filter((s) => s === 201).length;
    metric("http.signup_rate_limit", { attempts: 30, created: ok, limited: statuses.filter((s) => s === 429).length, note: "client-sent X-Forwarded-For entries vary; the proxy-added last entry (9.9.9.9) is the same" });
    expect(ok).toBe(10);
  });

  it("2,000 requests from 200 connections at once to the public store and health routes", async () => {
    const lat: number[] = [];
    const statuses: Record<number, number> = {};
    const t0 = performance.now();
    await inParallel(Array.from({ length: 2_000 }, (_, i) => i), 200, async (i) => {
      const s = performance.now();
      const r = await fetch(`${BASE}${i % 2 ? "/api/store" : "/api/health"}`);
      await r.arrayBuffer();
      lat.push(performance.now() - s);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    });
    const wall = performance.now() - t0;
    const store = await (await fetch(`${BASE}/api/store`)).arrayBuffer();
    metric("http.public_burst", { requests: 2_000, connections: 200, wallMs: Math.round(wall), perSecond: Math.round(2_000 / (wall / 1000)), latencyMs: percentiles(lat), statuses, storeResponseKb: Math.round(store.byteLength / 1024) });
    expect(statuses[200]).toBe(2_000);
  });

  it("a signed-in client hammering /api/ask is cut off at 60 a minute", async () => {
    const r = await post("/api/signup", { email: "hammer@x.test", businessName: "Hammer" }, { "x-forwarded-for": "7.7.7.7" });
    const { token } = (await r.json()) as any;
    const auth = { authorization: `Bearer ${token}` };
    const org = (await (await fetch(`${BASE}/api/org`, { headers: auth })).json()) as any;
    const emp = org.team.find((e: any) => e.templateKey === "marketing-manager").id;
    const statuses: Record<number, number> = {};
    await inParallel(Array.from({ length: 150 }, (_, i) => i), 30, async (i) => {
      const res = await post("/api/ask", { employeeId: emp, text: `What is the status of task ${i}?` }, { ...auth, "x-forwarded-for": "7.7.7.7" });
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    });
    metric("http.ask_rate_limit", { attempts: 150, statuses, note: "limit is per address and path, not per account: the same client from 3 addresses gets 180 a minute" });
    expect(statuses[429]).toBeGreaterThanOrEqual(89);
  });

  it("refuses a 2 MB body, bad JSON and unknown routes without falling over", async () => {
    const big = await post("/api/cart/quote", JSON.stringify({ lines: "x".repeat(2_000_000) }), { "x-forwarded-for": "5.5.5.5" }).then((r) => r.status).catch(() => -1);
    await new Promise((r) => setTimeout(r, 200));
    const badJson = await rawPost("/api/cart/quote", "{oops", "5.5.5.6");
    const unknown = await fetch(`${BASE}/api/nothing-here`, { headers: { connection: "close" } }).then((r) => r.status).catch(() => -1);
    const health = (await fetch(`${BASE}/api/health`)).status;
    metric("http.bad_requests", { twoMbBody: big, badJson, pathTraversal: unknown, healthAfter: health });
    expect([413, -1]).toContain(big);
    expect(badJson).toBe(400);
    expect(health).toBe(200);
  });

  it("stops cleanly on SIGTERM within the 10 s window", async () => {
    const t0 = performance.now();
    const exited = new Promise<number | null>((res) => proc.once("exit", (code) => res(code)));
    proc.kill("SIGTERM");
    const code = await exited;
    metric("http.graceful_shutdown", { exitCode: code, ms: Math.round(performance.now() - t0) });
    expect(code).toBe(0);
  });
});
