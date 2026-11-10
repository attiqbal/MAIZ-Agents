import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { parseProposal, statusOf } from "../src/modules/review/index.js";

const OWNER = "atif@maiz.test";
const brandKit = {
  title: "Brand kit for the autumn range",
  employee: "Brand and content creator",
  days: 5,
  design: "One brand kit shown on a bag label, a social post and an email header.",
  brief: [{ label: "Who you sell to", value: "Home coffee drinkers" }, { label: "Colours you already use" }],
  directions: [
    { key: "refresh", name: "Refresh", summary: "Keep the logo, new palette.", recommended: true },
    { key: "rebrand", name: "Full rebrand", summary: "New logo, palette and type." },
  ],
  plan: [{ title: "Sample layouts", energy: 300 }, { title: "Templates", energy: 400 }],
};

function setup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const sessionFor = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string, businessName: string) => {
    const r = await call("POST", "/api/signup", { email, businessName, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  return { platform, call, clock, mail, sessionFor, signUp, owner: sessionFor(OWNER) };
}

describe("quality review: parsing a compiled brief", () => {
  it("never takes sign-off from the input", () => {
    const { proposal } = parseProposal({ ...brandKit, signedOffAt: "2026-01-01T00:00:00Z", chosenDirection: "rebrand" });
    expect(proposal.signedOffAt).toBeUndefined();
    expect(proposal.chosenDirection).toBeUndefined();
    expect(statusOf(proposal)).toBe("gathering_info");
  });
  it("refuses bad input", () => {
    expect(() => parseProposal({ ...brandKit, title: "" })).toThrow(/title/);
    expect(() => parseProposal({ ...brandKit, days: 0 })).toThrow(/days/);
    expect(() => parseProposal({ ...brandKit, directions: [{ key: "Bad Key", name: "x", summary: "y" }] })).toThrow(/key/);
    expect(() => parseProposal({ ...brandKit, brief: [{ label: "a" }, { label: "a" }] })).toThrow(/different/);
    expect(() => parseProposal({ ...brandKit, plan: [{ title: "x", energy: -1 }] })).toThrow(/energy/);
  });
});

describe("quality review: the platform owner signs off, never the client", () => {
  it("runs the whole flow: client answers, task joins the owner's queue, owner approves, client is told", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");

    const created = await s.call("POST", "/api/reviews", brandKit, ann);
    expect(created.status).toBe(201);
    const task = (created.body as any).task;
    expect(task.status).toBe("gathering_info");
    expect(task.statusLabel).toMatch(/answers from you/);
    expect(s.mail.sent.filter((m) => m.to === OWNER)).toHaveLength(0);

    // The client answers the open question; the task joins the queue and the owner is emailed.
    const answered = await s.call("POST", `/api/reviews/${task.id}/answer`, { label: "Colours you already use", value: "Green and cream" }, ann);
    expect((answered.body as any).task.status).toBe("in_review");
    expect((answered.body as any).task.statusLabel).toBe("In quality review");
    await Promise.resolve();
    const alert = s.mail.sent.find((m) => m.to === OWNER)!;
    expect(alert.subject).toBe("Quality review: Brand kit for the autumn range for Kestrel Coffee");
    expect(alert.text).toContain(`https://app.test/review.html#${task.id}`);

    // The owner's queue shows the client, the brief, the options and the age.
    s.clock.d = new Date("2026-11-10T12:30:00Z");
    const queue = (await s.call("GET", "/api/owner/reviews", undefined, s.owner)).body as any;
    expect(queue.reviews).toHaveLength(1);
    expect(queue.reviews[0]).toMatchObject({ clientName: "Kestrel Coffee", status: "in_review", ageHours: 3, energy: 700, missing: [] });
    expect(queue.reviews[0].proposal.directions.map((d: any) => d.key)).toEqual(["refresh", "rebrand"]);

    // Approve needs a direction when there are several.
    expect((await s.call("POST", `/api/owner/reviews/${task.id}/approve`, {}, s.owner)).status).toBe(400);
    const ok = await s.call("POST", `/api/owner/reviews/${task.id}/approve`, { direction: "refresh", noteToClient: "Matches your brief.", note: "Good work" }, s.owner);
    expect(ok.status).toBe(200);
    expect((ok.body as any).review.status).toBe("approved");
    expect(s.platform.reviews.mayStart(task.id)).toBe(true);

    // The client now sees the outcome, but never the internal note or the options not chosen.
    const mine = ((await s.call("GET", "/api/reviews", undefined, ann)).body as any).tasks[0];
    expect(mine).toMatchObject({ status: "approved", chosenDirection: { name: "Refresh" }, noteToClient: "Matches your brief." });
    expect(JSON.stringify(mine)).not.toContain("Good work");
    expect(JSON.stringify(mine)).not.toContain("Full rebrand");
    const inbox = ((await s.call("GET", "/api/setup", undefined, ann)).body as any).messages;
    expect(inbox.at(-1)).toMatchObject({ kind: "review", link: "/app.html#work" });
    expect(inbox.at(-1).text).toContain("passed quality review (direction: Refresh)");

    // Every step is in the client's audit log, with the platform owner named as the approver.
    const actions = s.platform.audit.list(s.platform.identity.workspacesFor(userIdFor("ann@kestrel.co"))[0]!.id).filter((e) => e.action.startsWith("review.")).map((e) => `${e.action} ${e.actor.split(":")[0]}`);
    expect(actions).toEqual(["review.submitted user", "review.answered user", "review.entered_queue user", "review.approved platform-owner"]);
  });

  it("refuses the client every reviewer action, and hides the queue", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const id = ((await s.call("POST", "/api/reviews", { ...brandKit, brief: [{ label: "Who you sell to", value: "Everyone" }] }, ann)).body as any).task.id;
    expect((await s.call("GET", "/api/owner/reviews", undefined, ann)).status).toBe(403);
    expect((await s.call("POST", `/api/owner/reviews/${id}/approve`, { direction: "refresh" }, ann)).status).toBe(403);
    expect((await s.call("POST", `/api/owner/reviews/${id}/request-info`, { question: "x" }, ann)).status).toBe(403);
    await expect(s.platform.reviews.approve(userIdFor("ann@kestrel.co"), id, { direction: "refresh" })).rejects.toThrow(/platform owner/);
    expect(s.platform.reviews.mayStart(id)).toBe(false);
    expect((await s.call("GET", "/api/owner/reviews")).status).toBe(401);
  });

  it("keeps one client's tasks away from another", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@bakery.co", "Bob's Bakery");
    const id = ((await s.call("POST", "/api/reviews", brandKit, ann)).body as any).task.id;
    expect(((await s.call("GET", "/api/reviews", undefined, bob)).body as any).tasks).toEqual([]);
    expect((await s.call("POST", `/api/reviews/${id}/answer`, { label: "Colours you already use", value: "Red" }, bob)).status).toBe(400);
  });

  it("sends a task back for more information, then it returns to the queue once answered", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const id = ((await s.call("POST", "/api/reviews", { ...brandKit, brief: [{ label: "Who you sell to", value: "Everyone" }] }, ann)).body as any).task.id;
    await Promise.resolve();
    expect(s.mail.sent.filter((m) => m.to === OWNER)).toHaveLength(1);

    const back = await s.call("POST", `/api/owner/reviews/${id}/request-info`, { question: "Which age group buys most?", note: "Too vague" }, s.owner);
    expect((back.body as any).review.status).toBe("more_info_requested");
    expect((await s.call("POST", `/api/owner/reviews/${id}/approve`, { direction: "refresh" }, s.owner)).status).toBe(400);
    const mine = ((await s.call("GET", "/api/reviews", undefined, ann)).body as any).tasks[0];
    expect(mine.statusLabel).toMatch(/finding out more/);
    expect(JSON.stringify(mine)).not.toContain("Too vague");

    await s.call("POST", `/api/reviews/${id}/answer`, { label: "Which age group buys most?", value: "25 to 45" }, ann);
    await Promise.resolve();
    expect(s.mail.sent.filter((m) => m.to === OWNER)).toHaveLength(2);
    expect((await s.call("POST", `/api/owner/reviews/${id}/approve`, { direction: "rebrand" }, s.owner)).status).toBe(200);
    expect((await s.call("POST", `/api/reviews/${id}/answer`, { label: "Who you sell to", value: "Changed" }, ann)).status).toBe(400);
  });

  it("lets the platform owner in without an organisation, and says so at sign-in", async () => {
    const s = setup();
    expect(((await s.call("GET", "/api/me", undefined, s.owner)).body as any)).toEqual({ platformOwner: true, hasOrganisation: false });
    const start = (await s.call("POST", "/api/signin/start", { email: OWNER })).body as any;
    const verified = (await s.call("POST", "/api/signin/verify", { token: start.devLink })).body as any;
    expect(verified).toMatchObject({ platformOwner: true, hasOrganisation: false });
  });

  it("stores reviews and puts them back after a restart", async () => {
    const s = setup();
    const saved: any[] = [];
    s.platform.reviews.useSink({ review: (r: unknown) => saved.push(r) } as never);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/reviews", brandKit, ann);
    expect(saved).toHaveLength(1);
    const again = setup();
    again.platform.reviews.restore(saved[0]);
    expect(again.platform.reviews.queue(userIdFor(OWNER))[0]!.id).toBe(saved[0].id);
  });
});

describe("setup that cannot undo itself alerts the platform owner", () => {
  it("emails the owner on a failed rollback", async () => {
    const s = setup();
    await s.platform.bus.publish({ type: "setup.failed", workspaceId: "ws1", payload: { status: "rollback_failed" }, at: new Date() });
    await s.platform.bus.publish({ type: "setup.failed", workspaceId: "ws1", payload: { status: "rolled_back" }, at: new Date() });
    expect(s.mail.sent.filter((m) => m.to === OWNER).map((m) => m.subject)).toEqual(["Setup needs you: ws1"]);
  });
});
