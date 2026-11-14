import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { TEMPLATES } from "../src/modules/workforce/templates.js";
import { openDecisions } from "../src/server/decisions.js";
import { PermissionError } from "../src/modules/identity/index.js";
import {
  OWNER_SPECIALISTS, PromoterError, PromoterService, SITES, SITE_KEYS, checkLead, checkPlanInput, copyFlags, knowledgeText, planCampaign, sendProblems, trackedLink,
  type SendCheckInput,
} from "../src/modules/promoter/index.js";
import type { Completer } from "../src/modules/model-gateway/types.js";

const OWNER = "atif@maiz.test";
const plan = { site: "examutor", goal: "More Digital SAT sign-ups", budgetGbp: 300, weeks: 8, startDate: "2026-11-23" } as const;

describe("knowledge of the three sites", () => {
  it("covers exactly the three sites and keeps unconfirmed facts out of prompts as facts", () => {
    expect([...SITE_KEYS]).toEqual(["mocktestroom", "examutor", "maizagents"]);
    for (const k of SITE_KEYS) expect(SITES[k].url).toMatch(/^https:\/\//);
    const text = knowledgeText(SITES.mocktestroom);
    expect(text).toContain("NOT CONFIRMED");
    expect(SITES.mocktestroom.pricing.some((f) => f.status === "to_confirm")).toBe(true);
    expect(knowledgeText(SITES.examutor, ["Sprint is on sale"])).toContain("Sprint is on sale");
  });
  it("records the College Board and exam-body disclaimers as things never to claim", () => {
    expect(SITES.examutor.doNotClaim.join(" ")).toMatch(/College Board/);
    expect(SITES.mocktestroom.doNotClaim.join(" ")).toMatch(/Pearson/);
  });
});

describe("campaign plans", () => {
  it("is deterministic and its channel budgets add up to the budget", () => {
    const a = planCampaign(checkPlanInput(plan));
    const b = planCampaign(checkPlanInput(plan));
    expect(a).toEqual(b);
    expect(Math.round(a.channels.reduce((s, c) => s + c.budgetGbp, 0) * 100) / 100).toBe(300);
    expect(a.calendar).toHaveLength(8);
    expect(a.calendar[1]!.startsOn).toBe("2026-11-30");
    expect(a.kpis.length).toBeGreaterThan(3);
  });
  it("plans no paid ads under £150 and caps ads at 40% above it", () => {
    expect(planCampaign(checkPlanInput({ ...plan, budgetGbp: 100 })).channels.some((c) => c.channel === "paid_ads")).toBe(false);
    const ads = planCampaign(checkPlanInput(plan)).channels.find((c) => c.channel === "paid_ads")!;
    expect(ads.sharePercent).toBeLessThanOrEqual(40);
  });
  it("uses free channels only at £0", () => {
    const p = planCampaign(checkPlanInput({ ...plan, budgetGbp: 0 }));
    expect(p.channels.every((c) => c.budgetGbp === 0)).toBe(true);
    expect(p.channels.some((c) => c.channel === "paid_ads")).toBe(false);
  });
  it("rejects bad input", () => {
    for (const bad of [{ ...plan, site: "other" }, { ...plan, goal: "" }, { ...plan, budgetGbp: -1 }, { ...plan, weeks: 0 }, { ...plan, weeks: 99 }, { ...plan, startDate: "tomorrow" }])
      expect(() => checkPlanInput(bad)).toThrow(PromoterError);
  });
  it("builds tracking links on the right site", () => {
    const l = new URL(trackedLink("maizagents", "Launch Week!", "social", "Post 1"));
    expect(l.origin).toBe("https://maizagents.com");
    expect(l.searchParams.get("utm_campaign")).toBe("launch-week");
    expect(l.searchParams.get("utm_medium")).toBe("social");
  });
});

describe("anti-spam rules", () => {
  const lead = { email: "A@Firm.co.uk", kind: "business", basis: "b2b_legitimate_interest", source: "Met at a networking event", relevance: "Runs a small accountancy practice" };
  it("refuses bought, scraped and harvested contacts", () => {
    for (const source of ["scraped from LinkedIn", "bought list", "harvested emails", "purchased from a broker"])
      expect(() => checkLead({ ...lead, source })).toThrow(/not allowed/);
  });
  it("only allows no-consent business email to company addresses, with a reason", () => {
    expect(checkLead(lead).email).toBe("a@firm.co.uk");
    expect(() => checkLead({ ...lead, email: "someone@gmail.com" })).toThrow(/webmail/);
    expect(() => checkLead({ ...lead, kind: "individual" })).toThrow(/only allowed for companies/);
    expect(() => checkLead({ ...lead, relevance: "" })).toThrow(/relevant/);
    expect(checkLead({ ...lead, kind: "individual", basis: "consent", email: "x@gmail.com" }).basis).toBe("consent");
  });
  const base: SendCheckInput = { basis: "consent", kind: "individual", optedOut: false, replied: false, step: 0, body: "Hi", subject: "Hello", hasUnsubscribe: true, hasSender: true, now: new Date("2026-11-20T10:00:00Z"), sentToday: 0, coldSentToday: 0 };
  it("lists every reason an email must not go", () => {
    expect(sendProblems(base)).toEqual([]);
    expect(sendProblems({ ...base, optedOut: true })).toHaveLength(1);
    expect(sendProblems({ ...base, hasUnsubscribe: false })[0]).toMatch(/unsubscribe/);
    expect(sendProblems({ ...base, hasSender: false })[0]).toMatch(/postal address/);
    expect(sendProblems({ ...base, subject: "Re: your order" })[0]).toMatch(/pretend/);
    expect(sendProblems({ ...base, step: 3, previousSentAt: "2026-11-01T00:00:00Z" }).join()).toMatch(/at most 2/);
    expect(sendProblems({ ...base, step: 1, previousSentAt: "2026-11-18T10:00:00Z" })[0]).toMatch(/5 days/);
    expect(sendProblems({ ...base, step: 1 })[0]).toMatch(/earlier email/);
    expect(sendProblems({ ...base, step: 1, replied: true, previousSentAt: "2026-11-01T00:00:00Z" })[0]).toMatch(/replied/);
    expect(sendProblems({ ...base, sentToday: 50 })[0]).toMatch(/50 emails a day/);
    expect(sendProblems({ ...base, basis: "b2b_legitimate_interest", kind: "business", coldSentToday: 20 })[0]).toMatch(/20 first-contact/);
  });
  it("flags risky claims without blocking", () => {
    expect(copyFlags("examutor", "A guaranteed 700+ score, official College Board partner")).toEqual(expect.arrayContaining(["promises a guaranteed result"]));
    expect(copyFlags("mocktestroom", "Trusted by 5000 students")).toContain("states a number of users that must be confirmed");
    expect(copyFlags("examutor", "Great for age 10 children")).toContain("aims at children under 13");
    expect(copyFlags("maizagents", "Try the free trial. No card.")).toEqual([]);
  });
});

function service(opts: { completer?: Completer; fail?: boolean } = {}) {
  const clock = { d: new Date("2026-11-20T09:00:00Z") };
  const sent: { to: string; subject: string; text: string }[] = [];
  let pokes = 0;
  const svc = new PromoterService((u) => u === "owner", {
    now: () => clock.d, completer: opts.completer,
    send: async (m) => { if (opts.fail) throw new Error("boom"); sent.push(m); },
    unsubscribeUrl: (t) => `https://x.test/unsubscribe.html#t=${t}`,
    sender: { name: "MAIZ AI Ltd", address: "20 Wenlock Road, London, N1 7GU" },
    notifyOwner: () => { pokes += 1; },
  });
  return { svc, clock, sent, pokes: () => pokes };
}
const lead = { email: "pat@firm.co.uk", name: "Pat", kind: "business", basis: "b2b_legitimate_interest", source: "Met at an event", relevance: "Runs an accountancy practice" };

describe("promoter service", () => {
  it("is owner only", async () => {
    const { svc } = service();
    expect(() => svc.knowledge("someone")).toThrow(PermissionError);
    expect(() => svc.createCampaign("someone", plan)).toThrow(PermissionError);
    await expect(svc.draft("someone", { site: "examutor", channel: "social" })).rejects.toThrow(PermissionError);
    expect(() => svc.waiting("someone")).toThrow(PermissionError);
  });

  it("drafts with the model, using the site's knowledge, and waits for approval", async () => {
    const seen: string[] = [];
    const completer: Completer = { complete: async (req) => { seen.push(req.messages.map((m) => m.content).join("\n"), String(req.taskType)); return { text: "Free SAT practice: {{LINK}}", provider: "runpod", model: "qwen", inputTokens: 1, outputTokens: 1 }; } };
    const { svc, pokes } = service({ completer });
    svc.addFact("owner", "examutor", "Sprint is half price this week");
    const d = await svc.draft("owner", { site: "examutor", channel: "social", brief: "A study tip" });
    expect(d.status).toBe("awaiting_approval");
    expect(d.writtenBy).toBe("qwen");
    expect(d.body).toContain("https://examutor.com/?utm_source=maiz-promoter");
    expect(seen[0]).toContain("Sprint is half price this week");
    expect(seen[0]).toContain("College Board");
    expect(seen[1]).toBe("promoter");
    expect(pokes()).toBe(1);
    expect(svc.waiting("owner").drafts).toHaveLength(1);
  });

  it("falls back to a template when the model fails or is missing", async () => {
    const broken: Completer = { complete: async () => { throw new Error("down"); } };
    for (const completer of [undefined, broken]) {
      const { svc } = service({ completer });
      const d = await svc.draft("owner", { site: "maizagents", channel: "social", brief: "Build in public" });
      expect(d.writtenBy).toBe("template");
      expect(d.body).toContain("maizagents.com");
    }
  });

  it("will not send unapproved, edited-after-approval or non-email drafts", async () => {
    const { svc, sent } = service();
    const l = svc.addLead("owner", "examutor", { ...lead, basis: "consent", kind: "individual", email: "kid.parent@gmail.com", source: "Signed up for tips" });
    const d = await svc.draft("owner", { site: "examutor", channel: "email", leadId: l.id, brief: "Welcome" });
    await expect(svc.send("owner", d.id)).rejects.toThrow(/approved/);
    svc.decide("owner", d.id, true);
    svc.edit("owner", d.id, { body: "Changed words {{x}}" });
    expect(svc.items_("owner").find((x) => x.id === d.id)!.status).toBe("awaiting_approval");
    await expect(svc.send("owner", d.id)).rejects.toThrow(/approved/);
    expect(sent).toHaveLength(0);
    const post = await svc.draft("owner", { site: "examutor", channel: "social", brief: "tip" });
    svc.decide("owner", post.id, true);
    await expect(svc.send("owner", post.id)).rejects.toThrow(/only emails/);
    expect(svc.markPosted("owner", post.id, "https://x.com/me/1").status).toBe("posted");
  });

  it("sends an approved email with sender identity and unsubscribe link, then enforces the follow-up rules", async () => {
    const { svc, sent, clock } = service();
    const l = svc.addLead("owner", "maizagents", lead);
    const first = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id, brief: "Intro" });
    svc.decide("owner", first.id, true);
    expect((await svc.send("owner", first.id)).status).toBe("sent");
    expect(sent[0]!.to).toBe("pat@firm.co.uk");
    expect(sent[0]!.text).toContain("MAIZ AI Ltd, 20 Wenlock Road");
    expect(sent[0]!.text).toMatch(/Unsubscribe at any time: https:\/\/x\.test\/unsubscribe\.html#t=[\w-]+/);
    expect(svc.followUpsDue("owner")).toEqual([]);
    clock.d = new Date("2026-11-26T09:00:00Z");
    expect(svc.followUpsDue("owner")).toMatchObject([{ email: "pat@firm.co.uk", nextStep: 1 }]);
    const f1 = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id, step: 1 });
    svc.decide("owner", f1.id, true);
    await svc.send("owner", f1.id);
    clock.d = new Date("2026-12-02T09:00:00Z");
    const f2 = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id, step: 2 });
    svc.decide("owner", f2.id, true);
    await svc.send("owner", f2.id);
    clock.d = new Date("2026-12-20T09:00:00Z");
    expect(svc.followUpsDue("owner")).toEqual([]);
    expect(sent).toHaveLength(3);
  });

  it("sends a step to a person only once, even for two drafts or two presses at once", async () => {
    const { svc, sent } = service();
    const l = svc.addLead("owner", "maizagents", lead);
    const a = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
    const b = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
    svc.decide("owner", a.id, true);
    svc.decide("owner", b.id, true);
    const results = await Promise.allSettled([svc.send("owner", a.id), svc.send("owner", a.id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(svc.send("owner", b.id)).rejects.toThrow(/already got step 1/);
    expect(sent).toHaveLength(1);
  });

  it("will not email someone who replied after the draft was approved", async () => {
    const { svc, sent } = service();
    const l = svc.addLead("owner", "maizagents", lead);
    const d = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
    svc.decide("owner", d.id, true);
    svc.markReplied("owner", l.id);
    await expect(svc.send("owner", d.id)).rejects.toThrow(/replied/);
    expect(sent).toHaveLength(0);
  });

  it("keeps a subject to one line and a lead to one plain address", () => {
    const { svc } = service();
    expect(() => svc.addLead("owner", "maizagents", { ...lead, email: "a@x.co,b@y.co" })).toThrow(/valid email/);
    expect(() => svc.addLead("owner", "maizagents", { ...lead, email: "a@x.co;b@y.co" })).toThrow(/valid email/);
    expect(() => svc.addLead("owner", "maizagents", { ...lead, email: '"a b"@x.co' })).toThrow(/valid email/);
  });

  it("strips line breaks from an edited subject", async () => {
    const { svc } = service();
    const l = svc.addLead("owner", "maizagents", lead);
    const d = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
    expect(svc.edit("owner", d.id, { subject: "Hello\r\nBcc: x@evil.co" }).subject).toBe("Hello Bcc: x@evil.co");
  });

  it("stops everything for a person who unsubscribes, and never re-adds them", async () => {
    const { svc, sent } = service();
    const l = svc.addLead("owner", "maizagents", lead);
    const d = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
    svc.decide("owner", d.id, true);
    const token = [...(svc as any).leads.values()][0].token as string;
    expect(svc.unsubscribe(token)).toBe(true);
    expect(svc.unsubscribe("nope")).toBe(false);
    await expect(svc.send("owner", d.id)).rejects.toThrow(/opted out/);
    expect(sent).toHaveLength(0);
    expect(() => svc.addLead("owner", "examutor", lead)).toThrow(/opted out/);
    await expect(svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id })).rejects.toThrow(/opted out/);
  });

  it("limits first-contact business emails to 20 a day", async () => {
    const { svc, sent } = service();
    for (let i = 0; i < 21; i++) {
      const l = svc.addLead("owner", "maizagents", { ...lead, email: `p${i}@firm${i}.co.uk` });
      const d = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
      svc.decide("owner", d.id, true);
      if (i < 20) await svc.send("owner", d.id);
      else await expect(svc.send("owner", d.id)).rejects.toThrow(/20 first-contact/);
    }
    expect(sent).toHaveLength(20);
  });

  it("marks a failed send as failed and says nothing was delivered", async () => {
    const { svc } = service({ fail: true });
    const l = svc.addLead("owner", "maizagents", lead);
    const d = await svc.draft("owner", { site: "maizagents", channel: "email", leadId: l.id });
    svc.decide("owner", d.id, true);
    await expect(svc.send("owner", d.id)).rejects.toThrow(/Nothing was delivered/);
    expect(svc.items_("owner")[0]!.status).toBe("failed");
  });

  it("holds spend to the approved budget and tracks results", async () => {
    const { svc } = service();
    const c = svc.createCampaign("owner", plan);
    expect(() => svc.recordSpend("owner", c.id, 10, "ads")).toThrow(/approve the campaign/);
    await expect(svc.draft("owner", { site: "examutor", channel: "paid_ads", campaignId: c.id })).rejects.toThrow(/approved campaign/);
    svc.setCampaignStatus("owner", c.id, "approved");
    svc.recordSpend("owner", c.id, 250, "search ads");
    expect(() => svc.recordSpend("owner", c.id, 60, "more")).toThrow(/pass the approved budget/);
    svc.recordResult("owner", c.id, "sign-ups", 10);
    svc.recordResult("owner", c.id, "sign-ups", 15);
    const r = svc.report("owner", c.id);
    expect(r).toMatchObject({ spentGbp: 250, budgetGbp: 300, metrics: [{ metric: "sign-ups", total: 25, costPerGbp: 10 }] });
    expect((await svc.draft("owner", { site: "examutor", channel: "paid_ads", campaignId: c.id })).status).toBe("awaiting_approval");
    svc.setCampaignStatus("owner", c.id, "done");
    await expect(svc.draft("owner", { site: "examutor", channel: "social", campaignId: c.id })).rejects.toThrow(/not running/);
  });

  it("shows decisions to the owner's decisions page", async () => {
    const { svc } = service();
    const c = svc.createCampaign("owner", plan);
    const d = await svc.draft("owner", { site: "maizagents", channel: "social", brief: "Launch post" });
    const open = openDecisions({ reviews: [], specialists: [], promotions: svc.waiting("owner") }, Date.parse("2026-11-20T12:00:00Z"));
    expect(open.map((o) => o.kind)).toEqual(["promotion", "promotion"]);
    expect(open.map((o) => o.id).sort()).toEqual([c.id, d.id].sort());
  });
});

describe("owner's AI team", () => {
  it("lists both owner-only specialists with full job descriptions that keep the approval limits", () => {
    expect(OWNER_SPECIALISTS.map((s) => s.key)).toEqual(["promotion-agent", "community-growth-manager"]);
    for (const s of OWNER_SPECIALISTS) {
      expect(s.jobDescription.key).toBe(s.key);
      expect(s.jobDescription.authority.needsApproval.length).toBeGreaterThan(2);
      expect(s.jobDescription.authority.never.join(" ")).toMatch(/CAPTCHA/);
      expect(s.jobDescription.authority.never.join(" ")).toMatch(/fake accounts/);
      expect(s.jobDescription.responsibilities.length).toBeGreaterThan(2);
    }
    expect(OWNER_SPECIALISTS[1]!.jobDescription.authority.needsApproval).toEqual(["Publishing promotional content externally", "Sending guest-post pitches", "Creating new accounts", "Making commitments on behalf of the company"]);
  });
  it("is not in the client store, any package or the public templates", () => {
    expect(TEMPLATES.some((t) => OWNER_SPECIALISTS.some((s) => s.key === t.key))).toBe(false);
  });
});

describe("promoter HTTP routes", () => {
  function setup() {
    const clock = { d: new Date("2026-11-20T09:00:00Z") };
    const mail = new MemoryEmailSender();
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const bearer = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
    return { call, mail, owner: bearer(OWNER), other: bearer("someone@else.test") };
  }

  it("shows the owner's team with live counts, and refuses everyone else", async () => {
    const { call, owner, other } = setup();
    expect((await call("GET", "/api/owner/team", undefined, other)).status).toBe(403);
    await call("POST", "/api/owner/promoter/campaigns", plan, owner);
    const team = (await call("GET", "/api/owner/team", undefined, owner)).body as any;
    expect(team.specialists.map((s: any) => s.key)).toEqual(["promotion-agent", "community-growth-manager"]);
    expect(team.specialists[0].status.waiting).toBe(1);
    expect(team.specialists[1].status.waiting).toBe(0);
  });

  it("refuses everyone but the platform owner", async () => {
    const { call, other } = setup();
    expect((await call("GET", "/api/owner/promoter", undefined, other)).status).toBe(403);
    expect((await call("POST", "/api/owner/promoter/drafts", { site: "examutor", channel: "social" }, other)).status).toBe(403);
    expect((await call("GET", "/api/owner/promoter")).status).toBe(401);
  });

  it("runs the full flow: plan, lead, draft, approve, send, unsubscribe", async () => {
    const { call, mail, owner } = setup();
    const overview = (await call("GET", "/api/owner/promoter", undefined, owner)).body as any;
    expect(overview.knowledge).toHaveLength(3);
    const camp = await call("POST", "/api/owner/promoter/campaigns", plan, owner);
    expect(camp.status).toBe(201);
    const leadRes = await call("POST", "/api/owner/promoter/leads", { site: "maizagents", ...lead }, owner);
    expect(leadRes.status).toBe(201);
    expect(JSON.stringify(leadRes.body)).not.toContain("token");
    const leadId = (leadRes.body as any).lead.id;
    const dres = await call("POST", "/api/owner/promoter/drafts", { site: "maizagents", channel: "email", leadId, brief: "Intro" }, owner);
    const id = (dres.body as any).draft.id;
    expect((await call("POST", `/api/owner/promoter/drafts/${id}/send`, {}, owner)).status).toBe(400);
    expect((await call("POST", `/api/owner/promoter/drafts/${id}/approve`, {}, owner)).status).toBe(200);
    const prev = await call("GET", `/api/owner/promoter/drafts/${id}/preview`, undefined, owner);
    expect((prev.body as any).preview).toContain("Unsubscribe at any time");
    expect((await call("POST", `/api/owner/promoter/drafts/${id}/send`, {}, owner)).status).toBe(200);
    const sentMail = mail.sent.find((m) => m.to === "pat@firm.co.uk")!;
    const token = /#t=([\w-]+)/.exec(sentMail.text)![1]!;
    expect(sentMail.text).toContain("https://app.test/unsubscribe.html#t=");
    expect((await call("POST", "/api/promoter/unsubscribe", { token })).status).toBe(200);
    expect((await call("POST", "/api/promoter/unsubscribe", { token: "bad" })).status).toBe(404);
    expect((await call("POST", "/api/owner/promoter/leads", { site: "examutor", ...lead }, owner)).status).toBe(400);
    const dec = (await call("GET", "/api/owner/decisions", undefined, owner)).body as any;
    expect(dec.items.some((i: any) => i.kind === "promotion")).toBe(true);
  });
});
