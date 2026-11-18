import * as desk from "../research/desk.js";
import type { DeskItem } from "../research/desk.js";
import { clean, searchGitHub, searchHackerNews, searchReddit, searchX, searchYouTube, type Mention, type RedditApp, type SearchOptions } from "../research/sources.js";

/**
 * The places the Data mining agent may read, and what each run of one costs in energy.
 *
 * Every outbound call goes through the research module's source functions, which fix the host they talk to, set a
 * timeout, refuse redirects and clean what comes back. Nothing here posts, votes or messages; it only reads what is
 * already public through each source's official interface. What comes back was written by strangers, so it is kept
 * as short snippets and links and treated as data, never as instructions.
 */
export type MiningSourceId = "hackernews" | "github" | "reddit" | "youtube" | "x" | "news" | "economy" | "prices" | "companies";

export interface MiningSource {
  id: MiningSourceId;
  /** Plain-English name shown to the client. */
  label: string;
  /** What the client gets from it, in one line. */
  gives: string;
  /** Energy for one run before the paid-service rule. */
  baseEnergy: number;
  /** True when each use costs MAIZ money: its energy is the base times the owner's paid-service multiplier. */
  paid: boolean;
  /** What one run costs MAIZ, in micro-dollars (an estimate). Counts towards the hidden monthly cost cap. */
  estCostMicro: number;
  /** Most runs a day across every client, so one client cannot use up the platform's allowance. */
  dailyBudget?: number;
}

/** What a free source uses per run: a small flat figure for the work of reading, cleaning and keeping it. */
export const FREE_SOURCE_ENERGY = 5;
/** One X search reads about ten posts at roughly half a US cent each (an estimate; X's invoice is the real figure). */
export const X_EST_COST_MICRO = 50_000;
const MICRO_PER_ENERGY = 1_000;
/** X before the paid-service rule: its plain cost in energy. The client is charged this times the multiplier (2 by default). */
export const X_BASE_ENERGY = Math.ceil(X_EST_COST_MICRO / MICRO_PER_ENERGY);
/** YouTube allows 10,000 units a day and a search costs about 100. The owner's own research desk keeps its separate 40. */
export const YOUTUBE_RUNS_PER_DAY = 40;
/** A cap on what X can cost the platform in a day (about 2.50 US dollars at the estimate above). */
export const X_RUNS_PER_DAY = 50;
/** Alpha Vantage's free key answers 25 times a day; some are left for the owner's desk. */
export const PRICE_RUNS_PER_DAY = 15;
/** GitHub allows about 10 keyless searches a minute across the whole platform; this keeps a day well inside that. */
export const GITHUB_RUNS_PER_DAY = 500;
/** Most items (or figures) kept from one source in one dataset. */
export const MAX_ITEMS_PER_SOURCE = 10;
export const MAX_SNIPPET = 300;
const MAX_TITLE = 200;
const MAX_URL = 300;
/** Used for the economy figures when the business profile has no usable country code: the World Bank's "World". */
export const DEFAULT_ECONOMY_COUNTRY = "WLD";
/** World Bank indicators a small business can use: prices, growth and jobs. */
export const ECONOMY_INDICATORS: readonly { code: string; label: string }[] = [
  { code: "FP.CPI.TOTL.ZG", label: "Inflation, consumer prices (% a year)" },
  { code: "NY.GDP.MKTP.KD.ZG", label: "Economic growth, GDP (% a year)" },
  { code: "SL.UEM.TOTL.ZS", label: "Unemployment (% of the workforce)" },
];
const FIGURES_PER_INDICATOR = 3;
/** A share or fund symbol, the only thing the price look-up understands. */
const SYMBOL = /^[A-Za-z0-9.-]{1,12}$/;
const COUNTRY_CODE = /^[A-Za-z]{2,3}$/;

export const MINING_SOURCES: readonly MiningSource[] = [
  { id: "hackernews", label: "Hacker News discussions", gives: "What founders and tech people are saying about the topic.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0 },
  { id: "github", label: "GitHub issues and requests", gives: "What builders ask for and complain about in public GitHub issues, with the project each came from.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0, dailyBudget: GITHUB_RUNS_PER_DAY },
  { id: "reddit", label: "Reddit conversations", gives: "What customers and communities are saying, with the community each post came from.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0 },
  { id: "youtube", label: "YouTube videos", gives: "Recent videos about the topic, with the channel and a short description.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0, dailyBudget: YOUTUBE_RUNS_PER_DAY },
  { id: "x", label: "Posts on X", gives: "Public posts from the last seven days. X charges for each search, so this uses more energy.", baseEnergy: X_BASE_ENERGY, paid: true, estCostMicro: X_EST_COST_MICRO, dailyBudget: X_RUNS_PER_DAY },
  { id: "news", label: "News coverage", gives: "Recent news articles from around the world that mention the topic.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0 },
  { id: "economy", label: "Economy figures for your country", gives: "Inflation, growth and unemployment from the World Bank, for the country in your business profile.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0 },
  { id: "prices", label: "Share price", gives: "The latest price of a listed company or fund. The topic must be its symbol, for example IBM or VOD.LON.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0, dailyBudget: PRICE_RUNS_PER_DAY },
  { id: "companies", label: "UK company records", gives: "Companies House records that match the topic: name, status and company number.", baseEnergy: FREE_SOURCE_ENERGY, paid: false, estCostMicro: 0 },
];

export function miningSource(id: string): MiningSource | undefined {
  return MINING_SOURCES.find((s) => s.id === id);
}

/** What a run of one source uses: the base, or the base times the owner's multiplier when the source is paid per use. */
export function energyFor(source: MiningSource, multiplier: number, fallbackMultiplier: number): number {
  if (!source.paid) return source.baseEnergy;
  const m = Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : fallbackMultiplier;
  return Math.ceil(source.baseEnergy * m);
}

/** The platform's keys, read at call time so a key typed on the Connections page works without a restart. */
export interface MiningKeys { reddit?: RedditApp; youtube?: string; x?: string; alphaVantage?: string; companiesHouse?: string }

/** One thing found: a title, a short snippet and the link back to where it is public. Never a full copy. */
export interface MiningItem { title: string; snippet: string; url: string; source: string; at?: string }
/** One number with where and when it is from. */
export interface MiningFigure { label: string; value: string; date?: string; detail?: string; url?: string }
export interface Gathered { items: MiningItem[]; figures: MiningFigure[] }

/** Why a source cannot be used right now, or undefined when it can. `topic` narrows the answer when one is known. */
export function unavailableReason(source: MiningSource, keys: MiningKeys, topic?: string): string | undefined {
  const notYet = `${source.label} is not available yet: MAIZ has not switched it on.`;
  switch (source.id) {
    case "reddit": return keys.reddit ? undefined : notYet;
    case "youtube": return keys.youtube ? undefined : notYet;
    case "x": return keys.x ? undefined : notYet;
    case "companies": return keys.companiesHouse ? undefined : notYet;
    case "prices":
      if (!keys.alphaVantage) return notYet;
      return topic !== undefined && !SYMBOL.test(topic) ? "A share price needs the company's symbol as the topic, for example IBM or VOD.LON." : undefined;
    default: return undefined;
  }
}

/** Only links that start with https and hold nothing that could break out of the text around them. */
const httpsUrl = (u: unknown): string | undefined => (typeof u === "string" && u.length <= MAX_URL && /^https:\/\/[^\s<>"'`\\]{4,}$/.test(u) ? u : undefined);
const day = (iso: string | undefined): string | undefined => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

/**
 * A public post as an item. The author's name is left out: a dataset is about the topic, not about who wrote what.
 * On X the place is just "X" for the same reason (the link still leads to the public post).
 */
function fromMention(m: Mention): MiningItem | undefined {
  const url = httpsUrl(m.url);
  const title = clean(m.title, MAX_TITLE);
  if (!url || !title) return undefined;
  const at = day(m.createdAt);
  return { title, snippet: clean(m.snippet, MAX_SNIPPET), url, source: m.source === "x" ? "X" : clean(m.community, 60) || m.source, ...(at ? { at } : {}) };
}

function fromNews(d: DeskItem): MiningItem | undefined {
  const url = httpsUrl(d.url);
  const title = clean(d.title, MAX_TITLE);
  if (!url || !title) return undefined;
  const at = day(d.date);
  return { title, snippet: clean(d.detail, MAX_SNIPPET), url, source: clean(d.detail.split(",")[0], 80) || "News", ...(at ? { at } : {}) };
}

/** A company record: status and number only. The registered address is left out, since for a sole trader it can be a home. */
function fromCompany(d: DeskItem): MiningItem | undefined {
  const url = httpsUrl(d.url);
  const title = clean(d.title, MAX_TITLE);
  if (!url || !title) return undefined;
  const basics = /^(.*?, number [A-Z0-9]{6,10})/.exec(d.detail)?.[1] ?? "";
  return { title, snippet: clean(`${basics}${d.date ? `${basics ? ", " : ""}registered ${d.date}` : ""}`, MAX_SNIPPET), url, source: "Companies House" };
}

const figure = (label: string, d: DeskItem, url?: string): MiningFigure | undefined => {
  const value = clean(d.value, 40);
  if (!value) return undefined;
  const date = clean(d.date, 10);
  const detail = clean(d.detail, 120);
  return { label: clean(label, 120), value, ...(date ? { date } : {}), ...(detail ? { detail } : {}), ...(url ? { url } : {}) };
};

const present = <T>(v: T | undefined): v is T => v !== undefined;

export interface GatherContext { http: typeof fetch; keys: MiningKeys; topic: string; country?: string }

/**
 * Reads one source for the topic. Throws when the source cannot be read (the caller records that and gives the energy
 * back); returns empty lists when it answered but had nothing.
 */
export async function gather(id: MiningSourceId, ctx: GatherContext): Promise<Gathered> {
  const { http, keys, topic } = ctx;
  const search: SearchOptions = { query: topic, sort: "relevance", within: "month", limit: MAX_ITEMS_PER_SOURCE };
  const items = (found: (MiningItem | undefined)[]): Gathered => ({ items: found.filter(present).slice(0, MAX_ITEMS_PER_SOURCE), figures: [] });
  switch (id) {
    case "hackernews": return items((await searchHackerNews(http, search)).map(fromMention));
    case "github": return items((await searchGitHub(http, search)).map(fromMention));
    case "reddit": return items((await searchReddit(http, keys.reddit!, search)).map(fromMention));
    case "youtube": return items((await searchYouTube(http, keys.youtube!, search)).map(fromMention));
    case "x": return items((await searchX(http, keys.x!, search)).map(fromMention));
    case "news": return items((await desk.news(http, topic, "month")).map(fromNews));
    case "companies": return items((await desk.company(http, keys.companiesHouse!, topic)).map(fromCompany));
    case "prices": return { items: [], figures: (await desk.quote(http, keys.alphaVantage!, topic)).map((d) => figure(`${d.title} share price`, d)).filter(present) };
    case "economy": return economy(http, ctx.country);
  }
}

/** The newest few years of each indicator. One indicator failing does not lose the others; all failing is a failure. */
async function economy(http: typeof fetch, country: string | undefined): Promise<Gathered> {
  const code = country && COUNTRY_CODE.test(country) ? country.toUpperCase() : DEFAULT_ECONOMY_COUNTRY;
  const results = await Promise.allSettled(ECONOMY_INDICATORS.map((i) => desk.indicator(http, code, i.code)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed && results.every((r) => r.status === "rejected")) throw failed.reason;
  const figures = results.flatMap((r, n) => {
    const ind = ECONOMY_INDICATORS[n]!;
    const url = `https://data.worldbank.org/indicator/${ind.code}?locations=${code}`;
    return r.status === "fulfilled" ? r.value.slice(0, FIGURES_PER_INDICATOR).map((d) => figure(ind.label, d, url)).filter(present) : [];
  });
  return { items: [], figures: figures.slice(0, MAX_ITEMS_PER_SOURCE) };
}
