import { describe, expect, it } from "vitest";
import { createApp, makeToken, userIdFor, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { limitFor } from "../src/server/rate-limit.js";
import { PermissionError } from "../src/modules/identity/index.js";
import { INVITE_DAYS, INVITES_PER_ADDRESS_PER_DAY, INVITES_PER_WORKSPACE_PER_HOUR, MAX_PEOPLE_PER_WORKSPACE, ROLE_WORDS } from "../src/modules/teammates/index.js";
import type { Snapshot } from "../src/core/persistence.js";

const GOOD = "correct horse battery";
const SECRET = "s3";
const DAY = 86_400_000;

function setup(over: Record<string, unknown> = {}) {
  const clock = { d: new Date("2026-11-16T10:00:00Z") };
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: SECRET, allowDevAuth: false, email: mail, appUrl: "https://app.test", now: () => clock.d, platformOwners: ["boss@maiz.co"], ...over } as any);
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    handle({ method, path, query: new URLSearchParams(), headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  /** A session for an address that proved itself the way an emailed or Google/Microsoft sign-in does. */
  const sessionFor = async (email: string): Promise<string> => {
    const link = makeToken(SECRET, { k: "magic", e: email, n: `n-${email}-${clock.d.getTime()}-${Math.random()}` }, 900, clock.d.getTime());
    const r = await call("POST", "/api/signin/verify", { token: link });
    expect(r.status).toBe(200);
    return (r.body as any).token as string;
  };
  /** A business owner with a team: verified email, then the signup that makes the workspace. */
  const owner = async (email = "ann@kestrel.co", businessName = "Kestrel Coffee") => {
    const token = await sessionFor(email);
    const r = await call("POST", "/api/signup", { businessName, sells: "Coffee", size: "2–10", country: "GB" }, token);
    expect(r.status).toBe(201);
    return { token, email, userId: userIdFor(email), ws: (r.body as any).workspaceId as string };
  };
  /** The join link in the newest invite email to `to`. */
  const linkTo = (to: string): string => {
    const m = [...mail.sent].reverse().find((x) => x.to === to && /join\.html#i=/.test(x.text));
    return /join\.html#i=(\S+)/.exec(m!.text)![1]!;
  };
  const invite = async (o: { token: string }, email: string, role = "member") => {
    const r = await call("POST", "/api/team/invites", { email, role }, o.token);
    return { r, id: (r.body as any)?.invite?.id as string, link: r.status === 201 ? linkTo(email.trim().toLowerCase()) : "" };
  };
  /** Invites `email` and joins as a brand-new person with a password. Returns their session. */
  const joined = async (o: { token: string }, email: string, role = "member") => {
    const { link, r } = await invite(o, email, role);
    expect(r.status).toBe(201);
    const a = await call("POST", "/api/invites/accept", { token: link, password: GOOD });
    expect(a.status).toBe(200);
    return { token: (a.body as any).token as string, email, userId: userIdFor(email) };
  };
  return { platform, call, clock, mail, sessionFor, owner, invite, joined, linkTo };
}

describe("teammates: inviting", () => {
  it("emails a join link to the invited address and lists the invite as pending", async () => {
    const s = setup();
    const ann = await s.owner();

    const { r, link } = await s.invite(ann, " Ben@Kestrel.co ", "member");

    expect(r.status).toBe(201);
    expect((r.body as any).invite).toMatchObject({ email: "ben@kestrel.co", role: "member", roleLabel: ROLE_WORDS.member.label, status: "pending" });
    const sent = s.mail.sent.at(-1)!;
    expect(sent.to).toBe("ben@kestrel.co");
    // The business name is free text anyone can choose, so it stays out of the subject and is quoted in the body.
    expect(sent.subject).not.toContain("Kestrel Coffee");
    expect(sent.text).toContain('"Kestrel Coffee"');
    expect(sent.text).toContain("https://app.test/join.html#i=");
    expect(sent.text).toContain(ROLE_WORDS.member.label);
    expect(link.length).toBeGreaterThan(40);
    const team = (await s.call("GET", "/api/team", undefined, ann.token)).body as any;
    expect(team.invites).toHaveLength(1);
    expect(team.invites[0]).toMatchObject({ email: "ben@kestrel.co", status: "pending" });
    expect(JSON.stringify(team)).not.toContain(link.split(".")[1]);
    // Production replies never carry the link: it only travels by email.
    expect(JSON.stringify(r.body)).not.toContain(link.split(".")[1]);
  });

  it("only the owner can invite, and nobody can be invited as an owner", async () => {
    const s = setup();
    const ann = await s.owner();
    const manager = await s.joined(ann, "mia@kestrel.co", "admin");

    expect((await s.call("POST", "/api/team/invites", { email: "x@kestrel.co", role: "viewer" }, manager.token)).status).toBe(403);
    expect((await s.call("POST", "/api/team/invites", { email: "x@kestrel.co", role: "owner" }, ann.token)).status).toBe(400);
    expect((await s.call("POST", "/api/team/invites", { email: "not-an-email", role: "viewer" }, ann.token)).status).toBe(400);
    expect((await s.call("POST", "/api/team/invites", { email: "x@kestrel.co", role: "boss" }, ann.token)).status).toBe(400);
    expect((await s.call("POST", "/api/team/invites", { email: "x@kestrel.co", role: "viewer" })).status).toBe(401);
  });

  it("answers the same whether or not the address already has an account", async () => {
    const s = setup();
    const ann = await s.owner();
    await s.owner("zoe@other.co", "Other Bakery"); // zoe already has an account and her own business

    const fresh = await s.invite(ann, "new@person.co");
    const known = await s.invite(ann, "zoe@other.co");

    const shape = (b: any) => ({ keys: Object.keys(b).sort(), invite: { ...b.invite, id: "", email: "" } });
    expect(known.r.status).toBe(fresh.r.status);
    expect(shape(known.r.body)).toEqual(shape(fresh.r.body));
    expect(s.mail.sent.filter((m) => m.to === "zoe@other.co" && /join\.html/.test(m.text))).toHaveLength(1);
  });

  it("keeps only a hash of the link's secret", async () => {
    const records: any[] = [];
    const empty = { workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [] } as Snapshot;
    const s = setup();
    await s.platform.attachStore(new Proxy({} as any, { get: (_t, prop) => prop === "load" ? async () => empty : prop === "then" ? undefined : prop === "record" ? (ws: string, kind: string, id: string, data: unknown) => records.push({ ws, kind, id, data: JSON.parse(JSON.stringify(data)) }) : () => {} }));
    const ann = await s.owner();

    const { link } = await s.invite(ann, "ben@kestrel.co");

    const secret = link.split(".")[1]!;
    expect(records.some((r) => r.kind === "team_invite")).toBe(true);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("stops at the people limit, counting invites still waiting", async () => {
    const s = setup();
    const ann = await s.owner();
    for (let i = 1; i < MAX_PEOPLE_PER_WORKSPACE; i++) {
      // Stay under the hourly limit: the cap is what is being tested here.
      if (i % INVITES_PER_WORKSPACE_PER_HOUR === 0) s.clock.d = new Date(s.clock.d.getTime() + 61 * 60_000);
      expect((await s.invite(ann, `p${i}@kestrel.co`)).r.status).toBe(201);
    }
    s.clock.d = new Date(s.clock.d.getTime() + 61 * 60_000);

    const over = await s.invite(ann, "one-too-many@kestrel.co");

    expect(over.r.status).toBe(400);
    expect((over.r.body as any).error).toContain(String(MAX_PEOPLE_PER_WORKSPACE));
  });

  it("limits invites per business and per address", async () => {
    const s = setup();
    const ann = await s.owner();
    const first = await s.invite(ann, "ben@kestrel.co");
    for (let i = 1; i < INVITES_PER_ADDRESS_PER_DAY; i++) expect((await s.call("POST", `/api/team/invites/${first.id}/resend`, {}, ann.token)).status).toBe(200);

    expect((await s.call("POST", `/api/team/invites/${first.id}/resend`, {}, ann.token)).status).toBe(429);

    // The per-address limit follows the address, not the business that invites it.
    const cal = await s.owner("cal@second.co", "Second Shop");
    expect((await s.invite(cal, "ben@kestrel.co")).r.status).toBe(429);

    const t = setup();
    const dee = await t.owner();
    let last = 201;
    for (let i = 0; i <= INVITES_PER_WORKSPACE_PER_HOUR; i++) {
      const made = await t.invite(dee, `q${i}@kestrel.co`, "viewer");
      last = made.r.status;
      // Cancelled at once so the people limit is never what stops it.
      if (made.id) await t.call("POST", `/api/team/invites/${made.id}/cancel`, {}, dee.token);
    }
    expect(last).toBe(429);
  });

  it("has a request limit on every invite endpoint", () => {
    for (const path of ["/api/invites/open", "/api/invites/accept", "/api/team/invites", "/api/team/invites/abc/resend"]) {
      const l = limitFor("POST", path)!;
      expect(l.max / (l.windowMs / 60_000)).toBeLessThan(10);
    }
  });
});

describe("teammates: accepting", () => {
  it("a new person joins with a password from the link, without business setup and without their own trial", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link } = await s.invite(ann, "ben@kestrel.co", "member");

    const seen = await s.call("POST", "/api/invites/open", { token: link });
    const accepted = await s.call("POST", "/api/invites/accept", { token: link, password: GOOD });

    expect(seen).toMatchObject({ status: 200, body: { businessName: "Kestrel Coffee", email: "ben@kestrel.co", role: "member", roleLabel: ROLE_WORDS.member.label } });
    expect(accepted.status).toBe(200);
    const ben = (accepted.body as any).token as string;
    expect(accepted.body).toMatchObject({ email: "ben@kestrel.co", hasOrganisation: true, role: "member" });
    const org = await s.call("GET", "/api/org", undefined, ben);
    expect(org).toMatchObject({ status: 200, body: { id: ann.ws, name: "Kestrel Coffee" } });
    expect(s.platform.identity.workspacesFor(userIdFor("ben@kestrel.co")).map((w) => w.id)).toEqual([ann.ws]);
    expect(s.platform.identity.roleOf(userIdFor("ben@kestrel.co"), ann.ws)).toBe("member");
    // The password they chose logs them in afterwards.
    expect((await s.call("POST", "/api/auth/login", { email: "ben@kestrel.co", password: GOOD })).status).toBe(200);
    // No business of their own: signup is refused for an address that already belongs to one.
    expect((await s.call("POST", "/api/signup", { businessName: "Ben's Own", country: "GB" }, ben)).status).toBe(409);
    expect(s.platform.identity.allWorkspaces()).toHaveLength(1);
  });

  it("works once", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link } = await s.invite(ann, "ben@kestrel.co");
    expect((await s.call("POST", "/api/invites/accept", { token: link, password: GOOD })).status).toBe(200);

    const again = await s.call("POST", "/api/invites/accept", { token: link, password: "another good password" });

    expect(again.status).toBe(400);
    expect((await s.call("POST", "/api/invites/open", { token: link })).status).toBe(400);
    expect((await s.call("POST", "/api/auth/login", { email: "ben@kestrel.co", password: "another good password" })).status).toBe(401);
  });

  it("expires after 7 days", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link } = await s.invite(ann, "ben@kestrel.co");

    s.clock.d = new Date(s.clock.d.getTime() + INVITE_DAYS * DAY - 60_000);
    expect((await s.call("POST", "/api/invites/open", { token: link })).status).toBe(200);
    s.clock.d = new Date(s.clock.d.getTime() + 120_000);

    expect((await s.call("POST", "/api/invites/open", { token: link })).status).toBe(400);
    expect((await s.call("POST", "/api/invites/accept", { token: link, password: GOOD })).status).toBe(400);
    expect(s.platform.identity.roleOf(userIdFor("ben@kestrel.co"), ann.ws)).toBeUndefined();
    const team = (await s.call("GET", "/api/team", undefined, await s.sessionFor(ann.email))).body as any;
    expect(team.invites[0]).toMatchObject({ status: "expired" });
  });

  it("a cancelled invite stops working", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link, id } = await s.invite(ann, "ben@kestrel.co");

    const cancelled = await s.call("POST", `/api/team/invites/${id}/cancel`, {}, ann.token);

    expect(cancelled.status).toBe(200);
    expect((cancelled.body as any).invites).toHaveLength(0);
    expect((await s.call("POST", "/api/invites/accept", { token: link, password: GOOD })).status).toBe(400);
  });

  it("sending again makes a new link, ends the old one and restarts the 7 days", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link: old, id } = await s.invite(ann, "ben@kestrel.co");
    s.clock.d = new Date(s.clock.d.getTime() + 6 * DAY);

    const again = await s.call("POST", `/api/team/invites/${id}/resend`, {}, ann.token);
    const fresh = s.linkTo("ben@kestrel.co");

    expect(again.status).toBe(200);
    expect(fresh).not.toBe(old);
    expect((await s.call("POST", "/api/invites/open", { token: old })).status).toBe(400);
    s.clock.d = new Date(s.clock.d.getTime() + 3 * DAY);
    expect((await s.call("POST", "/api/invites/accept", { token: fresh, password: GOOD })).status).toBe(200);
  });

  it("refuses a made-up or tampered link with one plain answer", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link } = await s.invite(ann, "ben@kestrel.co");
    const [id, secret] = link.split(".") as [string, string];

    for (const bad of ["", "nope", `${id}.`, `${id}.${secret.slice(0, -2)}xx`, `00000000-0000-4000-8000-000000000000.${secret}`, 7, null]) {
      const r = await s.call("POST", "/api/invites/open", { token: bad });
      expect(r.status).toBe(400);
      expect((r.body as any).error).toBe("This invite link is not valid any more. Ask the person who invited you to send a new one.");
    }
  });
});

describe("teammates: who may use an invite", () => {
  it("an address that already has an account must log in, and the link cannot set its password", async () => {
    const s = setup();
    const ann = await s.owner();
    const zoe = await s.sessionFor("zoe@kestrel.co");
    expect((await s.call("POST", "/api/auth/password", { password: "zoe's own long password" }, zoe)).status).toBe(200);
    const { link } = await s.invite(ann, "zoe@kestrel.co");

    const viaLink = await s.call("POST", "/api/invites/accept", { token: link, password: GOOD });

    expect(viaLink).toMatchObject({ status: 409, body: { reason: "login" } });
    expect((await s.call("POST", "/api/auth/login", { email: "zoe@kestrel.co", password: GOOD })).status).toBe(401);
    // The join page is told to show "log in" instead of "choose a password", and who is logged in on this device.
    expect((await s.call("POST", "/api/invites/open", { token: link })).body).toMatchObject({ needsLogin: true });
    expect((await s.call("POST", "/api/invites/open", { token: link }, zoe)).body).toMatchObject({ needsLogin: true, loggedInAs: "zoe@kestrel.co" });
    const { link: fresh } = await s.invite(ann, "new@kestrel.co");
    expect((await s.call("POST", "/api/invites/open", { token: fresh })).body).toMatchObject({ needsLogin: false });
    const login = await s.call("POST", "/api/auth/login", { email: "zoe@kestrel.co", password: "zoe's own long password" });
    const ok = await s.call("POST", "/api/invites/accept", { token: link }, (login.body as any).token);
    expect(ok.status).toBe(200);
    expect(s.platform.identity.roleOf(userIdFor("zoe@kestrel.co"), ann.ws)).toBe("member");
  });

  it("a logged-in person can only accept an invite sent to their own address", async () => {
    const s = setup();
    const ann = await s.owner();
    const { link } = await s.invite(ann, "ben@kestrel.co");
    const mallory = await s.sessionFor("mallory@else.co");

    const wrong = await s.call("POST", "/api/invites/accept", { token: link }, mallory);

    expect(wrong.status).toBe(403);
    expect(s.platform.identity.roleOf(userIdFor("mallory@else.co"), ann.ws)).toBeUndefined();
    expect(s.platform.identity.roleOf(userIdFor("ben@kestrel.co"), ann.ws)).toBeUndefined();
    // The invite is still good for the person it was sent to.
    expect((await s.call("POST", "/api/invites/accept", { token: link, password: GOOD })).status).toBe(200);
  });

  it("Google or Microsoft: the provider's verified address must be the invited one", async () => {
    const s = setup();
    const ann = await s.owner();
    await s.invite(ann, "ben@kestrel.co", "viewer");
    // A social sign-in ends as a session for the address the provider verified (test/social-login.test.ts).
    const other = await s.sessionFor("ben.personal@gmail.com");
    const same = await s.sessionFor("ben@kestrel.co");

    const none = await s.call("GET", "/api/invites/mine", undefined, other);
    const mine = await s.call("GET", "/api/invites/mine", undefined, same);
    const id = (mine.body as any).invites[0].id as string;
    const stolen = await s.call("POST", "/api/invites/accept", { inviteId: id }, other);
    const ok = await s.call("POST", "/api/invites/accept", { inviteId: id }, same);

    expect((none.body as any).invites).toEqual([]);
    expect((mine.body as any).invites).toMatchObject([{ businessName: "Kestrel Coffee", role: "viewer" }]);
    expect(stolen.status).toBe(400);
    expect(ok.status).toBe(200);
    expect(s.platform.identity.roleOf(userIdFor("ben@kestrel.co"), ann.ws)).toBe("viewer");
  });

  it("an address that already has its own business is told to use another address, and keeps its own business", async () => {
    const s = setup();
    const ann = await s.owner();
    const zoe = await s.owner("zoe@other.co", "Other Bakery");
    const { link } = await s.invite(ann, "zoe@other.co", "admin");

    const r = await s.call("POST", "/api/invites/accept", { token: link }, zoe.token);

    expect(r).toMatchObject({ status: 409, body: { reason: "other_business" } });
    expect((r.body as any).error).toMatch(/another email address/i);
    expect(s.platform.identity.workspacesFor(zoe.userId).map((w) => w.id)).toEqual([zoe.ws]);
    expect(((await s.call("GET", "/api/org", undefined, zoe.token)).body as any).name).toBe("Other Bakery");
  });

  it("never makes the invited person an owner, and a MAIZ platform owner cannot join a client", async () => {
    const s = setup();
    const ann = await s.owner();
    const ben = await s.joined(ann, "ben@kestrel.co", "admin");

    expect(s.platform.identity.roleOf(ben.userId, ann.ws)).toBe("admin");
    expect((await s.call("POST", `/api/team/members/${ben.userId}/role`, { role: "owner" }, ann.token)).status).toBe(400);
    expect(() => s.platform.identity.addMember(ann.userId, ann.ws, "u_someone", "owner")).toThrow(PermissionError);
    expect(() => s.platform.identity.setRole(ann.userId, ann.ws, ben.userId, "owner" as never)).toThrow(PermissionError);
    expect(s.platform.identity.roleOf(ben.userId, ann.ws)).toBe("admin");

    const { link } = await s.invite(ann, "boss@maiz.co");
    expect((await s.call("POST", "/api/invites/accept", { token: link, password: GOOD })).status).toBe(409);
    const boss = await s.sessionFor("boss@maiz.co");
    expect((await s.call("POST", "/api/invites/accept", { token: link }, boss)).status).toBe(403);
    expect(s.platform.identity.roleOf(userIdFor("boss@maiz.co"), ann.ws)).toBeUndefined();
  });
});

describe("teammates: managing people", () => {
  it("the owner sees everyone; a teammate sees only the owner and their own role", async () => {
    const s = setup();
    const ann = await s.owner();
    const ben = await s.joined(ann, "ben@kestrel.co", "viewer");
    await s.invite(ann, "cal@kestrel.co", "admin");

    const forOwner = (await s.call("GET", "/api/team", undefined, ann.token)).body as any;
    const forBen = (await s.call("GET", "/api/team", undefined, ben.token)).body as any;

    expect(forOwner).toMatchObject({ canManage: true, businessName: "Kestrel Coffee", you: { email: "ann@kestrel.co", role: "owner" }, limit: MAX_PEOPLE_PER_WORKSPACE });
    expect(forOwner.members.map((m: any) => [m.email, m.role])).toEqual([["ann@kestrel.co", "owner"], ["ben@kestrel.co", "viewer"]]);
    expect(forOwner.invites.map((i: any) => i.email)).toEqual(["cal@kestrel.co"]);
    expect(forBen).toMatchObject({ canManage: false, businessName: "Kestrel Coffee", you: { email: "ben@kestrel.co", role: "viewer", roleLabel: ROLE_WORDS.viewer.label }, owner: { email: "ann@kestrel.co" } });
    expect(forBen.members).toBeUndefined();
    expect(forBen.invites).toBeUndefined();
    expect(JSON.stringify(forBen)).not.toContain("cal@kestrel.co");
  });

  it("changing a role takes effect on the person's next request and is written to the audit log", async () => {
    const s = setup();
    const ann = await s.owner();
    const ben = await s.joined(ann, "ben@kestrel.co", "viewer");
    const emp = ((await s.call("GET", "/api/org", undefined, ben.token)).body as any).team[0].id as string;
    expect((await s.call("POST", `/api/conversations/${emp}/clear`, {}, ben.token)).status).toBe(403);

    const changed = await s.call("POST", `/api/team/members/${ben.userId}/role`, { role: "member" }, ann.token);

    expect(changed.status).toBe(200);
    expect((await s.call("POST", `/api/conversations/${emp}/clear`, {}, ben.token)).status).toBe(200);
    const actions = s.platform.audit.list(ann.ws).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["team.invited", "member.added", "member.role_changed"]));
    expect(s.platform.audit.list(ann.ws).find((e) => e.action === "member.role_changed")).toMatchObject({ actor: `user:${ann.userId}`, target: `user:${ben.userId}`, data: { from: "viewer", to: "member" } });
  });

  it("removing a person ends their access on the next request and turns off their device alerts", async () => {
    const s = setup();
    const ann = await s.owner();
    const ben = await s.joined(ann, "ben@kestrel.co", "admin");
    s.platform.push.subscribe(ben.userId, ann.ws, { endpoint: "https://fcm.googleapis.com/fcm/send/ben", keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } });
    expect((await s.call("GET", "/api/dashboard", undefined, ben.token)).status).toBe(200);
    expect(s.platform.push.count(ben.userId)).toBe(1);

    const removed = await s.call("POST", `/api/team/members/${ben.userId}/remove`, {}, ann.token);

    expect(removed.status).toBe(200);
    expect((removed.body as any).members.map((m: any) => m.email)).toEqual(["ann@kestrel.co"]);
    // The same login, still inside its 7 days, now opens nothing of this business.
    for (const [method, path] of [["GET", "/api/org"], ["GET", "/api/dashboard"], ["GET", "/api/people"], ["GET", "/api/team"], ["POST", "/api/ask"], ["GET", "/api/finance/summary"]] as const) {
      expect((await s.call(method, path, method === "POST" ? { text: "hi" } : undefined, ben.token)).status).toBe(404);
    }
    expect(s.platform.identity.roleOf(ben.userId, ann.ws)).toBeUndefined();
    expect(s.platform.push.count(ben.userId)).toBe(0);
    expect(s.platform.audit.list(ann.ws).find((e) => e.action === "member.removed")).toMatchObject({ actor: `user:${ann.userId}`, target: `user:${ben.userId}` });
    expect(((await s.call("GET", "/api/me", undefined, ben.token)).body as any).hasOrganisation).toBe(false);
  });

  it("the owner cannot be removed or changed, and people in another business cannot be touched", async () => {
    const s = setup();
    const ann = await s.owner();
    const ben = await s.joined(ann, "ben@kestrel.co", "admin");
    const cal = await s.owner("cal@second.co", "Second Shop");
    const dee = await s.joined(cal, "dee@second.co", "member");

    expect((await s.call("POST", `/api/team/members/${ann.userId}/remove`, {}, ann.token)).status).toBe(400);
    expect((await s.call("POST", `/api/team/members/${ann.userId}/role`, { role: "viewer" }, ann.token)).status).toBe(400);
    expect((await s.call("POST", `/api/team/members/${dee.userId}/remove`, {}, ann.token)).status).toBe(400);
    expect((await s.call("POST", `/api/team/members/${ann.userId}/remove`, {}, ben.token)).status).toBe(403);
    expect(s.platform.identity.roleOf(ann.userId, ann.ws)).toBe("owner");
    expect(s.platform.identity.roleOf(dee.userId, cal.ws)).toBe("member");
  });

  it("a removed person stays removed after a restart, and can be invited again", async () => {
    const writes = { records: [] as any[], workspaces: [] as any[], memberships: [] as any[] };
    const empty = { workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [] } as Snapshot;
    const store = (snapshot: Snapshot) => new Proxy({} as any, {
      get: (_t, prop) => {
        if (prop === "load") return async () => snapshot;
        if (prop === "record") return (workspaceId: string, kind: string, id: string, data: unknown) => writes.records.push({ workspaceId, kind, id, data: JSON.parse(JSON.stringify(data)) });
        if (prop === "workspace") return (w: unknown) => writes.workspaces.push(w);
        if (prop === "membership") return (workspaceId: string, userId: string, role: string) => writes.memberships.push({ workspaceId, userId, role });
        if (prop === "then") return undefined;
        return () => {};
      },
    });
    const a = setup();
    await a.platform.attachStore(store(empty));
    const ann = await a.owner();
    const ben = await a.joined(ann, "ben@kestrel.co", "admin");
    const cal = await a.joined(ann, "cal@kestrel.co", "viewer");
    const waiting = await a.invite(ann, "dee@kestrel.co", "member");
    await a.call("POST", `/api/team/members/${ben.userId}/remove`, {}, ann.token);

    const b = setup();
    const latest = [...new Map(writes.records.map((r) => [`${r.workspaceId}|${r.kind}|${r.id}`, r])).values()];
    await b.platform.attachStore(store({ ...empty, workspaces: writes.workspaces, memberships: writes.memberships, records: latest }));

    expect(b.platform.identity.roleOf(ben.userId, ann.ws)).toBeUndefined();
    expect(b.platform.identity.roleOf(cal.userId, ann.ws)).toBe("viewer");
    const team = b.platform.team.overview(ann.userId, ann.ws);
    expect(team.members!.map((m) => m.email)).toEqual(["ann@kestrel.co", "cal@kestrel.co"]);
    expect(team.invites!.map((i) => i.email)).toEqual(["dee@kestrel.co"]);
    expect((await b.call("POST", "/api/invites/open", { token: waiting.link })).status).toBe(200);
    // Invited again later, the same person comes back with the new role.
    const back = b.platform.team.invite(ann.userId, ann.ws, { email: "ben@kestrel.co", role: "viewer" });
    b.platform.team.accept({ token: back.token }, "ben@kestrel.co");
    expect(b.platform.identity.roleOf(ben.userId, ann.ws)).toBe("viewer");
  });
});

describe("teammates: the services keep the same rules as the route table", () => {
  it("a manager cannot pay, open the billing page, cancel an order or read the orders", async () => {
    const s = setup();
    const ann = await s.owner();
    const max = await s.joined(ann, "max@kestrel.co", "admin");
    const pay = s.platform.payments;

    await expect(pay.checkout(max.userId, ann.ws, [])).rejects.toBeInstanceOf(PermissionError);
    await expect(pay.portalUrl(max.userId, ann.ws, "https://app.test/app.html")).rejects.toBeInstanceOf(PermissionError);
    await expect(pay.cancel(max.userId, ann.ws, "order-1")).rejects.toBeInstanceOf(PermissionError);
    expect(() => pay.mine(max.userId, ann.ws)).toThrow(PermissionError);
    expect(pay.mine(ann.userId, ann.ws)).toEqual([]);
  });

  it("the rota shows pay to the owner and managers only, and only they can change it", async () => {
    const s = setup();
    const ann = await s.owner();
    const max = await s.joined(ann, "max@kestrel.co", "admin");
    const ben = await s.joined(ann, "ben@kestrel.co", "member");
    const mo = (await s.call("POST", "/api/rota/staff", { name: "Mo", hourlyRateMinor: 1200 }, ann.token)).body as any;
    await s.call("POST", "/api/rota/shifts", { date: "2026-11-17", start: "08:00", end: "16:00", staffId: mo.added.id }, max.token);

    const forManager = s.platform.rota.week(max.userId, ann.ws, "2026-11-17") as any;
    const forMember = s.platform.rota.week(ben.userId, ann.ws, "2026-11-17") as any;

    expect(forManager.totalCostMinor).toBe(9600);
    expect(forManager.staff[0].hourlyRateMinor).toBe(1200);
    expect(forMember.totalHours).toBe(8);
    expect(forMember.totalCostMinor).toBeNull();
    expect(forMember.hoursByPerson[0].costMinor).toBeNull();
    expect(forMember.staff[0]).not.toHaveProperty("hourlyRateMinor");
    expect(JSON.stringify(forMember)).not.toContain("1200");
    expect(() => s.platform.rota.addStaff(ben.userId, ann.ws, { name: "Zed" })).toThrow(PermissionError);
  });

  it("a first file upload connects the app, so it is the owner's; later uploads are open to the team", async () => {
    const s = setup();
    const ann = await s.owner();
    const ben = await s.joined(ann, "ben@kestrel.co", "member");
    const till = "Date,Total,VAT\n2026-06-06,60,10";
    const upload = (token: string, csv: string) => s.call("POST", "/api/integrations/apps/till-file/import", { csv }, token);

    const tooEarly = await upload(ben.token, till);
    const first = await upload(ann.token, till);
    const later = await upload(ben.token, `${till}\n2026-06-07,120,20`);

    expect(tooEarly.status).toBe(403);
    expect(first.status).toBe(200);
    expect(later.status).toBe(200);
  });
});
