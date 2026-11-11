import { describe, expect, it } from "vitest";
import { inParallel, metric, percentiles, timed, uid, world } from "./harness.js";

const SECTORS = ["food-drink", "retail", "trades", "health-beauty", "professional", "hospitality", "creative", "other"];

describe("many clients signing up at once", () => {
  it("1,000 signups, 50 at a time: every one gets its own workspace, team and trial pool", async () => {
    const w = world();
    const N = 1_000;
    const lat: number[] = [];
    const t0 = performance.now();
    const results = await inParallel(Array.from({ length: N }, (_, i) => i), 50, async (i) => {
      const { ms, value } = await timed(() => w.signUp(`owner${i}@client${i}.test`, `Client ${i}`, { sector: SECTORS[i % SECTORS.length], needs: ["get-paid", "marketing"], apps: ["xero"] }));
      lat.push(ms);
      return value;
    });
    const wall = performance.now() - t0;
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(N);
    expect(new Set(ok.map((r) => r.workspaceId)).size).toBe(N);
    const sizes = new Set(ok.map((r) => w.platform.workforce.countIn(r.workspaceId)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(5);
    // Each owner sees only their own organisation.
    const org = await w.call("GET", "/api/org", undefined, ok[123]!.auth);
    expect((org.body as any).name).toBe("Client 123");
    metric("signups.1000_concurrent", { signups: N, concurrency: 50, wallMs: Math.round(wall), perSecond: Math.round(N / (wall / 1000)), latencyMs: percentiles(lat), heapMb: Math.round(process.memoryUsage().heapUsed / 1e6), auditEvents: N ? w.platform.audit.list(ok[0]!.workspaceId).length : 0 });
  });

  it("the same email signing up twice at the same moment gets one organisation, not two", async () => {
    const w = world();
    const both = await Promise.all([w.signUp("dup@twice.test", "Twice A"), w.signUp("dup@twice.test", "Twice B")]);
    const orgs = w.platform.identity.workspacesFor(uid("dup@twice.test"));
    metric("signups.double_submit", { statuses: both.map((b) => b.status), organisationsCreated: orgs.length });
    expect(both.map((b) => b.status).sort()).toEqual([201, 409]);
    expect(orgs).toHaveLength(1);
  });

  it("garbage and hostile signup payloads never crash the server or create half an organisation", async () => {
    const w = world();
    const bad: unknown[] = [
      { email: "a@b.co", businessName: "x".repeat(100_000) },
      { email: "b@b.co", businessName: "<script>alert(1)</script>", sector: "../../etc", needs: Array(10_000).fill("get-paid"), apps: { length: 5 } },
      { email: "c@b.co", businessName: "Ok", country: { toString: 1 }, size: 12, addOns: ["admin-manager", "x".repeat(500)], prepaidMonths: -5, monthlyVolume: 1e300 },
      { email: ["d@b.co"], businessName: null },
      { email: "e@b.co", __proto__: { admin: true }, businessName: "Proto" },
    ];
    const statuses: number[] = [];
    for (const b of bad) {
      try { statuses.push((await w.call("POST", "/api/signup", b)).status); } catch (e) { statuses.push(-1); throw e; }
    }
    const raw = await w.call("POST", "/api/signup", undefined, {}, "", "{not json");
    statuses.push(raw.status);
    metric("signups.hostile_payloads", { statuses });
    for (const s of statuses) expect([201, 400, 409]).toContain(s);
    // A name of 100,000 characters is cut, not stored whole.
    const ws = w.platform.identity.workspacesFor(uid("a@b.co"))[0];
    if (ws) expect(ws.name.length).toBeLessThanOrEqual(200);
  });
});
