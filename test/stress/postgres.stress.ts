/**
 * Postgres under load, restarts and a slow network. Needs a real Postgres: `npm run stress:db` starts a throwaway one.
 * A small TCP proxy adds network delay, to see how the single write queue copes with a database that is not local
 * (Neon from Render in the same region is about 1-3 ms a round trip; across regions 20-80 ms).
 */
import { createServer, connect, type Server } from "node:net";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PLANS } from "../../src/modules/energy/index.js";
import { PgStore } from "../../src/storage/postgres.js";
import { inParallel, metric, uid, world } from "./harness.js";

const ADMIN = process.env.TEST_DATABASE_URL;
const APP = process.env.TEST_DATABASE_APP_URL;
const KEY = "cd".repeat(32);

/** Forwards TCP to Postgres, holding every chunk `delayMs` in each direction (order kept). `cut` drops the link. */
function delayProxy(targetPort: number, delayMs: number): Promise<{ port: number; server: Server; cut: () => void; restore: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  let down = false;
  const server = createServer((client) => {
    if (down) { client.destroy(); return; }
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    const pipe = (from: typeof client, to: typeof client) => {
      let chain = Promise.resolve();
      from.on("data", (d) => { chain = chain.then(() => new Promise((r) => setTimeout(() => { if (!to.destroyed) to.write(d); r(); }, delayMs))); });
      from.on("close", () => { sockets.delete(from); void chain.then(() => to.end()); });
      from.on("error", () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({
    port: (server.address() as { port: number }).port,
    server,
    cut: () => { down = true; for (const s of sockets) s.destroy(); },
    restore: async () => { down = false; },
  })));
}

const viaPort = (url: string, port: number) => url.replace(/:(\d+)\//, `:${port}/`);
const pgPort = () => Number(/:(\d+)\//.exec(ADMIN!)![1]);
const proxies: Server[] = [];
afterAll(() => { for (const s of proxies) s.close(); });

async function reset() {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  const t = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")).rows.map((r) => r.tablename);
  if (t.length) await c.query(`TRUNCATE ${t.map((x) => `"${x}"`).join(", ")} CASCADE`);
  await c.end();
}

async function boot(delayMs = 0) {
  let admin = ADMIN!, app = APP!;
  if (delayMs) {
    const p = await delayProxy(pgPort(), delayMs);
    proxies.push(p.server);
    admin = viaPort(ADMIN!, p.port);
    app = viaPort(APP!, p.port);
  }
  const store = new PgStore({ adminUrl: admin, appUrl: app, tokenKeyHex: KEY });
  await store.migrate();
  const w = world();
  const t0 = performance.now();
  await w.platform.attachStore(store);
  return { w, store, loadMs: performance.now() - t0 };
}

/** A client's ordinary day: sign up, rota, sales, a few tasks. */
async function busyClient(w: ReturnType<typeof world>, i: number) {
  const email = `pg${i}@pg.test`;
  const s = await w.signUp(email, `PG Client ${i}`);
  w.platform.energy.setPlan(uid(email), s.workspaceId, { ...PLANS.starter! });
  const staff = ((await w.call("POST", "/api/rota/staff", { name: `Staff ${i}` }, s.auth)).body as any).added.id;
  await w.call("POST", "/api/rota/shifts", { date: "2026-11-17", start: "09:00", end: "17:00", staffId: staff }, s.auth);
  for (let k = 0; k < 20; k++) await w.call("POST", "/api/finance/entries", { date: "2026-11-16", memo: `Sale ${k}`, lines: [{ account: "1000", debit: 500, credit: 0 }, { account: "4000", debit: 0, credit: 500 }] }, s.auth);
  const emp = ((await w.call("GET", "/api/org", undefined, s.auth)).body as any).team.find((e: any) => e.templateKey === "marketing-manager").id;
  for (let k = 0; k < 5; k++) await w.call("POST", "/api/ask", { employeeId: emp, text: `Write post ${k}`, urgent: true }, s.auth);
  for (let k = 0; k < 3; k++) await w.call("POST", "/api/ask", { employeeId: emp, text: `Plan campaign ${k}` }, s.auth);
  return { ...s, email };
}

async function counts() {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  const q = async (t: string) => Number((await c.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
  const r = { workspaces: await q("workspaces"), employees: await q("employees"), journal_entries: await q("journal_entries"), energy_usage: await q("energy_usage"), audit_log: await q("audit_log"), state_records: await q("state_records") };
  await c.end();
  return r;
}

describe.skipIf(!ADMIN || !APP)("Postgres: load, restarts, slow network", () => {
  it("migrations run twice without harm", async () => {
    const store = new PgStore({ adminUrl: ADMIN!, appUrl: APP!, tokenKeyHex: KEY });
    const first = await store.migrate();
    const second = await store.migrate();
    await store.close();
    metric("pg.migrations", { firstRunApplied: first.length, secondRunApplied: second.length });
    expect(second).toEqual([]);
  });

  it("200 busy clients on a local database: write backlog, flush time, rows written, restart time", async () => {
    await reset();
    const { w, store } = await boot();
    const t0 = performance.now();
    await inParallel(Array.from({ length: 200 }, (_, i) => i), 20, (i) => busyClient(w, i));
    const workMs = performance.now() - t0;
    const f0 = performance.now();
    await store.flush();
    const flushMs = performance.now() - f0;
    const rows = await counts();
    const writes = Object.values(rows).reduce((a, b) => a + b, 0);
    await store.close();
    // Restart: a new process loads everything back into memory.
    const heap0 = process.memoryUsage().heapUsed;
    const again = await boot();
    const heapMb = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6);
    const restored = again.w.platform.identity.allWorkspaces().length;
    const one = await again.w.call("GET", "/api/org", undefined, again.w.sessionFor("pg7@pg.test"));
    await again.store.close();
    metric("pg.200_clients_local", { clients: 200, workMs: Math.round(workMs), flushAfterWorkMs: Math.round(flushMs), rows, totalRows: writes, writesPerSecond: Math.round(writes / ((workMs + flushMs) / 1000)), restartLoadMs: Math.round(again.loadMs), restartHeapMb: heapMb, restoredWorkspaces: restored, clientAfterRestart: one.status });
    expect(restored).toBe(200);
    expect(one.status).toBe(200);
  });

  it("the same day with 10 ms each way to the database (20 ms round trip): how far writes fall behind", async () => {
    await reset();
    const { w, store } = await boot(10);
    const t0 = performance.now();
    await inParallel(Array.from({ length: 20 }, (_, i) => i), 10, (i) => busyClient(w, 1_000 + i));
    const workMs = performance.now() - t0;
    const f0 = performance.now();
    await store.flush();
    const flushMs = performance.now() - f0;
    const rows = await counts();
    const writes = Object.values(rows).reduce((a, b) => a + b, 0);
    await store.close();
    metric("pg.20_clients_20ms_rtt", { clients: 20, workMs: Math.round(workMs), backlogDrainMs: Math.round(flushMs), totalRows: writes, writesPerSecond: Math.round(writes / ((workMs + flushMs) / 1000)), shutdownWindowMs: 10_000, wouldLoseOnSigterm: flushMs > 10_000 });
    expect(flushMs).toBeLessThan(10_000);
  });

  it("HR desk: 300 staff with documents and leave are stored encrypted and come back after a restart", async () => {
    await reset();
    const { w, store } = await boot();
    const s = await w.signUp("hrpg@pg.test", "HR PG Ltd");
    const ids: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      const id = ((await w.call("POST", "/api/people", { name: `Person Plaintext${i}`, jobTitle: "Chef", startDate: "2026-01-05", hoursPerWeek: 30, phone: "07700900123" }, s.auth)).body as any).member.id;
      ids.push(id);
      await w.call("POST", `/api/people/${id}/documents/right_to_work`, { status: "checked" }, s.auth);
      await w.call("POST", `/api/people/${id}/leave`, { from: "2026-12-01", days: 1 }, s.auth);
    }
    const workMs = performance.now() - t0;
    const f0 = performance.now();
    await store.flush();
    const flushMs = performance.now() - f0;
    const c = new pg.Client({ connectionString: ADMIN });
    await c.connect();
    const rows = (await c.query("SELECT data::text AS d FROM state_records WHERE kind = 'staff'")).rows as { d: string }[];
    await c.end();
    const plaintext = rows.filter((r) => /Plaintext|07700/.test(r.d)).length;
    const before = ((await w.call("GET", `/api/people/${ids[123]}`, undefined, s.auth)).body as any);
    await store.close();
    const again = await boot();
    const desk = (await again.w.call("GET", "/api/people", undefined, again.w.sessionFor("hrpg@pg.test"))).body as any;
    const after = (await again.w.call("GET", `/api/people/${ids[123]}`, undefined, again.w.sessionFor("hrpg@pg.test"))).body as any;
    await again.store.close();
    metric("pg.hr_desk_restart", { staff: 300, writes: 900, workMs: Math.round(workMs), flushMs: Math.round(flushMs), staffRows: rows.length, rowsWithPlaintextNameOrPhone: plaintext, headcountAfterRestart: desk.summary?.headcount, sameRecordAfterRestart: JSON.stringify(after.member) === JSON.stringify(before.member) });
    expect(rows.length).toBe(300);
    expect(plaintext).toBe(0);
    expect(desk.summary.headcount).toBe(300);
    expect(after.member).toEqual(before.member);
  });

  it("the database drops every connection for 3 seconds: writes wait and retry, nothing is lost", async () => {
    await reset();
    const p = await delayProxy(pgPort(), 0);
    proxies.push(p.server);
    const store = new PgStore({ adminUrl: viaPort(ADMIN!, p.port), appUrl: viaPort(APP!, p.port), tokenKeyHex: KEY });
    await store.migrate();
    const w = world();
    await w.platform.attachStore(store);
    await busyClient(w, 5_000);
    await store.flush();
    p.cut();
    const r = await w.signUp("during@outage.test", "During Outage");
    const healthDuring = (await w.call("GET", "/api/health")).status;
    await new Promise((res) => setTimeout(res, 3_000));
    await p.restore();
    const t0 = performance.now();
    await store.flush();
    const recoverMs = performance.now() - t0;
    const c = new pg.Client({ connectionString: ADMIN });
    await c.connect();
    const saved = Number((await c.query("SELECT count(*) FROM workspaces WHERE owner_email = 'during@outage.test'")).rows[0].count);
    await c.end();
    const healthAfter = (await w.call("GET", "/api/health")).status;
    await store.close();
    metric("pg.outage_3s", { signupDuringOutage: r.status, healthDuring, savedAfterRecovery: saved === 1, msToCatchUpAfterReturn: Math.round(recoverMs), healthAfter, before: "every write during an outage was dropped and /api/health stayed 503 until a restart" });
    expect(saved).toBe(1);
    expect(healthAfter).toBe(200);
  });
});
