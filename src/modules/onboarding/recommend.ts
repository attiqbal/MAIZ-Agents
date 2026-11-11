/**
 * Turns three tapped answers (kind of business, what the owner wants, apps they use)
 * into a plan: who on the team starts first and with which job, which apps to connect,
 * what to offer as an extra, and the setup form already filled in.
 *
 * Rules only, no AI model: the same answers always give the same plan, it costs the
 * customer nothing, and it works before any API key exists. Pure, so the website runs
 * the same code to show the plan before the account is created.
 */
import { APPS, NEEDS, OTHER_SECTOR, SECTORS, countryFacts, getNeed, getSector, type AppChoice, type NeedKey } from "./sectors.js";

export type SignupSize = "solo" | "2-10" | "11-50" | "51+";

/** Everything signup asks. Only the business name is required. */
export interface SignupAnswers {
  businessName: string;
  sector?: string;
  needs?: readonly string[];
  apps?: readonly string[];
  size?: SignupSize;
  /** ISO country code, guessed from the browser and shown to the owner. */
  country?: string;
  /** Optional one line about what the business sells. */
  sells?: string;
  website?: string;
  /** Extras the owner accepted on the plan screen. */
  addOns?: readonly string[];
}

export interface PlanMember {
  key: string;
  title: string;
  /** True for the employees who start on what the owner asked for. The rest wait on standby. */
  focus: boolean;
  firstJob: string;
  why: string;
}

export interface PlanOffer {
  key: string;
  title: string;
  reason: string;
}

/** Where a prefilled answer came from, so the form can label it. */
export type PrefillSource = "you" | "guess";

export interface SignupPlan {
  sector: string;
  needs: NeedKey[];
  team: PlanMember[];
  /** Monthly add-on employees worth offering. Never added without the owner's tap. */
  addOns: PlanOffer[];
  /** One-off consultants that fit a need, for later. */
  later: PlanOffer[];
  /** Apps the owner said they use. */
  apps: AppChoice[];
  /** Up to three more that businesses like theirs usually connect. */
  suggestedApps: AppChoice[];
  country?: string;
  currency?: string;
  prefill: { answers: Record<string, string | number | boolean | string[]>; source: Record<string, PrefillSource> };
}

export class SignupPlanError extends Error {}

export const MAX_NEEDS = 5;
const MAX_APPS = 12;
const MAX_SUGGESTED_APPS = 3;
const MAX_KEY_LENGTH = 60;

/** The basic team, in the order shown when nobody is in focus. Titles match the employee templates (a test checks). */
const TEAM: readonly { key: string; title: string; standbyJob: string }[] = [
  { key: "admin-manager", title: "Admin manager", standbyJob: "Sets up and runs the team for you" },
  { key: "finance-manager", title: "Finance manager", standbyJob: "Cash snapshot and runway" },
  { key: "marketing-manager", title: "Marketing manager", standbyJob: "30-day marketing plan" },
  { key: "business-consultant", title: "Business consultant", standbyJob: "Cost check with savings" },
  { key: "hr-manager", title: "HR manager", standbyJob: "People basics checklist" },
  { key: "compliance-manager", title: "Compliance manager", standbyJob: "Compliance health check" },
];

const ADD_ON_FOR_NEED: Partial<Record<NeedKey, PlanOffer>> = {
  stock: { key: "supply-chain-manager", title: "Supply chain and inventory manager", reason: "You asked for help with stock and suppliers. This employee watches stock levels, reorders and supplier prices." },
};

const CONSULTANT_FOR_NEED: Partial<Record<NeedKey, PlanOffer>> = {
  "raise-money": { key: "finance-funding-consultant", title: "Finance and funding consultant", reason: "For a pitch deck, financial model or grant application when you are ready to raise." },
  "online-presence": { key: "web-developer", title: "Web and automation developer", reason: "For building or fixing the website once your Marketing manager has reviewed it." },
  staff: { key: "people-ops-consultant", title: "People, policy and operations consultant", reason: "For a full staff handbook or a recruitment drive." },
};

const plain = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SHORT_WORD = 4;

/** Where a sector word first appears in the text, or -1. Short words must match whole, so "bar" is not found in "barber". */
function firstMatch(text: string, word: string): number {
  const w = plain(word).trim();
  const tail = w.length <= SHORT_WORD ? "(?:s|es)?(?![a-z0-9])" : "";
  const m = new RegExp(`(?<![a-z0-9])${escapeRe(w)}${tail}`).exec(text);
  return m ? m.index : -1;
}

/** Best guess at the sector from a few words. Most matching words wins; a tie goes to the word that comes first. */
export function guessSector(text: string | undefined): string {
  const t = plain(text ?? "");
  let best = { key: OTHER_SECTOR, hits: 0, at: Number.MAX_SAFE_INTEGER };
  for (const s of SECTORS) {
    const found = s.words.map((w) => firstMatch(t, w)).filter((i) => i >= 0);
    if (!found.length) continue;
    const at = Math.min(...found);
    if (found.length > best.hits || (found.length === best.hits && at < best.at)) best = { key: s.key, hits: found.length, at };
  }
  return best.key;
}

/** The sector to plan for: the tile the owner tapped, or a guess from their few words when they tapped "Something else". */
export function resolveSector(sector: string | undefined, sells: string | undefined): string {
  const known = SECTORS.some((s) => s.key === sector && s.key !== OTHER_SECTOR);
  return known ? sector! : guessSector(sells);
}

const SIZE_WORDS: Record<string, SignupSize> = { "just me": "solo", solo: "solo", "2–10": "2-10", "2-10": "2-10", "11–50": "11-50", "11-50": "11-50", "50+": "51+", "51+": "51+" };

/** Own keys only, so a word like "constructor" can never be read as a size. */
const sizeFrom = (v: unknown): SignupSize | undefined => {
  const word = typeof v === "string" ? v.toLowerCase() : "";
  return Object.hasOwn(SIZE_WORDS, word) ? SIZE_WORDS[word] : undefined;
};
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Reads what the website sent. Unknown keys, wrong types and over-long text are dropped, never trusted. */
export function readSignupAnswers(body: Record<string, unknown>): SignupAnswers {
  const sells = text(body.sells, 300);
  const needKeys = new Set<string>(NEEDS.map((n) => n.key));
  const appKeys = new Set(APPS.map((a) => a.key));
  const country = text(body.country, 2)?.toUpperCase();
  return {
    businessName: text(body.businessName, 120) ?? "",
    sector: resolveSector(text(body.sector, 40), sells),
    needs: [...new Set(list(body.needs).filter((n) => needKeys.has(n)))].slice(0, MAX_NEEDS),
    apps: [...new Set(list(body.apps).filter((a) => appKeys.has(a)))].slice(0, MAX_APPS),
    size: sizeFrom(body.size),
    ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}),
    ...(sells ? { sells } : {}),
    ...(text(body.website, 200) ? { website: text(body.website, 200) } : {}),
    addOns: list(body.addOns).filter((k) => k.length <= MAX_KEY_LENGTH).slice(0, MAX_APPS),
  };
}

function teamFor(needs: readonly NeedKey[], accepted: readonly PlanOffer[]): PlanMember[] {
  const members = [...TEAM, ...accepted.map((o) => ({ key: o.key, title: o.title, standbyJob: "" }))];
  const leads = needs.map((n) => getNeed(n)!).filter((n) => members.some((m) => m.key === n.lead));
  const focusKeys = [...new Set(leads.map((n) => n.lead))];
  const focus: PlanMember[] = focusKeys.map((key) => {
    const need = leads.find((n) => n.lead === key)!;
    return { key, title: members.find((m) => m.key === key)!.title, focus: true, firstJob: need.firstJob, why: `Because you want to ${need.goal}.` };
  });
  const standby: PlanMember[] = members
    .filter((m) => !focusKeys.includes(m.key))
    .map((m) => ({ key: m.key, title: m.title, focus: false, firstJob: m.standbyJob, why: m.key === "admin-manager" ? "Free. Runs setup and passes your requests to the right employee." : "On standby. Ready the moment you ask." }));
  return [...focus, ...standby];
}

function prefillFor(a: SignupAnswers, sectorKey: string, needs: readonly NeedKey[], needsFromOwner: boolean, sectorFromOwner: boolean): SignupPlan["prefill"] {
  const sector = getSector(sectorKey);
  const answers: SignupPlan["prefill"]["answers"] = {};
  const source: Record<string, PrefillSource> = {};
  const put = (key: string, value: string | number | undefined, from: PrefillSource): void => {
    if (value === undefined || value === "") return;
    answers[key] = value;
    source[key] = from;
  };
  put("goals", `Most important: ${needs.map((n) => getNeed(n)!.goal).join(", ")}.`, needsFromOwner ? "you" : "guess");
  put("customers", sector.customers, "guess");
  put("industry", [sector.industry, a.sells].filter(Boolean).join(". "), sectorFromOwner || a.sells ? "you" : "guess");
  put("financialYearStart", countryFacts(a.country)?.yearStart, "guess");
  // Only certain when the owner works alone; other sizes are ranges, so the HR manager asks.
  if (a.size === "solo") put("staffCount", 0, "you");
  return { answers, source };
}

/** The plan shown before the account is created and stored with the organisation afterwards. */
export function planSignup(a: SignupAnswers): SignupPlan {
  if (!a.businessName.trim()) throw new SignupPlanError("business name is required");
  const sector = getSector(resolveSector(a.sector, a.sells));
  const picked = (a.needs ?? []).filter((n): n is NeedKey => !!getNeed(n)).slice(0, MAX_NEEDS);
  // What matters most to this kind of business leads, whatever order the chips were tapped in.
  const rank = (n: NeedKey): number => (sector.needs.includes(n) ? sector.needs.indexOf(n) : sector.needs.length + NEEDS.findIndex((x) => x.key === n));
  const needs: NeedKey[] = picked.length ? [...new Set(picked)].sort((x, y) => rank(x) - rank(y)) : [...sector.needs];
  const offers = needs.map((n) => ADD_ON_FOR_NEED[n]).filter((o): o is PlanOffer => !!o);
  const accepted = offers.filter((o) => (a.addOns ?? []).includes(o.key));
  const facts = countryFacts(a.country);
  const inRegion = (app: AppChoice): boolean => !app.regions?.length || !facts || app.regions.includes(facts.code);
  const apps = [...new Set(a.apps ?? [])].map((k) => APPS.find((x) => x.key === k)).filter((x): x is AppChoice => !!x);
  const suggestedApps = sector.apps
    .map((k) => APPS.find((x) => x.key === k)!)
    .filter((x) => inRegion(x) && !apps.includes(x))
    .slice(0, MAX_SUGGESTED_APPS);
  return {
    sector: sector.key,
    needs,
    team: teamFor(needs, accepted),
    addOns: offers.filter((o) => !accepted.includes(o)),
    later: [...new Set(needs.map((n) => CONSULTANT_FOR_NEED[n]).filter((o): o is PlanOffer => !!o))],
    apps,
    suggestedApps,
    ...(facts ? { country: facts.code, currency: facts.currency } : {}),
    prefill: prefillFor(a, sector.key, needs, picked.length > 0, !!a.sector && a.sector !== OTHER_SECTOR),
  };
}
