import { describe, expect, it } from "vitest";
import { MockPaymentProvider } from "../../src/modules/payments/index.js";
import { QueuedEmailSender, ResendEmailSender } from "../../src/server/email.js";
import { inParallel, metric, uid, world } from "./harness.js";

describe("payments with the fake provider", () => {
  it("300 checkouts paid by webhook; every webhook sent 3 times, two of them at the same instant: each order hires once", async () => {
    const provider = new MockPaymentProvider({ mode: "manual" });
    const w = world({ payments: provider });
    const item = ((await w.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    const cs = await inParallel(Array.from({ length: 100 }, (_, i) => i), 20, (i) => w.signUp(`pay${i}@pay.test`, `Pay ${i}`));
    const before = new Map(cs.map((c) => [c.workspaceId, w.platform.workforce.countIn(c.workspaceId)]));
    const orders: { id: string; ws: string }[] = [];
    for (const c of cs) for (let k = 0; k < 3; k++) {
      const r = await w.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, c.auth);
      expect(r.status).toBe(201);
      orders.push({ id: (r.body as any).order.id, ws: c.workspaceId });
    }
    const hookStatuses: Record<number, number> = {};
    await inParallel(orders, 50, async (o) => {
      const hook = provider.signedWebhook({ type: "payment.succeeded", orderId: o.id, providerRef: `ref_${o.id}` });
      const send = () => w.call("POST", "/api/payments/webhook", undefined, hook.headers, "", hook.rawBody).then((r) => { hookStatuses[r.status] = (hookStatuses[r.status] ?? 0) + 1; });
      await Promise.all([send(), send()]);
      await send();
    });
    // A late "failed" for an order already paid must not undo it.
    const late = provider.signedWebhook({ type: "payment.failed", orderId: orders[0]!.id, providerRef: "late" });
    await w.call("POST", "/api/payments/webhook", undefined, late.headers, "", late.rawBody);
    const hiredExtra = cs.map((c) => w.platform.workforce.countIn(c.workspaceId) - before.get(c.workspaceId)!);
    const firstOrder = ((await w.call("GET", "/api/orders", undefined, cs[0]!.auth)).body as any).orders.find((o: any) => o.id === orders[0]!.id);
    metric("payments.300_orders_replayed_webhooks", { orders: orders.length, webhooksSent: orders.length * 3, hookStatuses, employeesHiredPerClient: [...new Set(hiredExtra)], expectedPerClient: 3, firstOrderAfterLateFailure: firstOrder?.status });
    expect(new Set(hiredExtra)).toEqual(new Set([3]));
    expect(firstOrder?.status).toBe("paid");
  });

  it("a client cannot pile up unpaid orders: the 21st open checkout is refused", async () => {
    const provider = new MockPaymentProvider({ mode: "manual" });
    const w = world({ payments: provider });
    const c = await w.signUp("pile@pay.test", "Pile");
    const item = ((await w.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await w.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, c.auth)).status);
    metric("payments.pending_order_cap", { attempts: 25, created: statuses.filter((s) => s === 201).length, refused: statuses.filter((s) => s === 400).length });
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
  });
});

describe("sign-in links", () => {
  it("each link works once, expires after 15 minutes, and an address gets at most 5 a hour", async () => {
    const w = world();
    await w.signUp("link@sign.test", "Link Ltd");
    const start = () => w.call("POST", "/api/signin/start", { email: "link@sign.test" });
    const links: string[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) { const r = await start(); statuses.push(r.status); if ((r.body as any).devLink) links.push((r.body as any).devLink); }
    const first = await w.call("POST", "/api/signin/verify", { token: links[0] });
    const again = await w.call("POST", "/api/signin/verify", { token: links[0] });
    w.clock.d = new Date(w.clock.d.getTime() + 16 * 60_000);
    const late = await w.call("POST", "/api/signin/verify", { token: links[1] });
    metric("signin.links", { startStatuses: statuses, firstUse: first.status, reuse: again.status, after16min: late.status, emailsSent: w.mail.sent.filter((m) => m.to === "link@sign.test" && m.subject.includes("sign-in")).length });
    expect(first.status).toBe(200);
    expect(again.status).toBe(400);
    expect(late.status).toBe(400);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it("memory kept for used links and send counts after 100,000 sign-ins", async () => {
    const w = world();
    for (let i = 0; i < 100_000; i++) {
      const r = await w.call("POST", "/api/signin/start", { email: `m${i}@mem.test` });
      await w.call("POST", "/api/signin/verify", { token: (r.body as any).devLink });
      if (i % 20_000 === 0) w.clock.d = new Date(w.clock.d.getTime() + 2 * 3_600_000);
    }
    metric("signin.memory_100k", { signIns: 100_000, usedLinksKept: w.platform.usedLinks.size, sendCountsKept: w.platform.sends.size, note: "kept only while a link could still be used (15 minutes) or an address is inside its hourly limit" });
    expect(w.platform.usedLinks.size).toBeLessThan(100_000);
  });

  it("the email provider throttles (Resend allows about 2 requests a second; simulated 10x faster): how many sign-in emails are lost in a burst", async () => {
    let inWindow = 0, windowStart = Date.now(), delivered = 0, refused = 0;
    const resend = (async () => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
      if (++inWindow > 20) { refused++; return new Response("{}", { status: 429 }); }
      delivered++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    // Resend's real pace is 2 a second (550 ms apart); here 10x faster so the test takes seconds, same behaviour.
    const mailer = new QueuedEmailSender(new ResendEmailSender("re_test", "hi@maiz.test", resend), { minIntervalMs: 55, backoffMs: 100 });
    const w = world({ cfg: { email: mailer } });
    const t0 = performance.now();
    const statuses = await inParallel(Array.from({ length: 50 }, (_, i) => i), 50, async (i) => (await w.call("POST", "/api/signin/start", { email: `burst${i}@mail.test` })).status);
    const replyMs = performance.now() - t0;
    await mailer.idle();
    metric("signin.email_throttle_burst", { requests: 50, answeredOk: statuses.filter((s) => s === 200).length, allRepliesMs: Math.round(replyMs), emailsDelivered: delivered, providerRefusalsRetried: refused, lost: mailer.stats.failed + mailer.stats.dropped, lastEmailAfterSecondsAtRealPace: Math.round((50 * 550) / 1000), before: "48 of 50 lost with no error shown" });
    expect(delivered).toBe(50);
  });
});
