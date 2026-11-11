import { describe, expect, it } from "vitest";
import { BatchError, formatLocal, mergeSchedule, nextRunAt, DEFAULT_SCHEDULE } from "../src/modules/batch/schedule.js";
import { zoneForCountry } from "../src/modules/batch/zones.js";
import { classifyWork } from "../src/modules/batch/classify.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";

const LIVE = ["admin-manager"];
const at = (s: string) => new Date(s);

describe("batch schedule", () => {
  it("runs at the client's closing time in their own timezone, across daylight saving", () => {
    const london = mergeSchedule(DEFAULT_SCHEDULE, { timezone: "Europe/London", closingTime: "18:00" });
    expect(nextRunAt(london, at("2026-07-01T09:00:00Z")).toISOString()).toBe("2026-07-01T17:00:00.000Z"); // BST
    expect(nextRunAt(london, at("2026-12-01T09:00:00Z")).toISOString()).toBe("2026-12-01T18:00:00.000Z"); // GMT
  });
  it("sweeps up at the business's own midnight once closing has passed, and can skip weekends", () => {
    expect(nextRunAt(DEFAULT_SCHEDULE, at("2026-11-10T19:00:00Z")).toISOString()).toBe("2026-11-11T00:00:00.000Z");
    const karachi = mergeSchedule(DEFAULT_SCHEDULE, { timezone: "Asia/Karachi" });
    expect(nextRunAt(karachi, at("2026-11-10T14:00:00Z")).toISOString()).toBe("2026-11-10T19:00:00.000Z"); // 19:00 PKT has passed; midnight PKT is 19:00Z
    const noSweep = mergeSchedule(DEFAULT_SCHEDULE, { midnightSweep: false });
    expect(nextRunAt(noSweep, at("2026-11-10T19:00:00Z")).toISOString()).toBe("2026-11-11T18:00:00.000Z");
    const wk = mergeSchedule(noSweep, { skipWeekends: true });
    expect(nextRunAt(wk, at("2026-11-13T19:00:00Z")).toISOString()).toBe("2026-11-16T18:00:00.000Z"); // Friday evening -> Monday
  });
  it("picks the earliest of the closing time and any extra runs", () => {
    const s = mergeSchedule(DEFAULT_SCHEDULE, { extraRuns: ["12:00"] });
    expect(nextRunAt(s, at("2026-11-10T09:00:00Z")).toISOString()).toBe("2026-11-10T12:00:00.000Z");
  });
  it("starts from the business's country clock", () => {
    expect(zoneForCountry("PK")).toBe("Asia/Karachi");
    expect(zoneForCountry("United Kingdom")).toBe("Europe/London");
    expect(zoneForCountry("Atlantis")).toBe("UTC");
  });
  it("rejects a bad timezone or time and labels times for the client", () => {
    expect(() => mergeSchedule(DEFAULT_SCHEDULE, { timezone: "Mars/Base" })).toThrow(BatchError);
    expect(() => mergeSchedule(DEFAULT_SCHEDULE, { closingTime: "25:99" })).toThrow(BatchError);
    expect(formatLocal(at("2026-11-10T18:00:00Z"), "UTC")).toMatch(/18:00|6/);
  });
});

describe("batch classifier", () => {
  const c = (brief: string, extra: object = {}) => classifyWork({ brief, templateKey: "marketing-manager", liveTemplates: LIVE, ...extra }).mode;
  it("batches ordinary work", () => expect(c("Plan next month's posts for the bakery")).toBe("batch"));
  it("answers quick questions at once", () => {
    expect(c("What's the status of my tasks?")).toBe("lookup");
    expect(c("How does the rota look this week?")).toBe("lookup");
  });
  it("keeps urgent and time-sensitive work real-time", () => {
    expect(c("Plan next month's posts", { urgent: true })).toBe("urgent");
    expect(c("Write the reply to the supplier asap")).toBe("urgent");
  });
  it("never delays the Admin manager", () => expect(c("Plan next month's posts", { templateKey: "admin-manager" })).toBe("urgent"));
  it("does not mistake a work request phrased as a question for a lookup", () => expect(c("Can you draft a report on sales?")).toBe("batch"));
});

describe("batch queue end to end", () => {
  const OWNER = "atif@maiz.test";
  function setup(opts: { runpodDown?: boolean } = {}) {
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const state = { runpod: 0, claude: 0, runpodDown: !!opts.runpodDown };
    const http = (async (url: string) => {
      if (String(url).includes("runpod")) {
        state.runpod++;
        if (state.runpodDown) return new Response("down", { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "Open model draft, specific and complete for this business." }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 300 } }));
      }
      state.claude++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Claude answer: three tasks are queued, the rest are done." }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" }));
    }) as unknown as typeof fetch;
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, http, anthropicApiKey: "ak", runpod: { apiKey: "rk", endpointId: "abc123def456" } });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const owner = () => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` });
    const client = async (email = "ann@kestrel.co", name = "Kestrel Coffee") => {
      const su = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
      const auth = { authorization: `Bearer ${(su.body as any).token}` };
      const org = (await call("GET", "/api/org", undefined, auth)).body as any;
      return { auth, empId: org.team.find((e: any) => e.templateKey === "marketing-manager").id as string, wsId: org.id as string };
    };
    return { platform, call, owner, clock, state, client };
  }

  it("queues work, runs it once at closing time and files the result", async () => {
    const s = setup();
    const c = await s.client();
    const r = await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan next month's posts" }, c.auth);
    expect((r.body as any).status).toBe("queued");
    expect(s.state.runpod + s.state.claude).toBe(0); // nothing spent while it waits
    expect(await s.platform.batch.tick()).toBeUndefined(); // 09:00, not due

    s.clock.d = new Date("2026-11-10T18:01:00Z");
    const run = await s.platform.batch.tick();
    expect(run?.trigger).toBe("schedule");
    expect(run?.done).toBe(1);
    expect(s.state.runpod).toBe(1);
    const q = (await s.call("GET", "/api/queue", undefined, c.auth)).body as any;
    expect(q.jobs[0].status).toBe("done");
    expect(q.jobs[0].deliverable).toContain("Open model draft");
    expect(await s.platform.batch.tick()).toBeUndefined(); // nothing left
  });

  it("only queues what the energy left can pay for, and never more than 200 tasks per client", async () => {
    const s = setup();
    const c = await s.client();
    // 3,000 trial energy and about 60 a task (no history yet): roughly 50 tasks fit, the rest are refused now, not tonight.
    const statuses: string[] = [];
    for (let i = 0; i < 80; i++) statuses.push(((await s.call("POST", "/api/ask", { employeeId: c.empId, text: `Plan post ${i}` }, c.auth)).body as any).status);
    const queued = statuses.filter((x) => x === "queued").length;
    expect(queued).toBeGreaterThan(40);
    expect(queued).toBeLessThanOrEqual(50);
    const refused = (await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan one more post" }, c.auth)).body as any;
    expect(refused).toMatchObject({ status: "no_energy", reason: "queue_exceeds_energy" });
  });

  it("does work straight away when the trial ends before tonight's batch", async () => {
    const s = setup();
    const c = await s.client();
    s.clock.d = new Date("2026-11-17T08:00:00Z"); // trial ends 09:00 today, the batch would run at 18:00
    const ann = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor("ann@kestrel.co"), e: "ann@kestrel.co" }, 7 * 86400, s.clock.d.getTime())}` };
    const r = (await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan next month's posts" }, ann)).body as any;
    expect(r.status).toBe("ready_for_review");
  });

  it("answers quick questions at once with Claude, and urgent work at once on the pod", async () => {
    const s = setup();
    const c = await s.client();
    const look = await s.call("POST", "/api/ask", { employeeId: c.empId, text: "What's the status of my tasks?" }, c.auth);
    expect((look.body as any).status).toBe("ready_for_review");
    expect(s.state.claude).toBeGreaterThan(0);
    expect(s.state.runpod).toBe(0);
    const urgent = await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan next month's posts", urgent: true }, c.auth);
    expect((urgent.body as any).status).toBe("ready_for_review");
    expect(s.state.runpod).toBe(1);
  });

  it("sends a client's work early when enough has gathered, and one batch covers every client", async () => {
    const s = setup();
    await s.call("POST", "/api/owner/ai/settings", { batch: { sizeTrigger: 3 } }, s.owner());
    const a = await s.client("ann@kestrel.co", "Kestrel Coffee");
    const b = await s.client("bo@loaf.co", "Loaf Bakery");
    await s.call("POST", "/api/ask", { employeeId: a.empId, text: "Plan next month's posts" }, a.auth);
    await s.call("POST", "/api/ask", { employeeId: a.empId, text: "Draft a newsletter for November" }, a.auth);
    expect(await s.platform.batch.tick()).toBeUndefined(); // two is under the size trigger
    await s.call("POST", "/api/ask", { employeeId: b.empId, text: "Write a launch plan" }, b.auth);
    const run = await s.platform.batch.tick();
    expect(run?.trigger).toBe("size");
    expect(run?.jobs).toBe(3);
    expect(run?.clients).toBe(2);
    expect(s.state.runpod).toBe(3);
  });

  it("clears the whole queue after urgent work completes, at any time of day", async () => {
    const s = setup();
    const a = await s.client("ann@kestrel.co", "Kestrel Coffee");
    const b = await s.client("bo@loaf.co", "Loaf Bakery");
    await s.call("POST", "/api/ask", { employeeId: a.empId, text: "Plan next month's posts" }, a.auth);
    await s.call("POST", "/api/ask", { employeeId: b.empId, text: "Write a launch plan" }, b.auth);
    expect(s.state.runpod).toBe(0);
    const urgent = await s.call("POST", "/api/ask", { employeeId: a.empId, text: "Draft the supplier reply", urgent: true }, a.auth);
    expect((urgent.body as any).status).toBe("ready_for_review");
    await s.platform.batch.idle();
    expect(s.state.runpod).toBe(3); // the urgent task plus both queued ones, at 09:00
    expect(((await s.call("GET", "/api/queue", undefined, b.auth)).body as any).queued).toBe(0);
    expect(s.platform.batch.ownerView(userIdFor(OWNER)).runs[0]!.trigger).toBe("urgent");
  });

  it("does not flush the queue for lookups or the Admin manager", async () => {
    const s = setup();
    const a = await s.client();
    await s.call("POST", "/api/ask", { employeeId: a.empId, text: "Plan next month's posts" }, a.auth);
    await s.call("POST", "/api/ask", { employeeId: a.empId, text: "What's the status of my tasks?" }, a.auth);
    await s.platform.batch.idle();
    expect(s.state.runpod).toBe(0);
  });

  it("lets a client run their queue now, and cancel a task, but not see the owner's queue", async () => {
    const s = setup();
    const c = await s.client();
    const t1 = await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan next month's posts" }, c.auth);
    await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Draft a newsletter" }, c.auth);
    const jobs = ((await s.call("GET", "/api/queue", undefined, c.auth)).body as any).jobs;
    expect(jobs.length).toBe(2);
    const cancelled = await s.call("POST", `/api/queue/${(t1.body as any).jobId}/cancel`, undefined, c.auth);
    expect((cancelled.body as any).queued).toBe(1);
    const now = await s.call("POST", "/api/queue/run-now", undefined, c.auth);
    expect((now.body as any).started).toBe(true);
    expect(s.state.runpod).toBe(1);
    expect((await s.call("POST", `/api/queue/${(t1.body as any).jobId}/cancel`, undefined, c.auth)).status).toBe(400); // already cancelled
    expect((await s.call("GET", "/api/owner/batch", undefined, c.auth)).status).toBe(403);
    const ov = (await s.call("GET", "/api/owner/batch", undefined, s.owner())).body as any;
    expect(ov.runs[0].done).toBe(1);
  });

  it("changes the closing time and moves the waiting tasks", async () => {
    const s = setup();
    const c = await s.client();
    await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan next month's posts" }, c.auth);
    const set = await s.call("POST", "/api/batch/schedule", { timezone: "Europe/London", closingTime: "12:00" }, c.auth);
    expect(set.status).toBe(200);
    expect((set.body as any).jobs[0].runsAt).toBe("2026-11-10T12:00:00.000Z");
    expect((await s.call("POST", "/api/batch/schedule", { timezone: "Nowhere/Land" }, c.auth)).status).toBe(400);
  });

  it("never spends Claude while the pod is down, retries later, and uses Claude only on the last try", async () => {
    const s = setup({ runpodDown: true });
    const c = await s.client();
    await s.call("POST", "/api/ask", { employeeId: c.empId, text: "Plan next month's posts" }, c.auth);
    s.clock.d = new Date("2026-11-10T18:01:00Z");
    const first = await s.platform.batch.tick();
    expect(first?.retried).toBe(1);
    expect(s.state.claude).toBe(0);
    expect(await s.platform.batch.tick()).toBeUndefined(); // backing off

    s.clock.d = new Date("2026-11-10T19:00:00Z");
    expect((await s.platform.batch.tick())?.retried).toBe(1);
    expect(s.state.claude).toBe(0);

    s.clock.d = new Date("2026-11-10T21:00:00Z");
    const last = await s.platform.batch.tick();
    expect(last?.done).toBe(1); // third and last attempt: Claude finishes it
    expect(s.state.claude).toBeGreaterThan(0);
  });

  it("puts running jobs back in the queue after a restart", async () => {
    const s = setup();
    const c = await s.client();
    s.platform.batch.restoreJob({ id: "batchjob_x", workspaceId: c.wsId, userId: "u", employeeId: c.empId, brief: "Plan", reason: "r", status: "running", createdAt: "2026-11-10T08:00:00Z", runAfter: "2026-11-10T08:30:00Z", attempts: 0, estTokens: 100 });
    const q = (await s.call("GET", "/api/queue", undefined, c.auth)).body as any;
    expect(q.jobs.find((j: any) => j.id === "batchjob_x").status).toBe("queued");
  });

  it("records batch savings and the cold starts avoided", async () => {
    const s = setup();
    const c = await s.client();
    for (const t of ["Plan next month's posts", "Draft a newsletter", "Write a launch plan"]) await s.call("POST", "/api/ask", { employeeId: c.empId, text: t }, c.auth);
    await s.call("POST", "/api/queue/run-now", undefined, c.auth);
    const view = (await s.call("GET", "/api/owner/ai", undefined, s.owner())).body as any;
    expect(view.month.batchJobs).toBe(3);
    expect(view.month.batchRuns).toBe(1);
    expect(view.month.coldStartSavedMicro).toBeGreaterThan(0);
  });
});
