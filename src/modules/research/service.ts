import * as desk from "./desk.js";
import { DESK_KINDS, type DeskItem, type DeskKeys, type DeskKind } from "./desk.js";
import { ResearchError, SOURCES, searchHackerNews, searchReddit, searchX, searchYouTube, type Mention, type RedditApp, type SearchOptions, type SourceKey } from "./sources.js";

export interface ResearchOptions {
  isOwner: (userId: string) => boolean;
  /** Read at call time, so keys typed on the Connections page apply without a restart. */
  reddit: () => RedditApp | undefined;
  youtubeKey: () => string | undefined;
  xToken: () => string | undefined;
  deskKeys: () => DeskKeys;
  http?: typeof fetch;
  now?: () => Date;
}
export interface ResearchResult { query: string; mentions: Mention[]; searched: SourceKey[]; skipped: { source: SourceKey; reason: string }[]; cached: boolean }

const MAX_SEARCHES = 20;
const WINDOW_MS = 10 * 60_000;
const CACHE_MS = 10 * 60_000;
/** YouTube allows 10,000 units a day and a search costs about 100, so it has its own daily cap. */
const YOUTUBE_PER_DAY = 40;
const DAY_MS = 86_400_000;
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

/**
 * Owner-only market research across public forums and video. Read-only, rate limited (so a slip cannot burn the
 * platform's API allowance) and cached for ten minutes. Results are public text from strangers: treat as data.
 */
export class ResearchService {
  private recent = new Map<string, number[]>();
  private youtubeRuns: number[] = [];
  private deskCache = new Map<string, { at: number; items: DeskItem[] }>();
  private cache = new Map<string, { at: number; result: ResearchResult }>();
  constructor(private readonly opts: ResearchOptions) {}
  private get http(): typeof fetch { return this.opts.http ?? fetch; }
  private now(): number { return (this.opts.now?.() ?? new Date()).getTime(); }

  /** Which sources are ready, and what each needs. */
  status(userId: string): { source: SourceKey; ready: boolean; needs?: string }[] {
    this.require(userId);
    return [
      { source: "reddit", ready: !!this.opts.reddit(), needs: this.opts.reddit() ? undefined : "Add the Reddit app on the Connections page" },
      { source: "hackernews", ready: true },
      { source: "youtube", ready: !!this.opts.youtubeKey(), needs: this.opts.youtubeKey() ? undefined : "Add the YouTube key on the Connections page" },
      { source: "x", ready: !!this.opts.xToken(), needs: this.opts.xToken() ? undefined : "Add the X token on the Connections page" },
    ];
  }

  async search(userId: string, raw: Record<string, unknown>): Promise<ResearchResult> {
    this.require(userId);
    const query = typeof raw.query === "string" ? raw.query.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (query.length < 2 || query.length > 100) throw new ResearchError("type 2 to 100 characters to search for");
    const wanted = Array.isArray(raw.sources) && raw.sources.length ? raw.sources : SOURCES;
    const sources = [...new Set(wanted)].filter((s): s is SourceKey => SOURCES.includes(s as SourceKey));
    if (!sources.length) throw new ResearchError("choose at least one place to search");
    const subreddits = (Array.isArray(raw.subreddits) ? raw.subreddits : []).map((s) => String(s).replace(/^\/?r\//i, "").trim()).filter(Boolean).slice(0, 5);
    if (subreddits.some((s) => !SUBREDDIT.test(s))) throw new ResearchError("a subreddit name is 2 to 21 letters, numbers or underscores, for example smallbusiness");
    const sort = raw.sort === "new" || raw.sort === "top" ? raw.sort : "relevance";
    const within = raw.within === "month" || raw.within === "year" ? raw.within : "week";
    const o: SearchOptions = { query, subreddits, sort, within, limit: 15 };

    const key = JSON.stringify([query.toLowerCase(), sources, subreddits.map((s) => s.toLowerCase()), sort, within]);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };
    this.limit(userId);

    const skipped: ResearchResult["skipped"] = [];
    const searched: SourceKey[] = [];
    const tasks: Promise<Mention[]>[] = [];
    for (const s of sources) {
      const reddit = this.opts.reddit(), yt = this.opts.youtubeKey(), xt = this.opts.xToken();
      if (s === "x" && !xt) { skipped.push({ source: s, reason: "X is not connected yet." }); continue; }
      if (s === "reddit" && !reddit) { skipped.push({ source: s, reason: "Reddit is not connected yet." }); continue; }
      if (s === "youtube" && !yt) { skipped.push({ source: s, reason: "YouTube is not connected yet." }); continue; }
      if (s === "youtube") {
        this.youtubeRuns = this.youtubeRuns.filter((x) => this.now() - x < DAY_MS);
        if (this.youtubeRuns.length >= YOUTUBE_PER_DAY) { skipped.push({ source: s, reason: "YouTube has been searched a lot today. It will be available again tomorrow." }); continue; }
        this.youtubeRuns.push(this.now());
      }
      searched.push(s);
      const run = s === "reddit" ? searchReddit(this.http, reddit!, o) : s === "youtube" ? searchYouTube(this.http, yt!, o) : s === "x" ? searchX(this.http, xt!, o) : searchHackerNews(this.http, o);
      tasks.push(run.catch((e: unknown) => { skipped.push({ source: s, reason: e instanceof ResearchError ? e.message : "Something went wrong reading it." }); return []; }));
    }
    const mentions = (await Promise.all(tasks)).flat().filter((m) => m.title).sort((a, b) => b.score + b.comments * 2 - (a.score + a.comments * 2));
    const result: ResearchResult = { query, mentions: mentions.slice(0, 40), searched: searched.filter((s) => !skipped.some((k) => k.source === s)), skipped, cached: false };
    if (result.searched.length) this.cache.set(key, { at: this.now(), result });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  /** Data desk look-ups: news, indicators, prices and UK companies. Same limits and cache as the forum search. */
  async desk(userId: string, raw: Record<string, unknown>): Promise<{ kind: DeskKind; items: DeskItem[]; cached: boolean }> {
    this.require(userId);
    const kind = raw.kind as DeskKind;
    if (!DESK_KINDS.includes(kind)) throw new ResearchError("choose what to look up");
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
    const query = text(raw.query, 100);
    const country = text(raw.country, 3).toUpperCase();
    if (kind === "indicator" ? !text(raw.indicator, 40) : query.length < 2) throw new ResearchError(kind === "indicator" ? "enter a country and an indicator code" : "type 2 to 100 characters to look up");
    const within = raw.within === "month" || raw.within === "year" ? raw.within : "week";
    const keys = this.opts.deskKeys();
    const need = (k: string | undefined, name: string): string => { if (!k) throw new ResearchError(`${name} is not connected yet. Add its key on the Connections page.`); return k; };
    const key = JSON.stringify([kind, query.toLowerCase(), country, text(raw.indicator, 40), within]);
    const hit = this.deskCache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return { kind, items: hit.items, cached: true };
    // The key check comes first so a missing key does not use up a search.
    const run = (): Promise<DeskItem[]> => {
      switch (kind) {
        case "news": return desk.news(this.http, query, within);
        case "indicator": return desk.indicator(this.http, country, text(raw.indicator, 40));
        case "series": return desk.series(this.http, need(keys.fred, "FRED"), query);
        case "quote": return desk.quote(this.http, need(keys.alphaVantage, "Alpha Vantage"), query);
        case "company": return desk.company(this.http, need(keys.companiesHouse, "Companies House"), query);
      }
    };
    if (kind === "series") need(keys.fred, "FRED"); else if (kind === "quote") need(keys.alphaVantage, "Alpha Vantage"); else if (kind === "company") need(keys.companiesHouse, "Companies House");
    this.limit(userId);
    const items = await run();
    this.deskCache.set(key, { at: this.now(), items });
    if (this.deskCache.size > 100) this.deskCache.delete(this.deskCache.keys().next().value!);
    return { kind, items, cached: false };
  }

  /** Which desk look-ups are ready. */
  deskStatus(userId: string): { kind: DeskKind; ready: boolean; needs?: string }[] {
    this.require(userId);
    const k = this.opts.deskKeys();
    return [
      { kind: "news", ready: true }, { kind: "indicator", ready: true },
      { kind: "series", ready: !!k.fred, needs: k.fred ? undefined : "Add the FRED key on the Connections page" },
      { kind: "quote", ready: !!k.alphaVantage, needs: k.alphaVantage ? undefined : "Add the Alpha Vantage key on the Connections page" },
      { kind: "company", ready: !!k.companiesHouse, needs: k.companiesHouse ? undefined : "Add the Companies House key on the Connections page" },
    ];
  }

  private require(userId: string): void {
    if (!this.opts.isOwner(userId)) throw new ResearchError("only the MAIZ platform owner can use market research");
  }
  private limit(userId: string): void {
    const t = this.now();
    const used = (this.recent.get(userId) ?? []).filter((x) => t - x < WINDOW_MS);
    if (used.length >= MAX_SEARCHES) throw new ResearchError("that is a lot of searches. Wait a few minutes and try again.");
    this.recent.set(userId, [...used, t]);
  }
}
