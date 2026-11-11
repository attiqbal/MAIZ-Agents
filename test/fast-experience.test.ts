import { describe, expect, it } from "vitest";
import { classifyWork } from "../src/modules/batch/classify.js";
import { LatencyLog } from "../src/modules/batch/latency.js";
import { matchInstant } from "../src/modules/workforce/instant.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";

const LIVE = ["admin-manager"];
const mode = (brief: string, o: { when?: "now" | "tonight"; liveByDefault?: boolean; urgent?: boolean } = {}) =>
  classifyWork({ brief, templateKey: "marketing-manager", liveTemplates: LIVE, ...o }).mode;

describe("choosing now or tonight", () => {
  it("answers at once when the client picks Now, even for a long piece of work", () => expect(mode("Plan next month's posts", { when: "now" })).toBe("urgent"));
  it("waits for the batch when the client picks Tonight", () => expect(mode("Plan next month's posts", { when: "tonight" })).toBe("batch"));
  it("still answers a quick lookup at once when Tonight is picked, since it is cheap", () => expect(mode("What's the status of my tasks?", { when: "tonight" })).toBe("lookup"));
  it("answers ordinary work at once for new clients who made no choice", () => expect(mode("Plan next month's posts", { liveByDefault: true })).toBe("urgent"));
  it("lets a new client who picks Tonight still batch", () => expect(mode("Plan next month's posts", { liveByDefault: true, when: "tonight" })).toBe("batch"));
  it("batches ordinary work for established clients", () => expect(mode("Plan next month's posts")).toBe("batch"));
});

describe("instant questions", () => {
  it.each([
    ["Who's working today?", "who_in_today"],
    ["who is in today", "who_in_today"],
    ["How many hours are scheduled this week?", "hours_this_week"],
    ["How much cash do we have?", "cash_runway"],
    ["What's our runway?", "cash_runway"],
    ["How much energy is left?", "energy_left"],
    ["What's in the queue?", "next_batch"],
  ])("answers %s from the records", (q, topic) => expect(matchInstant(q)).toBe(topic));
  it.each([
    "Who is working tomorrow?",
    "Who worked last Friday?",
    "Draft a rota for who is in today",
    "Forecast how much cash we will have in March",
    "Who is in today? ".repeat(20),
    "hello",
  ])("leaves %s to the normal route", (q) => expect(matchInstant(q)).toBeUndefined());
});

describe("latency log", () => {
  it("reports median, 95th percentile and whether the target is missed", () => {
    const log = new LatencyLog();
    for (let i = 1; i <= 100; i++) log.record("live", i * 1000);
    const live = log.summary().stats.find((s) => s.kind === "live")!;
    expect(live).toMatchObject({ count: 100, p50Ms: 50_000, p95Ms: 95_000, overTarget: true });
    expect(log.summary().stats.find((s) => s.kind === "instant")).toMatchObject({ count: 0, p95Ms: null, overTarget: false });
  });
  it("shows how much model work skipped the batch, and ignores bad numbers", () => {
    const log = new LatencyLog();
    expect(log.summary().liveShare).toBeNull();
    log.record("live", 1000); log.record("lookup", 500); log.record("batch_wait", 3_600_000); log.record("live", Number.NaN); log.record("live", -5);
    expect(log.summary().liveShare).toBe(0.67);
  });
});

describe("fast experience end to end", () => {
  const OWNER = "atif@maiz.test";
  function setup() {
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const calls = { runpod: 0, claude: 0 };
    const http = (async (url: string) => {
      if (String(url).includes("runpod")) {
        calls.runpod++;
        return new Response(JSON.stringify({ choices: [{ message: { content: "Open model draft, specific and complete for this business." }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 300 } }));
      }
      calls.claude++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Claude answer." }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" }));
    }) as unknown as typeof fetch;
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, http, anthropicApiKey: "ak", runpod: { apiKey: "rk", endpointId: "abc123def456" } });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` };
    const client = async () => {
      const su = await call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
      const auth = { authorization: `Bearer ${(su.body as any).token}` };
      const org = (await call("GET", "/api/org", undefined, auth)).body as any;
      return { auth, org, marketing: org.team.find((e: any) => e.templateKey === "marketing-manager").id as string, hr: org.team.find((e: any) => e.templateKey === "hr-manager").id as string };
    };
    return { platform, call, owner, client, calls, clock };
  }

  it("answers a trial client's ordinary work at once, unless they pick Tonight", async () => {
    const s = setup();
    const c = await s.client();
    const now = (await s.call("POST", "/api/ask", { employeeId: c.marketing, text: "Plan next month's posts" }, c.auth)).body as any;
    expect(now.status).toBe("ready_for_review");
    const later = (await s.call("POST", "/api/ask", { employeeId: c.marketing, text: "Plan next month's posts", when: "tonight" }, c.auth)).body as any;
    expect(later.status).toBe("queued");
  });

  it("goes back to batching once the owner switches the trial default off", async () => {
    const s = setup();
    const c = await s.client();
    s.platform.ai.update(userIdFor(OWNER), { batch: { liveDuringTrial: false, liveFirstTasks: 0 } });
    const r = (await s.call("POST", "/api/ask", { employeeId: c.marketing, text: "Plan next month's posts" }, c.auth)).body as any;
    expect(r.status).toBe("queued");
  });

  it("answers who is in today from the rota with no AI call and no energy", async () => {
    const s = setup();
    const c = await s.client();
    const mo = (await s.call("POST", "/api/rota/staff", { name: "Mo", role: "Barista" }, c.auth)).body as any;
    await s.call("POST", "/api/rota/shifts", { date: "2026-11-10", start: "08:00", end: "16:00", staffId: mo.added.id }, c.auth);
    const before = s.calls.runpod + s.calls.claude;
    const r = (await s.call("POST", "/api/ask", { employeeId: c.hr, text: "Who's working today?" }, c.auth)).body as any;
    expect(r.status).toBe("ready_for_review");
    expect(r.answer).toContain("08:00 to 16:00: Mo");
    expect(r.answer).toContain("no AI was used");
    expect(r.energyUsed).toBe(0);
    expect(s.calls.runpod + s.calls.claude).toBe(before);
  });

  it("falls back to the normal route when the records cannot answer", async () => {
    const s = setup();
    const c = await s.client();
    const r = (await s.call("POST", "/api/ask", { employeeId: c.hr, text: "Who's working today?" }, c.auth)).body as any; // no staff yet
    expect(r.answer).not.toContain("no AI was used");
  });

  it("shows the platform owner how long clients wait, and only the platform owner", async () => {
    const s = setup();
    const c = await s.client();
    await s.call("POST", "/api/ask", { employeeId: c.marketing, text: "Plan next month's posts" }, c.auth);
    const ov = (await s.call("GET", "/api/owner/batch", undefined, s.owner)).body as any;
    expect(ov.latency.stats.find((x: any) => x.kind === "live").count).toBe(1);
    expect((await s.call("GET", "/api/owner/batch", undefined, c.auth)).status).toBe(403);
    expect(((await s.call("GET", "/api/queue", undefined, c.auth)).body as any).latency).toBeUndefined();
  });

  it("warms RunPod once for a burst of calls and never for someone not signed in", async () => {
    const s = setup();
    const c = await s.client();
    expect((await s.call("POST", "/api/warm", {})).status).toBe(401);
    const first = await s.call("POST", "/api/warm", {}, c.auth);
    expect(first.status).toBe(202);
    expect((first.body as any).status).toBe("started");
    expect(((await s.call("POST", "/api/warm", {}, c.auth)).body as any).status).toBe("recent");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.calls.runpod).toBe(1);
  });

  it("skips warming when RunPod is not set up", async () => {
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, appUrl: "https://app.test" });
    expect(platform.warm()).toBe("skipped");
  });
});
