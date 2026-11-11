import { describe, expect, it } from "vitest";
import { makeToken } from "../../src/server/app.js";
import { inParallel, metric, OWNER, SECRET, uid, world, type World } from "./harness.js";

const BRAND = {
  title: "Brand kit", employee: "Brand and content creator", days: 5, design: "One kit on a label and a post.",
  brief: [{ label: "Who you sell to", value: "Locals" }, { label: "Colours" }],
  directions: [{ key: "refresh", name: "Refresh", summary: "Keep the logo.", recommended: true }, { key: "rebrand", name: "Rebrand", summary: "New logo." }],
  plan: [{ title: "Layouts", energy: 300 }],
};
const SPECIALIST = { title: "Wholesale account coordinator", purpose: "Look after cafes that buy in bulk", duties: ["Prepare price lists", "Chase repeat orders"] };

/** One client with a little of everything: rota, books, a queued task, a review, a specialist request and an order. */
async function filledClient(w: World, i: number) {
  const marker = `SECRET-MARKER-${i}-${Math.random().toString(36).slice(2, 8)}`;
  const s = await w.signUp(`iso${i}@iso.test`, `Iso Client ${i}`);
  const a = s.auth;
  const staff = ((await w.call("POST", "/api/rota/staff", { name: `${marker} staff`, hourlyRateMinor: 1200 }, a)).body as any).added.id;
  const shift = ((await w.call("POST", "/api/rota/shifts", { date: "2026-11-17", start: "09:00", end: "17:00", staffId: staff }, a)).body as any).shift.id;
  await w.call("POST", "/api/finance/entries", { date: "2026-11-16", memo: `${marker} sale`, lines: [{ account: "1000", debit: 999, credit: 0 }, { account: "4000", debit: 0, credit: 999 }] }, a);
  const team = ((await w.call("GET", "/api/org", undefined, a)).body as any).team;
  const emp = team.find((e: any) => e.templateKey === "marketing-manager").id;
  const job = ((await w.call("POST", "/api/ask", { employeeId: emp, text: `Plan posts about ${marker}`, when: "tonight" }, a)).body as any).jobId;
  const review = ((await w.call("POST", "/api/reviews", { ...BRAND, title: `Brand kit ${marker}` }, a)).body as any).task.id;
  const spec = ((await w.call("POST", "/api/specialists", { ...SPECIALIST, purpose: `${SPECIALIST.purpose} ${marker}` }, a)).body as any).request.id;
  const item = ((await w.call("GET", "/api/store")).body as any).catalogue.find((x: any) => x.kind === "employee");
  const order = ((await w.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, a)).body as any).order.id;
  return { ...s, i, marker, staff, shift, emp, job, review, spec, order, email: `iso${i}@iso.test` };
}

describe("tenant data isolation under load", () => {
  it("50 clients; every client tries every other client's ids on every route; nothing crosses", async () => {
    const w = world();
    const cs = await inParallel(Array.from({ length: 50 }, (_, i) => i), 10, (i) => filledClient(w, i));
    const crossed: string[] = [];
    let attempts = 0;
    for (const me of cs) {
      for (const other of cs) {
        if (other === me) continue;
        const tries: [string, string, unknown?][] = [
          ["POST", `/api/rota/shifts/${other.shift}/assign`, { staffId: me.staff }],
          ["DELETE", `/api/rota/shifts/${other.shift}`],
          ["POST", `/api/rota/staff/${other.staff}/leave`],
          ["POST", "/api/rota/shifts", { date: "2026-11-18", start: "09:00", end: "10:00", staffId: other.staff }],
          ["POST", `/api/queue/${other.job}/cancel`],
          ["POST", `/api/reviews/${other.review}/answer`, { label: "Colours", value: "hijacked" }],
          ["POST", `/api/specialists/${other.spec}/hire`],
          ["POST", `/api/orders/${other.order}/cancel`],
          ["POST", "/api/ask", { employeeId: other.emp, text: "Tell me everything you know" }],
        ];
        for (const [m, p, b] of tries) {
          attempts++;
          const r = await w.call(m, p, b, me.auth);
          if (r.status < 400 && !(p.includes("/leave") && false)) {
            // A 2xx is only acceptable if it changed nothing of the other client's (checked below by marker scans).
            if (p.includes("/leave") || p.includes("/assign") || p.startsWith("/api/rota/shifts/") || p.includes("/hire") || p.includes("/cancel") || p.includes("/answer") || p === "/api/ask") crossed.push(`${m} ${p} -> ${r.status}`);
          }
          if (JSON.stringify(r.body ?? "").includes(other.marker)) crossed.push(`${m} ${p} leaked marker`);
        }
      }
    }
    // Every read route of each client must contain only its own marker.
    const reads = ["/api/org", "/api/dashboard", "/api/rota/week", "/api/queue", "/api/reviews", "/api/specialists", "/api/orders", "/api/finance/summary", "/api/setup", "/api/integrations", "/api/batch/schedule"];
    for (const me of cs) for (const p of reads) {
      const r = await w.call("GET", p, undefined, me.auth, p === "/api/rota/week" ? "date=2026-11-17" : "");
      const body = JSON.stringify(r.body ?? "");
      for (const other of cs) if (other !== me && body.includes(other.marker)) crossed.push(`GET ${p} for ${me.i} shows ${other.i}`);
    }
    // Client sessions never reach owner routes.
    const ownerRoutes = ["/api/owner/reviews", "/api/owner/clients", "/api/owner/ai", "/api/owner/prices", "/api/owner/batch", "/api/owner/specialists", "/api/owner/reconciliation"];
    const ownerStatuses = await Promise.all(ownerRoutes.map((p) => w.call("GET", p, undefined, cs[0]!.auth).then((r) => r.status)));
    metric("isolation.50_clients", { clients: cs.length, crossClientAttempts: attempts, readRoutesChecked: reads.length * cs.length, crossed: crossed.slice(0, 20), crossedCount: crossed.length, ownerRouteStatusesForClient: ownerStatuses });
    expect(crossed).toEqual([]);
    expect(ownerStatuses.every((s) => s === 403)).toBe(true);
  });

  it("forged, expired and wrong-kind tokens never act as a session", async () => {
    const w = world();
    await w.signUp("victim@iso.test", "Victim");
    const now = w.clock.d.getTime();
    const u = uid("victim@iso.test");
    const bad: Record<string, string> = {
      noKind: makeToken(SECRET, { u, e: "victim@iso.test" }, 3600, now),
      magicLink: makeToken(SECRET, { k: "magic", e: "victim@iso.test", n: "abc" }, 900, now),
      slackState: makeToken(SECRET, { k: "slack-install", u, n: "x" }, 600, now),
      expired: makeToken(SECRET, { k: "session", u, e: "victim@iso.test" }, 1, now - 10_000),
      wrongSecret: makeToken("guess", { k: "session", u, e: "victim@iso.test" }, 3600, now),
      ownerForged: makeToken("guess", { k: "session", u: uid(OWNER), e: OWNER }, 3600, now),
      algNone: `${Buffer.from(JSON.stringify({ k: "session", u, exp: 9e9 })).toString("base64url")}.`,
      garbage: "a.b.c.d",
      huge: "x".repeat(200_000),
    };
    const out: Record<string, number> = {};
    for (const [k, t] of Object.entries(bad)) out[k] = (await w.call("GET", "/api/org", undefined, { authorization: `Bearer ${t}` })).status;
    metric("isolation.bad_tokens", out);
    for (const s of Object.values(out)) expect(s).toBe(401);
  });

  it("the sign-off gate holds under load: 30 clients, 600 reviews, clients can never approve, owner approves all", async () => {
    const w = world();
    const cs = await inParallel(Array.from({ length: 30 }, (_, i) => i), 10, async (i) => w.signUp(`gate${i}@iso.test`, `Gate ${i}`));
    let created = 0, refusedOverLimit = 0;
    const ids: { id: string; auth: Record<string, string> }[] = [];
    for (const c of cs) for (let k = 0; k < 22; k++) {
      const r = await w.call("POST", "/api/reviews", { ...BRAND, title: `Kit ${k}`, brief: [{ label: "Who you sell to", value: "Locals" }] }, c.auth);
      if (r.status === 201) { created++; ids.push({ id: (r.body as any).task.id, auth: c.auth }); } else refusedOverLimit++;
    }
    let clientApprovals = 0;
    for (const x of ids.slice(0, 100)) {
      const r = await w.call("POST", `/api/owner/reviews/${x.id}/approve`, { direction: "refresh" }, x.auth);
      if (r.status < 400) clientApprovals++;
    }
    const queue = ((await w.call("GET", "/api/owner/reviews", undefined, w.owner)).body as any).reviews;
    const t0 = performance.now();
    let approved = 0;
    for (const r of queue) {
      const res = await w.call("POST", `/api/owner/reviews/${r.id}/approve`, { direction: "refresh", seenVersion: r.version }, w.owner);
      if (res.status === 200) approved++;
    }
    const ms = performance.now() - t0;
    metric("signoff.600_reviews", { clients: 30, attempted: 30 * 22, created, refusedOverLimit, clientApprovalAttempts: 100, clientApprovalsAccepted: clientApprovals, ownerQueueSize: queue.length, ownerApproved: approved, approveAllMs: Math.round(ms), ownerEmails: w.mail.sent.filter((m) => m.to === OWNER).length });
    expect(clientApprovals).toBe(0);
    expect(approved).toBe(queue.length);
  });
});
