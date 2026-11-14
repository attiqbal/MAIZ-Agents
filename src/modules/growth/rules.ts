import { SITES, isSiteKey, type SiteKey } from "../promoter/knowledge.js";
import { copyFlags } from "../promoter/rules.js";

/** Pure rules for community growth: scoring opportunities, platform rules, duplicate checks, limits. */
export class GrowthError extends Error {}

export const PLATFORMS = ["reddit", "quora", "linkedin", "forum", "blog", "publication", "community"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABEL: Record<Platform, string> = {
  reddit: "Reddit", quora: "Quora", linkedin: "LinkedIn", forum: "Niche forum", blog: "Blog (guest post)", publication: "Publication (guest article)", community: "Other community",
};
/** Platforms where the agent joins a conversation, as opposed to pitching an editor. */
export const CONVERSATION_PLATFORMS: readonly Platform[] = ["reddit", "quora", "linkedin", "forum", "community"];
export const PITCH_PLATFORMS: readonly Platform[] = ["blog", "publication"];

export const COMMERCIAL = ["yes", "limited", "no", "unknown"] as const;
export type Commercial = (typeof COMMERCIAL)[number];
export const COMMERCIAL_LABEL: Record<Commercial, string> = { yes: "Links to your own site are welcome", limited: "Links allowed only when clearly relevant", no: "No promotion or self-links", unknown: "Not checked yet" };

export type DraftMode = "contribution" | "article" | "guest_pitch";

const HOSTS: Partial<Record<Platform, RegExp>> = { reddit: /(^|\.)reddit\.com$/, quora: /(^|\.)quora\.com$/, linkedin: /(^|\.)linkedin\.com$/ };

/** An https link to a real public host. No IP addresses, localhost or credentials in the link. */
export function checkUrl(raw: unknown, platform?: Platform): string {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { throw new GrowthError("enter a full web address starting with https://"); }
  if (u.protocol !== "https:") throw new GrowthError("the web address must start with https://");
  if (u.username || u.password) throw new GrowthError("the web address must not contain a login");
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) throw new GrowthError("use the public web address of the page");
  const want = platform ? HOSTS[platform] : undefined;
  if (want && !want.test(h)) throw new GrowthError(`that is not a ${PLATFORM_LABEL[platform!]} address`);
  if (u.toString().length > 400) throw new GrowthError("the web address is too long");
  return u.toString();
}

/** One key per real place: lower-case host without www/old/m, no query, no trailing slash; Reddit and Quora use the first path parts. Stops the same place being listed twice under different spellings. */
export function placeKey(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^(www|old|new|m|np)\./, "");
  const parts = u.pathname.toLowerCase().split("/").filter(Boolean);
  const keep = host === "reddit.com" && parts[0] === "r" ? parts.slice(0, 2) : parts;
  return `${host}/${keep.join("/")}`;
}

/** Every web address in a text. */
export const urlsIn = (t: string): string[] => t.match(/https?:\/\/[^\s)>\]]+/gi) ?? [];

// ---------------------------------------------------------------- scoring

export interface ScoreInput { audienceFit: number; domainQuality: number; rulesFit: number; commercial: Commercial }
export interface Score { score: number; band: "strong" | "worth_a_try" | "skip"; reasons: string[] }

const rating = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new GrowthError(`${name} is a whole number from 0 to 5`);
  return n;
};
export function checkScoreInput(r: Record<string, unknown>): ScoreInput {
  const commercial = r.commercial === undefined ? "unknown" : r.commercial;
  if (typeof commercial !== "string" || !(COMMERCIAL as readonly string[]).includes(commercial)) throw new GrowthError("say whether the place allows links and promotion");
  return { audienceFit: rating(r.audienceFit, "audience fit"), domainQuality: rating(r.domainQuality, "site quality"), rulesFit: rating(r.rulesFit, "rules fit"), commercial: commercial as Commercial };
}

/** 0 to 100: audience 40%, site quality 25%, rules fit 20%, commercial openness 15%. A place that forbids us, or has the wrong audience, scores 0. */
export function scoreOpportunity(i: ScoreInput): Score {
  const reasons: string[] = [];
  if (i.rulesFit === 0) return { score: 0, band: "skip", reasons: ["its rules do not allow this kind of contribution"] };
  if (i.audienceFit <= 1) return { score: 0, band: "skip", reasons: ["the audience is not the one this site is for"] };
  const commercial = { yes: 5, limited: 3, unknown: 2, no: 1 }[i.commercial];
  const score = Math.round(((i.audienceFit * 0.4 + i.domainQuality * 0.25 + i.rulesFit * 0.2 + commercial * 0.15) / 5) * 100);
  if (i.audienceFit >= 4) reasons.push("strong audience match");
  if (i.domainQuality <= 2) reasons.push("low-quality site: a link from here could do more harm than good");
  if (i.commercial === "no") reasons.push("no self-links: only worth it for genuine help and brand awareness");
  if (i.commercial === "unknown") reasons.push("check the rules for links before drafting");
  return { score, band: score >= 70 ? "strong" : score >= 45 ? "worth_a_try" : "skip", reasons };
}

/** A link to the site is only included where the place allows it and the audience match is real. */
export const linkAllowed = (o: { commercial: Commercial; audienceFit: number; rulesFit: number }): boolean => o.commercial !== "no" && o.commercial !== "unknown" && o.audienceFit >= 3 && o.rulesFit >= 3;

// ---------------------------------------------------------------- limits and originality

export const MAX_REDDIT_PER_DAY = 3;
export const MIN_DAYS_BETWEEN_POSTS_IN_ONE_PLACE = 7;
export const MAX_SIMILARITY = 0.6;
export const MIN_BODY_CHARS = 120;

const words = (t: string): string[] => t.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
/** Share of three-word runs two texts have in common (0 to 1). */
export function similarity(a: string, b: string): number {
  const shingles = (t: string): Set<string> => { const w = words(t); const s = new Set<string>(); for (let i = 0; i + 2 < w.length; i++) s.add(w.slice(i, i + 3).join(" ")); return s; };
  const x = shingles(a), y = shingles(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / Math.min(x.size, y.size);
}

const GENERIC = [/in today'?s fast[- ]paced world/i, /game[- ]?changer/i, /unlock the (power|potential)/i, /\bdelve\b/i, /in (the )?ever[- ]evolving/i, /\bas an ai\b/i, /(revolutioni[sz]e|supercharge) your/i, /\bin conclusion\b/i];
const COMMITMENT = /\b(we (will|promise to|commit to)|i (will|promise to) (give|send|refund|pay|build|make)|free for life|lifetime (access|deal)|exclusive (deal|offer|discount)|special price for (you|your)|we guarantee|(discount|commission) code for (your|the) (readers|members|community))\b/i;
const FAKE_ENGAGEMENT = /\b(upvote|up-vote|please (like|share|vote)|ask (a )?friends? to|second account|alt account|sockpuppet|pretend to be|as a (happy |satisfied )?customer)\b/i;

export interface GrowthFlags { flags: string[]; commitment: boolean }
export function growthFlags(site: SiteKey, text: string): GrowthFlags {
  const flags = [...copyFlags(site, text)];
  for (const re of GENERIC) if (re.test(text)) { flags.push("sounds like generic AI writing: rewrite it in your own words"); break; }
  if (FAKE_ENGAGEMENT.test(text)) flags.push("asks for or fakes engagement, or pretends to be someone else");
  const commitment = COMMITMENT.test(text);
  if (commitment) flags.push("makes a commitment on the company's behalf: needs your explicit OK");
  return { flags: [...new Set(flags)], commitment };
}

/** The line added to every contribution so nobody has to guess who is writing. */
export const disclosureLine = (site: SiteKey): string => `Disclosure: I run ${SITES[site].name} (${SITES[site].url}), so I have an interest here.`;

// ---------------------------------------------------------------- research help

/** Search phrases to find places worth listing. They are suggestions for a person or tool to run; nothing here browses or posts. */
export function discoveryQueries(site: SiteKey): { platform: Platform; query: string }[] {
  const t: Record<SiteKey, { topics: string[]; pubs: string[] }> = {
    mocktestroom: { topics: ["IELTS speaking practice", "PTE score help", "TOEFL preparation tips"], pubs: ["IELTS preparation blog", "study abroad guide"] },
    examutor: { topics: ["Digital SAT preparation", "SAT study plan", "GRE GMAT study help"], pubs: ["college admissions blog", "parents guide to SAT"] },
    maizagents: { topics: ["AI tools for small business", "automate bookkeeping small business UK", "small business admin help"], pubs: ["UK small business blog", "AI for small business publication"] },
  };
  const { topics, pubs } = t[site];
  return [
    ...topics.map((q) => ({ platform: "reddit" as Platform, query: `site:reddit.com ${q}` })),
    ...topics.map((q) => ({ platform: "quora" as Platform, query: `site:quora.com ${q}` })),
    ...topics.map((q) => ({ platform: "linkedin" as Platform, query: `site:linkedin.com/posts ${q}` })),
    ...topics.map((q) => ({ platform: "forum" as Platform, query: `${q} forum "new topic"` })),
    ...pubs.map((q) => ({ platform: "blog" as Platform, query: `${q} "write for us" OR "guest post" OR "contribute"` })),
  ];
}

export { isSiteKey };
