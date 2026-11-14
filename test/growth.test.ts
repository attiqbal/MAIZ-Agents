import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { openDecisions } from "../src/server/decisions.js";
import { PermissionError } from "../src/modules/identity/index.js";
import {
  GROWTH_ROLE, GrowthError, GrowthService, checkUrl, discoveryQueries, disclosureLine, growthFlags, linkAllowed, scoreOpportunity, similarity,
} from "../src/modules/growth/index.js";
import type { Completer } from "../src/modules/model-gateway/types.js";

const OWNER = "atif@maiz.test";
const good = { site: "examutor", platform: "reddit", name: "r/ASAT", url: "https://www.reddit.com/r/ASAT/", audienceNote: "Digital SAT students", audienceFit: 5, domainQuality: 4, rulesFit: 4, commercial: "limited" } as const;
const rules = { rulesSummary: "No self-promotion posts. Helpful replies with disclosed affiliation are allowed. Links only when relevant." };
const thread = { threadUrl: "https://www.reddit.com/r/ASAT/comments/abc/how_do_i_pace_the_math_module/", threadSummary: "Asking how to pace the Digital SAT math module" };
const LONG = "Pacing the Digital SAT math module is mostly about deciding early which questions to skip and return to. Spend about ninety seconds on each first pass, flag anything slower, and use the remaining minutes on the flagged ones. Practise with a timer so the rhythm feels normal on the day. {{LINK}}";

describe("role text", () => {
  it("keeps the owner's wording on permissions and Reddit", () => {
    for (const line of ["Never bypass CAPTCHAs, rate limits, access restrictions or platform moderation.", "Never use multiple accounts to manipulate discussions.", "Do not insert promotional links into unrelated conversations.", "Disclose affiliation whenever relevant.", "Never mass-post identical content.", "Creating new accounts.", "Sending guest-post pitches.", "Making commitments on behalf of the company.", "Publishing promotional content externally."])
      expect(GROWTH_ROLE).toContain(line);
  });
});

describe("growth rules", () => {
  it("scores places and zeroes out the wrong audience or forbidden ones", () => {
    expect(scoreOpportunity({ audienceFit: 5, domainQuality: 5, rulesFit: 5, commercial: "yes" })).toMatchObject({ score: 100, band: "strong" });
    expect(scoreOpportunity({ audienceFit: 5, domainQuality: 4, rulesFit: 0, commercial: "yes" }).band).toBe("skip");
    expect(scoreOpportunity({ audienceFit: 1, domainQuality: 5, rulesFit: 5, commercial: "yes" }).score).toBe(0);
    expect(scoreOpportunity({ audienceFit: 3, domainQuality: 2, rulesFit: 3, commercial: "no" }).reasons.join()).toMatch(/low-quality/);
    expect(scoreOpportunity({ audienceFit: 4, domainQuality: 3, rulesFit: 3, commercial: "limited" }).band).toBe("worth_a_try");
  });
  it("allows a link only where the place and the audience fit allow it", () => {
    expect(linkAllowed({ commercial: "limited", audienceFit: 4, rulesFit: 4 })).toBe(true);
    for (const o of [{ commercial: "no", audienceFit: 5, rulesFit: 5 }, { commercial: "unknown", audienceFit: 5, rulesFit: 5 }, { commercial: "yes", audienceFit: 2, rulesFit: 5 }] as const)
      expect(linkAllowed(o)).toBe(false);
  });
  it("accepts only public https links on the right host", () => {
    expect(checkUrl("https://old.reddit.com/r/x", "reddit")).toContain("reddit.com");
    for (const bad of ["http://reddit.com/r/x", "https://127.0.0.1/x", "https://localhost/x", "https://user:pw@reddit.com/x", "javascript:alert(1)", "nope"]) expect(() => checkUrl(bad)).toThrow(GrowthError);
    expect(() => checkUrl("https://evil.com/r/x", "reddit")).toThrow(/not a Reddit/);
  });
  it("detects near-duplicate text and ignores links", () => {
    expect(similarity(LONG, LONG.replace("{{LINK}}", "https://a.co"))).toBeGreaterThan(0.9);
    expect(similarity(LONG, "A completely different answer about vocabulary flashcards and reading passages for the verbal section.")).toBeLessThan(0.2);
  });
  it("flags generic writing, fake engagement and commitments", () => {
    expect(growthFlags("examutor", "In today's fast-paced world, unlock the power of prep").flags.join()).toMatch(/generic AI/);
    expect(growthFlags("examutor", "Please upvote this and ask friends to comment").flags.join()).toMatch(/fakes engagement/);
    const c = growthFlags("maizagents", "We promise to give your readers an exclusive discount");
    expect(c.commitment).toBe(true);
    expect(growthFlags("maizagents", "Here is how I do my bookkeeping each week.").flags).toEqual([]);
  });
  it("suggests search phrases for each site and platform without browsing", () => {
    for (const k of ["mocktestroom", "examutor", "maizagents"] as const) {
      const q = discoveryQueries(k);
      expect(new Set(q.map((x) => x.platform))).toEqual(new Set(["reddit", "quora", "linkedin", "forum", "blog"]));
    }
  });
  it("builds the disclosure line from the site", () => {
    expect(disclosureLine("examutor")).toContain("Examutor (https://examutor.com)");
  });
});

function service(completer?: Completer) {
  const clock = { d: new Date("2026-11-20T09:00:00Z") };
  let pokes = 0;
  const svc = new GrowthService((u) => u === "owner", { now: () => clock.d, completer, notifyOwner: () => { pokes += 1; } });
  const ready = async (extra: Record<string, unknown> = {}) => {
    const o = svc.addOpportunity("owner", { ...good, ...extra });
    svc.updateOpportunity("owner", o.id, rules);
    return o;
  };
  const account = (platform = "reddit", handle = "examutor_founder") => {
    const a = svc.raiseApproval("owner", { kind: "account", platform, summary: `Account for ${platform}` });
    svc.decideApproval("owner", a.id, true);
    return svc.registerAccount("owner", { platform, handle });
  };
  const model = (text: string): Completer => ({ complete: async () => ({ text, provider: "runpod", model: "qwen", inputTokens: 1, outputTokens: 1 }) });
  return { svc, clock, pokes: () => pokes, ready, account, model };
}

describe("growth service", () => {
  it("is owner only", async () => {
    const { svc } = service();
    expect(() => svc.opportunities("x")).toThrow(PermissionError);
    expect(() => svc.addOpportunity("x", good)).toThrow(PermissionError);
    await expect(svc.draft("x", {})).rejects.toThrow(PermissionError);
    expect(() => svc.waiting("x")).toThrow(PermissionError);
  });

  it("keeps a scored database of places and refuses duplicates", () => {
    const { svc } = service();
    const o = svc.addOpportunity("owner", good);
    expect(o).toMatchObject({ score: 85, band: "strong", status: "researched" });
    expect(() => svc.addOpportunity("owner", good)).toThrow(/already in the list/);
    expect(() => svc.addOpportunity("owner", { ...good, url: "https://example.com/x", platform: "reddit" })).toThrow(/not a Reddit/);
    svc.addOpportunity("owner", { ...good, name: "Weak", url: "https://www.reddit.com/r/weak/", audienceFit: 4, domainQuality: 1, rulesFit: 2, commercial: "no" });
    expect(svc.opportunities("owner")[0]!.id).toBe(o.id);
    expect(svc.updateOpportunity("owner", o.id, { rulesFit: 0 }).band).toBe("skip");
  });

  it("will not draft before the place's rules are read, or for a low-scoring or banned place", async () => {
    const { svc, ready, account } = service();
    account();
    const o = svc.addOpportunity("owner", good);
    await expect(svc.draft("owner", { opportunityId: o.id, ...thread })).rejects.toThrow(/read the place's rules/);
    svc.updateOpportunity("owner", o.id, rules);
    svc.updateOpportunity("owner", o.id, { status: "banned" });
    await expect(svc.draft("owner", { opportunityId: o.id, ...thread })).rejects.toThrow(/does not allow us/);
    const low = await ready({ name: "Low", url: "https://www.reddit.com/r/low/", audienceFit: 1 });
    await expect(svc.draft("owner", { opportunityId: low.id, ...thread })).rejects.toThrow(/scores too low/);
  });

  it("needs an approved, recorded account, and allows only one per platform", async () => {
    const { svc, ready, account } = service(service().model(LONG));
    const o = await ready();
    await expect(svc.draft("owner", { opportunityId: o.id, ...thread })).rejects.toThrow(/account first/);
    expect(() => svc.registerAccount("owner", { platform: "reddit", handle: "someone" })).toThrow(/needs your approval/);
    expect(account().handle).toBe("examutor_founder");
    const again = svc.raiseApproval("owner", { kind: "account", platform: "reddit", summary: "Another account" });
    svc.decideApproval("owner", again.id, true);
    expect(() => svc.registerAccount("owner", { platform: "reddit", handle: "second_one" })).toThrow(/Several accounts are not allowed/);
    const rej = svc.raiseApproval("owner", { kind: "account", platform: "quora", summary: "Quora" });
    svc.decideApproval("owner", rej.id, false);
    expect(() => svc.registerAccount("owner", { platform: "quora", handle: "nope" })).toThrow(/needs your approval/);
    expect(() => svc.raiseApproval("owner", { kind: "account", summary: "no platform" })).toThrow(/platform/);
  });

  it("writes a contribution for one discussion, adds the disclosure and tracked link, and queues it for approval", async () => {
    const s = service(service().model(LONG));
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread, brief: "Help with pacing" });
    expect(d.status).toBe("awaiting_approval");
    expect(d.approvalKind).toBe("publish");
    expect(d.includesLink).toBe(true);
    expect(d.body).toContain("utm_source=maiz-promoter");
    expect(d.body).toContain("Disclosure: I run Examutor (https://examutor.com)");
    expect(d.writtenBy).toBe("qwen");
    expect(s.pokes()).toBe(2); // the account request and the draft
    expect(s.svc.waiting("owner").items).toHaveLength(1);
  });

  it("strips the link where the place forbids promotion", async () => {
    const s = service(service().model(LONG));
    s.account();
    const o = await s.ready({ commercial: "no" });
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    expect(d.includesLink).toBe(false);
    expect(d.body).not.toMatch(/https?:\/\/(?!examutor\.com\))/);
    expect(d.body).not.toContain("{{LINK}}");
  });

  it("refuses a second draft that copies an earlier one", async () => {
    const s = service(service().model(LONG));
    s.account();
    const a = await s.ready();
    const b = await s.ready({ name: "r/SAT", url: "https://www.reddit.com/r/Sat/" });
    await s.svc.draft("owner", { opportunityId: a.id, ...thread });
    await expect(s.svc.draft("owner", { opportunityId: b.id, ...thread })).rejects.toThrow(/too close to an earlier draft/);
  });

  it("falls back to a labelled template with no model", async () => {
    const s = service();
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    expect(d.writtenBy).toBe("template");
  });

  it("enforces the Reddit limits: three a day and one visit a week to each place", async () => {
    const texts = ["alpha one two three four five six seven eight nine ten", "beta eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen", "gamma nineteen twenty twentyone twentytwo twentythree twentyfour", "delta twentyfive twentysix twentyseven twentyeight twentynine thirty"];
    let n = 0;
    const s = service({ complete: async () => ({ text: `${texts[n++ % 4]!} ${"padding words here to make this long enough ".repeat(4)}${texts[(n + 1) % 4]!.split(" ").reverse().join(" ")}`, provider: "r", model: "m", inputTokens: 1, outputTokens: 1 }) });
    s.account();
    const places = [];
    for (let i = 0; i < 4; i++) places.push(await s.ready({ name: `r/p${i}`, url: `https://www.reddit.com/r/p${i}/` }));
    const items: Awaited<ReturnType<typeof s.svc.draft>>[] = [];
    for (const p of places) items.push(await s.svc.draft("owner", { opportunityId: p.id, ...thread, brief: `Brief ${items.length}` }));
    for (const i of items.slice(0, 3)) s.svc.decide("owner", i.id, true);
    expect(() => s.svc.decide("owner", items[3]!.id, true)).toThrow(/at most 3 Reddit contributions a day/);
    s.clock.d = new Date("2026-11-22T09:00:00Z");
    expect(s.svc.decide("owner", items[3]!.id, true).status).toBe("approved");
  });

  it("will not contribute to the same place twice within a week", async () => {
    let n = 0;
    const variants = ["First reply about pacing and skipping hard questions early then returning with spare minutes to check the flagged ones calmly.", "Second thought on reviewing errors: keep an error log by skill, sort mistakes into careless and conceptual, and revisit them every weekend with fresh problems."];
    const s = service({ complete: async () => ({ text: variants[n++ % 2]!.padEnd(130, " more detail"), provider: "r", model: "m", inputTokens: 1, outputTokens: 1 }) });
    s.account();
    const o = await s.ready();
    const a = await s.svc.draft("owner", { opportunityId: o.id, ...thread, brief: "a" });
    const b = await s.svc.draft("owner", { opportunityId: o.id, ...thread, brief: "b" });
    s.svc.decide("owner", a.id, true);
    expect(() => s.svc.decide("owner", b.id, true)).toThrow(/in the last 7 days/);
  });

  it("requires an explicit OK for a draft that commits the company", async () => {
    const s = service(service().model("We promise to give your readers an exclusive discount if they sign up this week, and here is a long useful answer about pacing the module so it passes the length check easily."));
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    expect(d.commitment).toBe(true);
    expect(() => s.svc.decide("owner", d.id, true)).toThrow(/commitment/);
    expect(s.svc.decide("owner", d.id, true, true).status).toBe("approved");
  });

  it("handles guest pitches: approval kind, no account needed, follow-up set, no auto-send", async () => {
    const s = service(service().model("Subject: Guest post idea\n\nHello, I would like to write about pacing the Digital SAT for your readers. Working title: Finish every section on time. Three points: skip and return, ninety seconds a question, practise with a timer. {{LINK}}"));
    const o = await s.ready({ platform: "blog", name: "Prep Blog", url: "https://prepblog.co.uk/write-for-us", commercial: "yes" });
    await expect(s.svc.draft("owner", { opportunityId: o.id, mode: "contribution", ...thread })).rejects.toThrow();
    const d = await s.svc.draft("owner", { opportunityId: o.id });
    expect(d).toMatchObject({ mode: "guest_pitch", approvalKind: "guest_pitch", subject: "Guest post idea", status: "awaiting_approval" });
    await expect(Promise.resolve().then(() => s.svc.markPublished("owner", d.id, {}))).rejects.toThrow(/approved/);
    s.svc.decide("owner", d.id, true);
    const p = s.svc.markPublished("owner", d.id, {});
    expect(p.kind).toBe("pitched");
    expect(new Date(p.followUp!.dueAt).getTime() - s.clock.d.getTime()).toBe(7 * 86_400_000);
    expect(s.svc.overview("owner").followUpsDue).toHaveLength(0);
    s.clock.d = new Date("2026-11-28T09:00:00Z");
    expect(s.svc.overview("owner").followUpsDue).toHaveLength(1);
    expect(s.svc.setFollowUp("owner", p.id, { done: true }).followUp!.done).toBe(true);
  });

  it("records publication, verification, backlinks, referral traffic and leads in a report", async () => {
    const s = service(service().model(LONG));
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    expect(() => s.svc.markPublished("owner", d.id, { url: "https://www.reddit.com/r/ASAT/comments/abc/x/zz/" })).toThrow(/approved/);
    s.svc.decide("owner", d.id, true);
    expect(() => s.svc.markPublished("owner", d.id, { url: "http://www.reddit.com/x" })).toThrow(/https/);
    const p = s.svc.markPublished("owner", d.id, { url: "https://www.reddit.com/r/ASAT/comments/abc/how/zz/" });
    expect(p).toMatchObject({ kind: "published", account: "examutor_founder", backlinkStatus: "none" });
    expect(() => s.svc.verify("owner", p.id, { live: false })).toThrow(/saw the content live/);
    s.svc.verify("owner", p.id, { live: true, backlinkStatus: "nofollow", backlinkUrl: "https://www.reddit.com/r/ASAT/comments/abc/how/zz/" });
    s.svc.recordMetrics("owner", p.id, { referralVisits: 42, engagement: 17, leads: 3 });
    expect(() => s.svc.recordMetrics("owner", p.id, { leads: -1 })).toThrow(/zero or more/);
    expect(s.svc.report("owner").find((r) => r.site === "examutor")).toEqual({ site: "examutor", published: 1, pitched: 0, verified: 1, backlinks: 1, dofollow: 0, referralVisits: 42, engagement: 17, leads: 3 });
    expect(s.svc.report("owner").find((r) => r.site === "maizagents")!.published).toBe(0);
    expect(() => s.svc.edit("owner", d.id, { body: "late edit" })).toThrow(/already gone out/);
  });

  it("treats different spellings of one place as one place", async () => {
    const s = service();
    s.svc.addOpportunity("owner", good);
    for (const url of ["https://reddit.com/r/asat", "https://old.reddit.com/r/ASAT/", "https://www.reddit.com/r/ASAT/?utm=1", "https://www.reddit.com/r/ASAT/top"])
      expect(() => s.svc.addOpportunity("owner", { ...good, url })).toThrow(/already in the list/);
  });

  it("shares the one-visit-a-week limit across sites for the same community", async () => {
    let n = 0;
    const variants = ["First reply about pacing and skipping hard questions early then returning with spare minutes to check the flagged ones calmly and carefully.", "Second thought on reviewing errors: keep an error log by skill, sort mistakes into careless and conceptual, and revisit them every weekend with fresh problems."];
    const s = service({ complete: async () => ({ text: variants[n++ % 2]!.padEnd(140, " more detail"), provider: "r", model: "m", inputTokens: 1, outputTokens: 1 }) });
    s.account();
    const a = await s.ready();
    const b = await s.ready({ site: "mocktestroom", url: "https://reddit.com/r/asat/" });
    const da = await s.svc.draft("owner", { opportunityId: a.id, ...thread, brief: "a" });
    const db = await s.svc.draft("owner", { opportunityId: b.id, ...thread, brief: "b" });
    s.svc.decide("owner", da.id, true);
    expect(() => s.svc.decide("owner", db.id, true)).toThrow(/in the last 7 days/);
  });

  it("writes only replies on conversation platforms, so articles cannot skip the Reddit rules", async () => {
    const s = service(service().model(LONG));
    const o = await s.ready();
    await expect(s.svc.draft("owner", { opportunityId: o.id, mode: "article" })).rejects.toThrow(/only writes replies/);
    await expect(s.svc.draft("owner", { opportunityId: o.id, mode: "guest_pitch" })).rejects.toThrow(/only writes replies/);
  });

  it("re-checks the rules when a draft is edited: disclosure, links, duplicates, rejected drafts", async () => {
    const texts = [LONG, "Different advice entirely: keep a log of every mistake by skill, sort them into careless and conceptual errors, and revisit that log each weekend with fresh practice problems. {{LINK}}", "Vocabulary matters less than people think on this test; spend your evenings on grid-in practice, learn the calculator shortcuts, and rehearse the last five minutes of each module until it is automatic."];
    let n = 0;
    const s = service({ complete: async () => ({ text: texts[n++ % 3]!, provider: "r", model: "m", inputTokens: 1, outputTokens: 1 }) });
    s.account();
    const a = await s.ready();
    const b = await s.ready({ name: "r/SAT", url: "https://www.reddit.com/r/Sat/" });
    const da = await s.svc.draft("owner", { opportunityId: a.id, ...thread, brief: "a" });
    const db = await s.svc.draft("owner", { opportunityId: b.id, ...thread, brief: "b" });
    expect(() => s.svc.edit("owner", da.id, { body: "No disclosure here, just a long enough answer about pacing the module and skipping hard questions early." })).toThrow(/disclosure/);
    expect(() => s.svc.edit("owner", da.id, { body: `${da.body}\nSee https://evil.example/x` })).toThrow(/only link allowed/);
    expect(() => s.svc.edit("owner", db.id, { body: da.body })).toThrow(/too close/);
    s.svc.decide("owner", db.id, false);
    expect(() => s.svc.edit("owner", db.id, { body: db.body })).toThrow(/stays rejected/);
    const noLink = await s.ready({ name: "r/nolinks", url: "https://www.reddit.com/r/nolinks/", commercial: "no" });
    const dn = await s.svc.draft("owner", { opportunityId: noLink.id, ...thread, brief: "c" });
    expect(() => s.svc.edit("owner", dn.id, { body: `${dn.body}\nhttps://examutor.com/?utm=1` })).toThrow(/does not allow links/);
  });

  it("removes any web address the model writes that is not the tracked link", async () => {
    const s = service(service().model(`${LONG} Also see https://spam.example/offer for more.`));
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    expect(d.body).not.toContain("spam.example");
    expect(d.flags.join()).toMatch(/web address that was removed/);
  });

  it("makes any warning need a tick, and keeps a banned place closed", async () => {
    const s = service(service().model(`In today's fast-paced world, here is a long answer about pacing the Digital SAT math module: skip early, return later, keep a timer running, and review your errors every weekend. {{LINK}}`));
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    expect(d.flags.length).toBeGreaterThan(0);
    expect(() => s.svc.decide("owner", d.id, true)).toThrow(/warnings/);
    expect(s.svc.decide("owner", d.id, true, true).status).toBe("approved");
    s.svc.updateOpportunity("owner", o.id, { status: "banned" });
    expect(() => s.svc.updateOpportunity("owner", o.id, { status: "researched" })).toThrow(/stays closed/);
  });

  it("shows waiting drafts and permission requests on the decisions page", async () => {
    const s = service(service().model(LONG));
    s.account();
    const o = await s.ready();
    const d = await s.svc.draft("owner", { opportunityId: o.id, ...thread });
    const a = s.svc.raiseApproval("owner", { kind: "commitment", summary: "Offer a partner discount to a forum" });
    const open = openDecisions({ reviews: [], specialists: [], growth: s.svc.waiting("owner") }, Date.parse("2026-11-20T12:00:00Z"));
    expect(open.map((x) => x.id).sort()).toEqual([a.id, d.id].sort());
  });
});

describe("growth HTTP routes", () => {
  function setup() {
    const clock = { d: new Date("2026-11-20T09:00:00Z") };
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const bearer = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
    return { call, owner: bearer(OWNER), other: bearer("someone@else.test") };
  }
  it("refuses everyone but the platform owner", async () => {
    const { call, other } = setup();
    expect((await call("GET", "/api/owner/growth", undefined, other)).status).toBe(403);
    expect((await call("POST", "/api/owner/growth/opportunities", good, other)).status).toBe(403);
    expect((await call("GET", "/api/owner/growth")).status).toBe(401);
  });
  it("runs research to publication end to end", async () => {
    const { call, owner } = setup();
    const first = (await call("GET", "/api/owner/growth", undefined, owner)).body as any;
    expect(first.role).toContain("Content Distribution & Community Growth Manager");
    expect(first.discovery.examutor.length).toBeGreaterThan(5);
    const added = (await call("POST", "/api/owner/growth/opportunities", good, owner)).body as any;
    const opp = added.opportunities[0];
    expect((await call("POST", "/api/owner/growth/drafts", { opportunityId: opp.id, ...thread }, owner)).status).toBe(400);
    await call("POST", `/api/owner/growth/opportunities/${opp.id}/update`, rules, owner);
    const ap = ((await call("POST", "/api/owner/growth/approvals", { kind: "account", platform: "reddit", summary: "Reddit account for the founder" }, owner)).body as any).approvals[0];
    await call("POST", `/api/owner/growth/approvals/${ap.id}/decide`, { approve: true }, owner);
    expect((await call("POST", "/api/owner/growth/accounts", { platform: "reddit", handle: "founder_account" }, owner)).status).toBe(201);
    const drafted = await call("POST", "/api/owner/growth/drafts", { opportunityId: opp.id, ...thread, brief: "Help with pacing the math module" }, owner);
    expect(drafted.status).toBe(201);
    const item = (drafted.body as any).items[0];
    expect((await call("POST", `/api/owner/growth/drafts/${item.id}/published`, { url: "https://www.reddit.com/r/ASAT/comments/abc/x/" }, owner)).status).toBe(400);
    expect((await call("POST", `/api/owner/growth/drafts/${item.id}/approve`, {}, owner)).status).toBe(200);
    const pub = (await call("POST", `/api/owner/growth/drafts/${item.id}/published`, { url: "https://www.reddit.com/r/ASAT/comments/abc/x/" }, owner)).body as any;
    const id = pub.publications[0].id;
    await call("POST", `/api/owner/growth/publications/${id}/verify`, { live: true, backlinkStatus: "nofollow" }, owner);
    const m = (await call("POST", `/api/owner/growth/publications/${id}/metrics`, { referralVisits: 5, leads: 1 }, owner)).body as any;
    expect(m.report.find((r: any) => r.site === "examutor")).toMatchObject({ published: 1, verified: 1, referralVisits: 5, leads: 1 });
  });
});
