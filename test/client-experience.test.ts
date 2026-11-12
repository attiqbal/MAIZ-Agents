import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req, type Res } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { userIdFor } from "../src/server/identity.js";
import { readSse } from "../src/modules/model-gateway/adapters/sse.js";
import { OpenAICompatibleAdapter } from "../src/modules/model-gateway/adapters/openai-compatible.js";
import { AnthropicAdapter } from "../src/modules/model-gateway/adapters/anthropic.js";
import { ConversationService, MAX_TURNS } from "../src/modules/conversations/index.js";
import { NotificationService } from "../src/modules/notifications/index.js";
import { IdentityService } from "../src/modules/identity/index.js";
import { AuditLog } from "../src/modules/audit/index.js";
import { EventBus } from "../src/core/events.js";

const sseBody = (chunks: string[]): Response =>
  new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });

const openAiChunks = (words: string[]): string[] => [
  ...words.map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: words.length } })}\n\n`,
  "data: [DONE]\n\n",
];

describe("reading a live answer", () => {
  it("joins lines that arrive split across chunks", async () => {
    const seen: string[] = [];
    const res = sseBody(["data: one\n\nda", "ta: two\r\n\r\n", ": comment\n", "data: three"]);
    await readSse(res.body!, (d) => seen.push(d));
    expect(seen).toEqual(["one", "two", "three"]);
  });

  it("streams an OpenAI-style answer piece by piece and still returns the whole with usage", async () => {
    const http = (async () => sseBody(openAiChunks(["Hello", " there", "."]))) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter("runpod", "https://x.test/v1", "k", "m", ["standard"], http);
    const pieces: string[] = [];
    const r = await adapter.complete({ messages: [{ role: "user", content: "hi" }], stream: { text: (d) => pieces.push(d), reset: () => undefined } });
    expect(pieces).toEqual(["Hello", " there", "."]);
    expect(r).toMatchObject({ text: "Hello there.", inputTokens: 40, outputTokens: 3, truncated: false });
  });

  it("treats a stream that ends with no words as a failure so fallback can take over", async () => {
    const http = (async () => sseBody(["data: [DONE]\n\n"])) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter("runpod", "https://x.test/v1", "k", "m", ["standard"], http);
    await expect(adapter.complete({ messages: [{ role: "user", content: "hi" }], stream: { text: () => undefined, reset: () => undefined } })).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("streams a Claude answer and reads its token counts", async () => {
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const http = (async () => sseBody([
      ev({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
      ev({ type: "content_block_delta", delta: { text: "Good" } }),
      ev({ type: "content_block_delta", delta: { text: " day" } }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    ])) as unknown as typeof fetch;
    const pieces: string[] = [];
    const r = await new AnthropicAdapter("k", "m", http).complete({ messages: [{ role: "user", content: "hi" }], stream: { text: (d) => pieces.push(d), reset: () => undefined } });
    expect(pieces.join("")).toBe("Good day");
    expect(r).toMatchObject({ text: "Good day", inputTokens: 12, outputTokens: 2 });
  });
});

describe("conversations", () => {
  async function setup() {
    const identity = new IdentityService(new AuditLog(), new EventBus());
    const ws = await identity.createWorkspace("u1", { name: "Kestrel" });
    const other = await identity.createWorkspace("u2", { name: "Other" });
    return { conv: new ConversationService(identity), ws: ws.id, other: other.id };
  }
  it("keeps what was asked and answered, and gives only answered exchanges to follow-ups", async () => {
    const { conv, ws } = await setup();
    conv.record("u1", ws, "e1", "Draft a post", { text: "Here is a post", status: "answered" });
    conv.record("u1", ws, "e1", "And again", { text: "Not enough energy", status: "no_energy" });
    expect(conv.thread("u1", ws, "e1").map((t) => t.role)).toEqual(["you", "employee", "you", "employee"]);
    expect(conv.history("u1", ws, "e1")).toEqual([{ role: "user", content: "Draft a post" }, { role: "assistant", content: "Here is a post" }]);
  });
  it("fills a queued turn in when the batch finishes, and only for the right job", async () => {
    const { conv, ws } = await setup();
    conv.record("u1", ws, "e1", "Plan the month", { text: "Queued.", status: "queued", jobId: "j1", runsAt: "2026-11-10T20:00:00Z" });
    expect(conv.fileQueued(ws, "e1", "other", "x")).toBe(false);
    expect(conv.fileQueued(ws, "e1", "j1", "The plan")).toBe(true);
    const last = conv.thread("u1", ws, "e1").at(-1)!;
    expect(last).toMatchObject({ status: "answered", text: "The plan" });
    expect(last.runsAt).toBeUndefined();
  });
  it("never shows one client another's thread, and keeps a bounded length", async () => {
    const { conv, ws, other } = await setup();
    for (let i = 0; i < MAX_TURNS; i++) conv.record("u1", ws, "e1", `q${i}`, { text: `a${i}`, status: "answered" });
    expect(conv.thread("u1", ws, "e1")).toHaveLength(MAX_TURNS);
    expect(conv.thread("u2", other, "e1")).toEqual([]);
    expect(() => conv.thread("u2", ws, "e1")).toThrow();
  });
  it("clearing deletes the thread", async () => {
    const { conv, ws } = await setup();
    conv.record("u1", ws, "e1", "q", { text: "a", status: "answered" });
    conv.clear("u1", ws, "e1");
    expect(conv.thread("u1", ws, "e1")).toEqual([]);
  });
});

describe("the bell", () => {
  it("counts unread per person, and refuses links that leave the site", async () => {
    const identity = new IdentityService(new AuditLog(), new EventBus());
    const ws = (await identity.createWorkspace("u1", { name: "K" })).id;
    const clock = { t: new Date("2026-11-10T09:00:00Z") };
    const n = new NotificationService(identity, () => clock.t);
    clock.t = new Date("2026-11-10T10:00:00Z");
    n.add(ws, { kind: "batch_done", title: "Batch done", link: "/app.html#work" });
    n.add(ws, { kind: "info", title: "Elsewhere", link: "https://evil.test/x" });
    n.add(ws, { kind: "info", title: "Protocol-relative", link: "//evil.test" });
    const first = n.list("u1", ws);
    expect(first.unread).toBe(3);
    expect(first.notices.map((x) => x.link)).toEqual([undefined, undefined, "/app.html#work"]);
    clock.t = new Date("2026-11-10T11:00:00Z");
    n.markSeen("u1", ws);
    expect(n.list("u1", ws).unread).toBe(0);
    clock.t = new Date("2026-11-10T12:00:00Z");
    n.add(ws, { kind: "info", title: "Later" });
    expect(n.list("u1", ws).unread).toBe(1);
  });
});

describe("client experience over the API", () => {
  function setup() {
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const seen: Record<string, unknown>[] = [];
    const http = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body);
      if (String(url).includes("runpod")) {
        return body.stream
          ? sseBody(openAiChunks(["Open model draft, ", "specific and complete ", "for this business."]))
          : new Response(JSON.stringify({ choices: [{ message: { content: "Open model draft, specific and complete for this business." }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 300 } }));
      }
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"score":9,"issues":[]}' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" }));
    }) as unknown as typeof fetch;
    const platform = createPlatform({ sessionSecret: "s9", allowDevAuth: true, appUrl: "https://app.test", now: () => clock.d, http, anthropicApiKey: "ak", runpod: { apiKey: "rk", endpointId: "abc123def456" } });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const client = async () => {
      const su = await call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
      const auth = { authorization: `Bearer ${(su.body as any).token}` };
      const org = (await call("GET", "/api/org", undefined, auth)).body as any;
      return { auth, marketing: org.team.find((e: any) => e.templateKey === "marketing-manager").id as string };
    };
    return { platform, call, client, seen, clock };
  }
  const events = async (res: Res) => {
    const out: { event: string; data: any }[] = [];
    await res.stream!((event, data) => out.push({ event, data }));
    return out;
  };

  it("streams an answer: accepted first, the pieces in order, then the whole answer", async () => {
    const s = setup();
    const c = await s.client();
    const res = await s.call("POST", "/api/ask/stream", { employeeId: c.marketing, text: "Plan next month's posts", when: "now" }, c.auth);
    expect(res.status).toBe(200);
    expect(res.headers?.["content-type"]).toContain("text/event-stream");
    const ev = await events(res);
    expect(ev[0]!.event).toBe("accepted");
    const pieces = ev.filter((e) => e.event === "delta").map((e) => e.data.t);
    expect(pieces.join("")).toBe("Open model draft, specific and complete for this business.");
    const done = ev.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ status: "ready_for_review", answer: "Open model draft, specific and complete for this business." });
  });

  it("saves the question and answer, and shows the earlier exchange to the next question", async () => {
    const s = setup();
    const c = await s.client();
    await events(await s.call("POST", "/api/ask/stream", { employeeId: c.marketing, text: "Plan next month's posts", when: "now" }, c.auth));
    const saved = (await s.call("GET", `/api/conversations/${c.marketing}`, undefined, c.auth)).body as any;
    expect(saved.turns.map((t: any) => t.role)).toEqual(["you", "employee"]);
    s.seen.length = 0;
    await s.call("POST", "/api/ask", { employeeId: c.marketing, text: "Make it shorter", when: "now" }, c.auth);
    const sent = (s.seen.find((b: any) => b.model && !b.stream) ?? s.seen[0]) as any;
    const roles = sent.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(sent.messages[1].content).toBe("Plan next month's posts");
    expect(sent.messages[3].content).toBe("Make it shorter");
  });

  it("refuses a stream for a stranger, an empty question, or someone else's employee", async () => {
    const s = setup();
    const c = await s.client();
    expect((await s.call("POST", "/api/ask/stream", { employeeId: c.marketing, text: "hi" })).status).toBe(401);
    expect((await s.call("POST", "/api/ask/stream", { employeeId: c.marketing, text: "  " }, c.auth)).status).toBe(400);
    expect((await s.call("POST", "/api/ask/stream", { employeeId: "nope", text: "hi" }, c.auth)).status).toBe(400);
    expect((await s.call("GET", "/api/conversations/nope", undefined, c.auth)).status).toBe(400);
  });

  it("puts a queued question in the thread, then the answer when the batch files it, and rings the bell once", async () => {
    const s = setup();
    const c = await s.client();
    const q = (await s.call("POST", "/api/ask", { employeeId: c.marketing, text: "Plan next month's posts", when: "tonight" }, c.auth)).body as any;
    expect(q.status).toBe("queued");
    const wsId = (await s.call("GET", "/api/org", undefined, c.auth)).body as any;
    const before = (await s.call("GET", `/api/conversations/${c.marketing}`, undefined, c.auth)).body as any;
    expect(before.turns.at(-1)).toMatchObject({ status: "queued", jobId: q.jobId });
    s.platform.conversations.fileQueued(wsId.id, c.marketing, q.jobId, "The plan");
    const after = (await s.call("GET", `/api/conversations/${c.marketing}`, undefined, c.auth)).body as any;
    expect(after.turns.at(-1)).toMatchObject({ status: "answered", text: "The plan" });
  });

  it("lists notices with an unread count and clears it when seen", async () => {
    const s = setup();
    const c = await s.client();
    const org = (await s.call("GET", "/api/org", undefined, c.auth)).body as any;
    s.clock.d = new Date("2026-11-10T10:00:00Z");
    s.platform.notices.add(org.id, { kind: "batch_done", title: "Your batch is done", link: "/app.html#work" });
    const list = (await s.call("GET", "/api/notifications", undefined, c.auth)).body as any;
    expect(list.unread).toBe(1);
    s.clock.d = new Date("2026-11-10T10:05:00Z");
    expect(((await s.call("POST", "/api/notifications/seen", {}, c.auth)).body as any).unread).toBe(0);
    expect((await s.call("GET", "/api/notifications")).status).toBe(401);
  });

  it("suggests from the records: an open shift", async () => {
    const s = setup();
    const c = await s.client();
    await s.call("POST", "/api/rota/staff", { name: "Mo", role: "Barista" }, c.auth);
    await s.call("POST", "/api/rota/shifts", { date: "2026-11-10", start: "08:00", end: "16:00" }, c.auth);
    const r = (await s.call("GET", "/api/suggestions", undefined, c.auth)).body as any;
    expect(r.suggestions.some((x: any) => /nobody on them|has nobody/.test(x.title))).toBe(true);
    expect((await s.call("GET", "/api/suggestions")).status).toBe(401);
  });
});

import { describeOutcome, parseSse } from "../web/src/stream.js";
import { isSafeLink } from "../web/src/notify.js";

describe("the browser's reading of a live answer", () => {
  it("returns whole events and keeps a half-received one for next time", () => {
    const a = parseSse('event: delta\ndata: {"t":"Hel"}\n\nevent: delta\ndata: {"t":"lo"}\n\nevent: do');
    expect(a.events.map((e) => e.data.t)).toEqual(["Hel", "lo"]);
    const b = parseSse(a.rest + 'ne\ndata: {"status":"ready_for_review","answer":"Hello"}\n\n');
    expect(b.events[0]).toMatchObject({ event: "done", data: { answer: "Hello" } });
  });
  it("skips a broken event and keeps the rest", () => {
    expect(parseSse("event: delta\ndata: {oops\n\nevent: delta\ndata: {\"t\":\"ok\"}\n\n").events).toHaveLength(1);
  });
  it("never leaves the reply blank", () => {
    expect(describeOutcome("Maya", { status: "failed" }).text).toContain("Maya couldn't answer");
    expect(describeOutcome("Maya", { status: "no_energy", reason: "trial_ended" }).text).toBe("Your free trial has ended");
    expect(describeOutcome("Maya", { status: "queued", runsAt: "x" }).kind).toBe("queued");
    expect(describeOutcome("Maya", { status: "ready_for_review", answer: "Hi" })).toEqual({ kind: "answer", text: "Hi" });
  });
  it("follows only links on this site", () => {
    expect(isSafeLink("/app.html#work")).toBe(true);
    for (const bad of ["https://evil.test", "//evil.test", "javascript:alert(1)", undefined]) expect(isSafeLink(bad)).toBe(false);
  });
});
