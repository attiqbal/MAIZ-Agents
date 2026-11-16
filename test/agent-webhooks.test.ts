import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GIVE_UP_AFTER_MS, RETRY_AFTER_MS, SIGNATURE_HEADER, WEBHOOK_TIMEOUT_MS, principalOf, signWebhook, verifyWebhookSignature } from "../src/modules/agents/index.js";
import { checkWebhookUrl } from "../src/modules/agents/webhooks.js";
import { PRIVATE_IP, PUBLIC_IP, desk, dns, recordingSink, useFakeDns } from "./agents-desk.js";

const HOOK = "https://hooks.example.com/maiz";
const MINUTE_MS = 60_000;

beforeAll(() => useFakeDns());
beforeEach(() => { dns.lookup = async (host) => (host.includes("inside") ? [PRIVATE_IP] : [PUBLIC_IP]); });

describe("the webhook signature", () => {
  it("is t=<seconds>,v1=<HMAC-SHA256 of 't.body'> and a receiver can check it with the secret", () => {
    const body = JSON.stringify({ type: "job.done" });
    const header = signWebhook("whsec_test", 1_800_000_000, body);

    expect(header).toBe(`t=1800000000,v1=${createHmac("sha256", "whsec_test").update(`1800000000.${body}`).digest("hex")}`);
    expect(verifyWebhookSignature("whsec_test", header, body, 1_800_000_010)).toBe(true);
  });

  it("fails for a changed body, the wrong secret, an old timestamp or a missing header", () => {
    const body = '{"type":"job.done"}';
    const header = signWebhook("whsec_test", 1_800_000_000, body);

    expect(verifyWebhookSignature("whsec_test", header, '{"type":"job.done","extra":1}', 1_800_000_000)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", header, body, 1_800_000_000)).toBe(false);
    expect(verifyWebhookSignature("whsec_test", header, body, 1_800_000_000 + 301)).toBe(false);
    expect(verifyWebhookSignature("whsec_test", header.replace("t=1800000000", "t=1800000001"), body, 1_800_000_000)).toBe(false);
    expect(verifyWebhookSignature("whsec_test", undefined, body, 1_800_000_000)).toBe(false);
    expect(verifyWebhookSignature("whsec_test", "v1=abc", body, 1_800_000_000)).toBe(false);
  });
});

describe("where a webhook may be sent", () => {
  it("accepts only an https address with a normal public name, no login in it and the usual port", () => {
    expect(checkWebhookUrl("https://hooks.zapier.com/hooks/catch/123/abc").hostname).toBe("hooks.zapier.com");
    for (const bad of ["http://hooks.example.com/x", "https://user:pw@hooks.example.com/x", "https://hooks.example.com:8443/x", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://db.internal/x", "https://[::1]/x", "ftp://hooks.example.com/x", "not a url", "", 7, null, `https://hooks.example.com/${"x".repeat(600)}`]) {
      expect(() => checkWebhookUrl(bad)).toThrow(/normal https address/);
    }
  });

  it("refuses an address whose name points inside a network, when it is saved", async () => {
    const d = await desk();

    await expect(d.connect({ webhookUrl: "https://inside.example.com/hook" })).rejects.toMatchObject({ reason: "webhook_url_unreachable" });
    const c = await d.connect();
    await expect(d.agents.update(d.owner, d.ws, c.id, { webhookUrl: "https://inside.example.com/hook" })).rejects.toMatchObject({ reason: "webhook_url_unreachable" });
    await expect(d.agents.update(d.owner, d.ws, c.id, { webhookUrl: "http://hooks.example.com/hook" })).rejects.toMatchObject({ reason: "webhook_url_invalid" });

    expect(d.agents.overview(d.owner, d.ws).connections.every((x) => x.webhookUrl === null)).toBe(true);
  });

  it("checks the address again before every send, so a name that moved inside later is never called", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });
    // The name was public when the owner saved it. Now it answers with a private address.
    dns.lookup = async () => [PRIVATE_IP];

    await d.send(c.key);
    const test = await d.agents.testWebhook(d.owner, d.ws, c.id);

    expect(d.sent).toHaveLength(0);
    expect(test).toEqual({ delivered: false });
    expect(d.agents.webhooks.pending()).toMatchObject([{ event: "job.done", attempts: 1, status: "pending" }]);
  });
});

describe("telling the client's tool", () => {
  it("posts a signed job.done with the answer, never follows a redirect and gives up waiting after 8 seconds", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });

    const job = await d.send(c.key, { reference: "TICKET-1" });

    expect(d.sent).toHaveLength(1);
    const hook = d.sent[0]!;
    expect(hook).toMatchObject({ url: HOOK, redirect: "error", hasTimeout: true });
    expect(WEBHOOK_TIMEOUT_MS).toBe(8_000);
    expect(hook.headers["content-type"]).toBe("application/json");
    const nowSeconds = Math.floor(d.clock.d.getTime() / 1000);
    expect(hook.headers[SIGNATURE_HEADER]).toBe(signWebhook(c.signingSecret, nowSeconds, hook.body));
    expect(verifyWebhookSignature(c.signingSecret, hook.headers[SIGNATURE_HEADER], hook.body, nowSeconds)).toBe(true);
    expect(JSON.parse(hook.body)).toEqual({
      id: expect.any(String), type: "job.done", created: d.clock.d.toISOString(), connection: { id: c.id, name: "Helpdesk bot" },
      job: { id: job.id, employee: "customer-service-reception", status: "done", reason: null, reference: "TICKET-1", result: "Dear customer, your order is on its way.", energyUsed: 40, createdAt: expect.any(String), startedAt: expect.any(String), finishedAt: expect.any(String) },
    });
    expect(d.agents.webhooks.pending()).toHaveLength(0);
  });

  it("announces a job that waits for the owner, one that is refused and one that failed", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK, needsApproval: true });
    const waiting = await d.send(c.key);
    await d.agents.deliverWebhooks();
    d.agents.refuse(d.owner, d.ws, waiting.id);
    await d.agents.deliverWebhooks();
    await d.agents.update(d.owner, d.ws, c.id, { needsApproval: false });
    d.work.fail = true;
    await d.send(c.key);

    const events = d.sent.map((h) => JSON.parse(h.body)).map((b) => [b.type, b.job.status, b.job.reason]);

    expect(events).toEqual([["job.waiting_for_owner", "waiting_for_owner", "needs_approval"], ["job.refused", "refused", "owner_refused"], ["job.failed", "failed", "failed"]]);
  });

  it("queues nothing for a connection without a webhook address", async () => {
    const d = await desk();
    const c = await d.connect();
    await d.send(c.key);
    expect(d.sent).toHaveLength(0);
    expect(d.agents.webhooks.pending()).toHaveLength(0);
    await expect(d.agents.testWebhook(d.owner, d.ws, c.id)).rejects.toMatchObject({ reason: "no_webhook" });
  });

  it("sends a signed test message when the owner asks, and says whether it arrived", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });

    const ok = await d.agents.testWebhook(d.owner, d.ws, c.id);
    d.web.status = 500;
    const failed = await d.agents.testWebhook(d.owner, d.ws, c.id);

    expect(ok).toEqual({ delivered: true, status: 200 });
    expect(failed).toEqual({ delivered: false, status: 500 });
    expect(JSON.parse(d.sent[0]!.body)).toMatchObject({ type: "test", connection: { id: c.id, name: "Helpdesk bot" } });
    expect(verifyWebhookSignature(c.signingSecret, d.sent[0]!.headers[SIGNATURE_HEADER], d.sent[0]!.body, Math.floor(d.clock.d.getTime() / 1000))).toBe(true);
    d.p.identity.addMember(d.owner, d.ws, "u_ben", "member");
    await expect(d.agents.testWebhook("u_ben", d.ws, c.id)).rejects.toThrow(/lacks workspace.manage/);
  });

  it("signs with a new secret after the owner replaces it, and the old one stops matching", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });

    const next = d.agents.rotate(d.owner, d.ws, c.id, true);
    await d.send(next.key);

    const hook = d.sent[0]!;
    const nowSeconds = Math.floor(d.clock.d.getTime() / 1000);
    expect(next.signingSecret).toMatch(/^whsec_/);
    expect(next.signingSecret).not.toBe(c.signingSecret);
    expect(verifyWebhookSignature(next.signingSecret!, hook.headers[SIGNATURE_HEADER], hook.body, nowSeconds)).toBe(true);
    expect(verifyWebhookSignature(c.signingSecret, hook.headers[SIGNATURE_HEADER], hook.body, nowSeconds)).toBe(false);
  });
});

describe("when the client's address does not answer", () => {
  it("tries again after 1 minute, 5 minutes, 30 minutes, 2 hours and then every 6 hours", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });
    d.web.status = 503;
    const start = d.clock.d.getTime();
    await d.send(c.key);
    expect(d.sent).toHaveLength(1);
    expect(RETRY_AFTER_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);

    const waits: number[] = [];
    for (const wait of RETRY_AFTER_MS) {
      // A tick just before it is due sends nothing.
      d.clock.d = new Date(d.clock.d.getTime() + wait - 1000);
      await d.agents.tick();
      const before = d.sent.length;
      d.clock.d = new Date(d.clock.d.getTime() + 1000);
      await d.agents.tick();
      waits.push(d.sent.length - before);
    }

    expect(waits).toEqual([1, 1, 1, 1, 1]);
    expect(d.sent).toHaveLength(6);
    expect(d.agents.webhooks.pending()[0]).toMatchObject({ attempts: 6, lastStatus: 503, nextAttemptAt: new Date(d.clock.d.getTime() + 6 * 3_600_000).toISOString() });
    expect(d.clock.d.getTime() - start).toBe(60_000 + 300_000 + 1_800_000 + 7_200_000 + 21_600_000);
  });

  it("delivers on a later try once the address is back, and then stops", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });
    d.web.down = true;
    const job = await d.send(c.key);
    expect(d.agents.webhooks.pending()).toMatchObject([{ attempts: 1 }]);

    d.web.down = false;
    d.clock.d = new Date(d.clock.d.getTime() + MINUTE_MS);
    await d.agents.tick();
    d.clock.d = new Date(d.clock.d.getTime() + 60 * MINUTE_MS);
    await d.agents.tick();

    expect(d.sent).toHaveLength(2);
    expect(JSON.parse(d.sent[1]!.body)).toMatchObject({ type: "job.done", job: { id: job.id, status: "done" } });
    expect(d.agents.webhooks.pending()).toHaveLength(0);
  });

  it("gives up after 24 hours, writes that to the audit log, and the job can still be polled", async () => {
    const store = recordingSink();
    const d = await desk({ sink: store.sink });
    const c = await d.connect({ webhookUrl: HOOK });
    d.web.status = 500;
    const job = await d.send(c.key);
    const start = d.clock.d.getTime();

    for (let i = 0; i < 40 && d.agents.webhooks.pending().length; i++) {
      d.clock.d = new Date(Date.parse(d.agents.webhooks.pending()[0]!.nextAttemptAt));
      await d.agents.tick();
    }

    expect(d.agents.webhooks.pending()).toHaveLength(0);
    expect(d.clock.d.getTime() - start).toBeLessThanOrEqual(GIVE_UP_AFTER_MS);
    expect(d.clock.d.getTime() - start).toBeGreaterThan(GIVE_UP_AFTER_MS - 6 * 3_600_000);
    const tries = d.sent.length;
    d.clock.d = new Date(d.clock.d.getTime() + 12 * 3_600_000);
    await d.agents.tick();
    expect(d.sent).toHaveLength(tries);
    expect(store.latest().find((r) => r.kind === "agent_delivery")!.data).toMatchObject({ status: "gave_up", attempts: tries, lastStatus: 500, jobId: job.id });
    expect(d.p.audit.list(d.ws).find((e) => e.action === "agent.callback_failed")).toMatchObject({ actor: principalOf(c.id), target: job.id, data: { connection: "Helpdesk bot", event: "job.done", attempts: tries } });
    expect(d.agents.job(c.key, job.id).status).toBe("done");
  });

  it("carries on with waiting deliveries after a restart", async () => {
    const store = recordingSink();
    const d = await desk({ sink: store.sink });
    const c = await d.connect({ webhookUrl: HOOK });
    d.web.status = 500;
    await d.send(c.key);

    const second = d.make();
    for (const r of store.latest()) second.restore(r.kind as "agent_delivery", r.data);
    for (const s of store.secrets) second.restoreSecret(s.key, s.secret);
    d.web.status = 200;
    d.clock.d = new Date(d.clock.d.getTime() + MINUTE_MS);
    await second.tick();

    expect(d.sent).toHaveLength(2);
    expect(verifyWebhookSignature(c.signingSecret, d.sent[1]!.headers[SIGNATURE_HEADER], d.sent[1]!.body, Math.floor(d.clock.d.getTime() / 1000))).toBe(true);
    expect(second.webhooks.pending()).toHaveLength(0);
  });

  it("drops what is waiting when the owner takes the webhook address away", async () => {
    const d = await desk();
    const c = await d.connect({ webhookUrl: HOOK });
    d.web.status = 500;
    await d.send(c.key);
    await d.agents.update(d.owner, d.ws, c.id, { webhookUrl: null });

    d.clock.d = new Date(d.clock.d.getTime() + MINUTE_MS);
    await d.agents.tick();

    expect(d.sent).toHaveLength(1);
    expect(d.agents.webhooks.pending()).toHaveLength(0);
  });
});

describe("the signing secret", () => {
  it("is shown once, kept out of every stored record and stored only through the encrypted secret store", async () => {
    const store = recordingSink();
    const d = await desk({ sink: store.sink });

    const c = await d.connect({ webhookUrl: HOOK });
    await d.send(c.key);

    expect(c.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(store.secrets).toEqual([{ key: `agent:whsec:${c.id}`, secret: c.signingSecret }]);
    expect(store.records.length).toBeGreaterThan(3);
    expect(JSON.stringify(store.records)).not.toContain(c.signingSecret);
    expect(JSON.stringify(store.records)).not.toContain("whsec_");
    expect(JSON.stringify(d.agents.overview(d.owner, d.ws))).not.toContain("whsec_");
    expect(JSON.stringify(d.p.audit.list(d.ws))).not.toContain("whsec_");
    // The delivery queue keeps ids and counts, not the message or the secret.
    expect(Object.keys(store.latest().find((r) => r.kind === "agent_delivery")!.data).sort()).toEqual(["attempts", "connectionId", "createdAt", "event", "id", "jobId", "lastStatus", "nextAttemptAt", "status", "workspaceId"]);
  });
});
