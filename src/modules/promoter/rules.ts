import { SITES, type SiteKey } from "./knowledge.js";

/** Pure rules for the promotion agent: campaign plans, UK anti-spam checks and copy flags. No storage, no AI. */
export class PromoterError extends Error {}

export const CHANNELS = ["email", "social", "content", "seo", "partnership", "affiliate", "community", "paid_ads"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Email to people who agreed to hear from you (or fit the business rules)",
  social: "Social posts (build in public, tips, results)",
  content: "Articles and guides",
  seo: "Search engine fixes",
  partnership: "Partnerships (schools, tutors, accountants, communities)",
  affiliate: "Affiliate and voucher partners",
  community: "Answering questions in forums and groups (by hand, never bulk)",
  paid_ads: "Paid ads (only once you approve a budget)",
};

// ---------------------------------------------------------------- campaign plans

export interface PlanInput {
  site: SiteKey;
  goal: string;
  budgetGbp: number;
  weeks: number;
  /** ISO date (yyyy-mm-dd) of the first Monday or day of the campaign. */
  startDate: string;
}

export interface PlanChannel { channel: Channel; sharePercent: number; budgetGbp: number; why: string }
export interface PlanWeek { week: number; startsOn: string; theme: string; activities: { channel: Channel; what: string }[] }
export interface PlanKpi { metric: string; measuredBy: string; target: string }
export interface CampaignPlan {
  audiences: { name: string; message: string }[];
  channels: PlanChannel[];
  calendar: PlanWeek[];
  kpis: PlanKpi[];
  notes: string[];
}

export const MAX_WEEKS = 26;
export const MAX_BUDGET_GBP = 100_000;
/** Paid ads only make sense with enough money to learn from, and never more than this share of the budget. */
export const MIN_ADS_BUDGET_GBP = 150;
export const MAX_ADS_SHARE = 0.4;

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function checkPlanInput(raw: unknown): PlanInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const site = r.site;
  if (typeof site !== "string" || !(site in SITES)) throw new PromoterError("choose one of the three websites");
  const goal = String(r.goal ?? "").trim();
  if (goal.length < 3 || goal.length > 300) throw new PromoterError("describe the goal in 3 to 300 characters");
  const budgetGbp = Number(r.budgetGbp ?? 0);
  if (!Number.isFinite(budgetGbp) || budgetGbp < 0 || budgetGbp > MAX_BUDGET_GBP) throw new PromoterError(`budget must be between £0 and £${MAX_BUDGET_GBP.toLocaleString("en-GB")}`);
  const weeks = Number(r.weeks ?? 8);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) throw new PromoterError(`weeks must be a whole number from 1 to ${MAX_WEEKS}`);
  const startDate = String(r.startDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))) throw new PromoterError("start date must look like 2026-11-23");
  return { site: site as SiteKey, goal, budgetGbp: Math.round(budgetGbp * 100) / 100, weeks, startDate };
}

const WEEK_THEMES = ["Foundations: fix the basics and set up tracking", "Launch: first posts and first partner outreach", "Proof: share real results and answer questions", "Depth: guides and comparisons that answer searches", "Partners: follow up and widen the list", "Offers: vouchers or trial pushes", "Review: keep what worked, drop what did not", "Repeat the best week"];

/** A plan is arithmetic and templates, not a model's guess: the same inputs always give the same plan. */
export function planCampaign(input: PlanInput): CampaignPlan {
  const site = SITES[input.site];
  const paid = input.budgetGbp >= MIN_ADS_BUDGET_GBP;
  const base: [Channel, number, string][] = input.site === "maizagents"
    ? [["social", 25, "Build in public: how MAIZ AI Ltd runs on MAIZ."], ["content", 20, "One guide per sector page, each aimed at one search phrase."], ["partnership", 20, "Accountants, bookkeepers and small-business groups."], ["affiliate", 15, "Referral partners earn from payments, so you only pay for results."], ["email", 10, "Only to people who agreed, plus a small number of one-to-one business emails."], ["seo", 10, "Search Console, sitemap, titles and sector pages."]]
    : [["content", 30, "Free guides and question pages that answer what students search."], ["social", 20, "Study tips, a question of the day and short results posts."], ["partnership", 20, "Schools, tutors, coaching centres and student communities."], ["email", 15, "Study tips to people who signed up, with a clear unsubscribe."], ["seo", 15, "Titles, descriptions, sitemap and the pages that already almost rank."]];
  const free = input.budgetGbp === 0;
  const adsShare = paid ? Math.min(MAX_ADS_SHARE * 100, 30) : 0;
  const scale = (100 - adsShare) / 100;
  const channels: PlanChannel[] = base.map(([channel, share, why]) => {
    const sharePercent = Math.round(share * scale * 10) / 10;
    return { channel, sharePercent, budgetGbp: free ? 0 : Math.round(input.budgetGbp * (sharePercent / 100) * 100) / 100, why };
  });
  if (paid) channels.push({ channel: "paid_ads", sharePercent: adsShare, budgetGbp: Math.round(input.budgetGbp * (adsShare / 100) * 100) / 100, why: "Test one audience and one message at a time. Nothing is bought until you approve the campaign and set the ads up yourself." });
  // Make the rounded budgets add up to the budget exactly.
  if (!free && channels.length) {
    const diff = Math.round((input.budgetGbp - channels.reduce((s, c) => s + c.budgetGbp, 0)) * 100) / 100;
    channels[0] = { ...channels[0]!, budgetGbp: Math.round((channels[0]!.budgetGbp + diff) * 100) / 100 };
  }
  const active = channels.map((c) => c.channel);
  const calendar: PlanWeek[] = Array.from({ length: input.weeks }, (_, i) => {
    const startsOn = addDays(input.startDate, i * 7);
    const week = i + 1;
    const theme = WEEK_THEMES[Math.min(i, WEEK_THEMES.length - 2)] ?? WEEK_THEMES[0]!;
    const activities: PlanWeek["activities"] = [];
    if (week === 1) activities.push({ channel: "seo", what: "Add tracking links, check Search Console and the sitemap, and fix titles and descriptions." });
    if (active.includes("social")) activities.push({ channel: "social", what: week === 1 ? "Write the first three posts for approval." : "Two or three posts for approval, one built from last week's result." });
    if (active.includes("content") && week % 2 === 0) activities.push({ channel: "content", what: "One guide or article for approval, aimed at one search phrase." });
    if (active.includes("partnership") && week >= 2) activities.push({ channel: "partnership", what: "Five partner pitches for approval, each written for that one person." });
    if (active.includes("email") && week >= 2) activities.push({ channel: "email", what: "A short email to people who agreed to hear from you, then the follow-ups that are due." });
    if (active.includes("affiliate") && week === 3) activities.push({ channel: "affiliate", what: "Invite two or three referral partners and send their links." });
    if (active.includes("paid_ads") && week >= 3) activities.push({ channel: "paid_ads", what: "Ad copy and targeting for approval; you place the ads and report the spend." });
    return { week, startsOn, theme: week === input.weeks && week > 3 ? WEEK_THEMES[6]! : theme, activities };
  });
  const kpis: PlanKpi[] = [
    { metric: "Visits from this campaign", measuredBy: "Tracking links (utm_source, utm_medium, utm_campaign) in your website analytics", target: "Set after week 2 from the real baseline" },
    { metric: site.conversion, measuredBy: "Sign-ups and purchases that came through a tracked link or code", target: "Set after week 2 from the real baseline" },
    { metric: "Cost per conversion", measuredBy: "Money you record as spent divided by conversions", target: free ? "£0 spend: not applicable" : `Stay inside the £${input.budgetGbp} budget` },
    { metric: "Email opt-outs and complaints", measuredBy: "Unsubscribe count against emails sent", target: "Under 1 opt-out in 100 emails; any complaint is looked at the same day" },
    { metric: "Replies and partner meetings", measuredBy: "Replies you log against each pitch", target: "Set after week 2 from the real baseline" },
  ];
  const notes = [
    "Targets are left open on purpose: with no past data any number would be a guess. The agent proposes them after two weeks of real results.",
    "Nothing is sent, posted or spent without your approval. Posts and ads are drafts you publish yourself.",
    ...(free ? ["Budget is £0, so the plan uses free channels only."] : []),
    ...(!free && !paid ? [`Below £${MIN_ADS_BUDGET_GBP} there is too little to learn from paid ads, so none are planned.`] : []),
    ...(input.site === "examutor" ? ["Examutor is for students aged 13 and over; promote to parents for under-18s."] : []),
  ];
  return { audiences: site.audiences.map((a) => ({ name: a.name, message: a.message })), channels, calendar, kpis, notes };
}

// ---------------------------------------------------------------- tracking links

export function trackedLink(site: SiteKey, campaign: string, channel: Channel, content?: string): string {
  const u = new URL(SITES[site].url);
  u.searchParams.set("utm_source", "maiz-promoter");
  u.searchParams.set("utm_medium", channel);
  u.searchParams.set("utm_campaign", campaign.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "campaign");
  if (content) u.searchParams.set("utm_content", content.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
  return u.toString();
}

// ---------------------------------------------------------------- leads and anti-spam

export const LEAD_BASES = ["consent", "soft_opt_in", "b2b_legitimate_interest", "existing_contact"] as const;
export type LeadBasis = (typeof LEAD_BASES)[number];
export const LEAD_BASIS_LABEL: Record<LeadBasis, string> = {
  consent: "They asked to hear from us",
  soft_opt_in: "Existing customer, similar product, offered an opt-out when they signed up",
  b2b_legitimate_interest: "A company (not a sole trader) emailed about something relevant to their job",
  existing_contact: "Someone who already wrote to us first",
};
export type LeadKind = "business" | "individual";

/** Where a lead came from. Bought and scraped lists are refused: they are not lawful for email. */
export const BANNED_SOURCES = /\b(scrap(e|ed|ing)|bought|purchased|harvest(ed)?|rented|list broker|data broker|bulk list)\b/i;
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com", "live.com", "aol.com", "proton.me", "protonmail.com", "msn.com"]);
/** One plain address only: no commas, semicolons, quotes, brackets or spaces, so "one person at a time" cannot be bent by a provider splitting a list. */
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export interface LeadInput { email: string; name?: string; company?: string; kind: LeadKind; basis: LeadBasis; source: string; relevance?: string }

export function checkLead(raw: unknown): LeadInput & { email: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const email = String(r.email ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 200) throw new PromoterError("enter a valid email address");
  const kind = r.kind;
  if (kind !== "business" && kind !== "individual") throw new PromoterError("say whether this is a company or an individual (a sole trader counts as an individual)");
  const basis = r.basis;
  if (typeof basis !== "string" || !(LEAD_BASES as readonly string[]).includes(basis)) throw new PromoterError("say why you may email them (their consent, a similar purchase, a company contact, or they wrote first)");
  const source = String(r.source ?? "").trim();
  if (source.length < 3 || source.length > 200) throw new PromoterError("say where this contact came from in 3 to 200 characters");
  if (BANNED_SOURCES.test(source)) throw new PromoterError("bought, scraped or harvested contacts are not allowed. UK law (PECR and GDPR) needs a real basis for each person, and a list from elsewhere does not give one.");
  const relevance = r.relevance === undefined ? undefined : String(r.relevance).trim().slice(0, 300);
  if (basis === "b2b_legitimate_interest") {
    if (kind !== "business") throw new PromoterError("emailing a company contact without consent is only allowed for companies, not individuals or sole traders");
    if (FREE_MAIL.has(email.split("@")[1]!)) throw new PromoterError("a personal webmail address is treated as an individual. Use a company address, or get their consent.");
    if (!relevance || relevance.length < 10) throw new PromoterError("say in a sentence why this is relevant to their job");
  }
  const clip = (v: unknown, n: number): string | undefined => { const s = String(v ?? "").trim().slice(0, n); return s || undefined; };
  return { email, name: clip(r.name, 80), company: clip(r.company, 120), kind, basis: basis as LeadBasis, source, relevance };
}

export const MAX_FOLLOW_UPS = 2;
export const MIN_FOLLOW_UP_GAP_DAYS = 5;
export const MAX_SENDS_PER_DAY = 50;
export const MAX_COLD_SENDS_PER_DAY = 20;

export interface SendCheckInput {
  basis: LeadBasis; kind: LeadKind; optedOut: boolean; replied: boolean; step: number;
  body: string; subject: string; hasUnsubscribe: boolean; hasSender: boolean;
  /** When the previous step went to this person (ISO), if any. */
  previousSentAt?: string; now: Date; sentToday: number; coldSentToday: number;
}

/** Every reason an email must not go out. An empty list means it may. */
export function sendProblems(c: SendCheckInput): string[] {
  const p: string[] = [];
  if (c.optedOut) p.push("this person has opted out");
  if (c.replied) p.push("this person has replied, so no more automatic emails go to them");
  if (!c.hasUnsubscribe) p.push("every marketing email needs a working unsubscribe link");
  if (!c.hasSender) p.push("every email must say who is sending it and give a postal address");
  if (/^\s*(re|fwd?):/i.test(c.subject)) p.push("the subject must not pretend to be a reply or a forward");
  if (!c.subject.trim() || !c.body.trim()) p.push("the email needs a subject and a body");
  if (c.step > MAX_FOLLOW_UPS) p.push(`at most ${MAX_FOLLOW_UPS} follow-ups are allowed`);
  if (c.step > 0 && c.previousSentAt && c.now.getTime() - Date.parse(c.previousSentAt) < MIN_FOLLOW_UP_GAP_DAYS * 86_400_000) p.push(`wait at least ${MIN_FOLLOW_UP_GAP_DAYS} days between emails to the same person`);
  if (c.step > 0 && !c.previousSentAt) p.push("a follow-up needs an earlier email to follow");
  if (c.sentToday >= MAX_SENDS_PER_DAY) p.push(`the limit of ${MAX_SENDS_PER_DAY} emails a day is reached`);
  if (c.basis === "b2b_legitimate_interest" && c.coldSentToday >= MAX_COLD_SENDS_PER_DAY) p.push(`the limit of ${MAX_COLD_SENDS_PER_DAY} first-contact business emails a day is reached`);
  if (c.basis === "b2b_legitimate_interest" && c.kind !== "business") p.push("first contact without consent is only for companies");
  return p;
}

export interface Sender { name: string; address: string }

/** The legal footer every outgoing email carries. */
export function emailFooter(sender: Sender, unsubscribeUrl: string, why: string): string {
  return `\n\n--\n${sender.name}, ${sender.address}\nYou are getting this because ${why}.\nUnsubscribe at any time: ${unsubscribeUrl}`;
}

// ---------------------------------------------------------------- copy checks

const CLAIM_FLAGS: [RegExp, string][] = [
  [/\bguarantee[sd]?\b/i, "promises a guaranteed result"],
  [/\b100\s?%\s*(pass|success|score)/i, "claims a 100% result"],
  [/\b(official|endorsed|approved)\b[^.]{0,40}\b(ielts|toefl|pte|sat|ets|pearson|college board|british council)\b/i, "suggests an official exam body approves or runs it"],
  [/\b(partner(ed)? with|in partnership with|affiliated with)\b[^.]{0,30}\b(ielts|toefl|pte|ets|pearson|college board|british council)\b/i, "claims a partnership with an exam body"],
  [/\b(thousands|millions|\d{3,}\+?)\s+(of\s+)?(students|customers|users|businesses|candidates)\b/i, "states a number of users that must be confirmed"],
  [/\b(testimonial|rated \d|5[- ]star|trusted by)\b/i, "social proof that must be real and confirmed"],
  [/\b(earn|make)\s+£?\$?\d[\d,]*/i, "an income promise"],
  [/\b(act now|last chance|only today|urgent)\b/i, "pressure wording that can look misleading"],
];

/** Warnings shown to the owner beside a draft. They do not block it: the owner decides. */
export function copyFlags(site: SiteKey, text: string): string[] {
  const flags = CLAIM_FLAGS.filter(([re]) => re.test(text)).map(([, why]) => why);
  if (site === "examutor" && /\b(under 13|age[sd]? (6|7|8|9|10|11|12)\b|primary school)/i.test(text)) flags.push("aims at children under 13");
  if (/https?:\/\/[^\s]*\.(ru|tk|ml|ga)\b/i.test(text)) flags.push("contains a suspicious link");
  return flags;
}
