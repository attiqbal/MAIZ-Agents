/**
 * Read-only market research sources: Reddit (official API, app-only token), Hacker News (public search, no key) and
 * YouTube (Data API key). Nothing here posts, votes, comments or messages. Everything returned is text written by
 * strangers, so it is shortened and cleaned here, and callers must treat it as data, never as instructions.
 */
export type SourceKey = "reddit" | "hackernews" | "youtube" | "x";
export const SOURCES: readonly SourceKey[] = ["reddit", "hackernews", "youtube", "x"];

export interface Mention {
  source: SourceKey;
  title: string;
  url: string;
  /** Subreddit, channel, "Hacker News" or the X handle. */
  community: string;
  author?: string;
  /** Upvotes, points or views. */
  score: number;
  comments: number;
  createdAt: string;
  /** The first words of the post, cleaned. */
  snippet: string;
}

export class ResearchError extends Error {}

export interface SearchOptions { query: string; subreddits?: string[]; sort: "relevance" | "new" | "top"; within: "week" | "month" | "year"; limit: number }

const TIMEOUT_MS = 15_000;
const SNIPPET = 280;

/** Control characters out, whitespace collapsed, shortened. */
export function clean(text: unknown, max = SNIPPET): string {
  const s = typeof text === "string" ? text : "";
  // Angle brackets become look-alikes so a post can never close a tag it is wrapped in later.
  return s.replace(/[<]/g, "\u2039").replace(/[>]/g, "\u203a").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const count = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
const iso = (seconds: unknown): string => { const n = Number(seconds); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : ""; };

export async function getJson(http: typeof fetch, name: string, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ResearchError(`${name} could not be reached. Try again in a minute.`);
  }
  if (res.status === 429) throw new ResearchError(`${name} says we are asking too often. Wait a few minutes.`);
  if (res.status === 401 || res.status === 403) throw new ResearchError(`${name} did not accept the keys. Check the ${name} card on the Connections page.`);
  if (!res.ok) throw new ResearchError(`${name} answered with an error (${res.status}).`);
  try { return await res.json(); } catch { throw new ResearchError(`${name} sent something unreadable.`); }
}

// ---------------------------------------------------------------- Reddit

export interface RedditApp { clientId: string; clientSecret: string; username: string }
/** Reddit wants every program to say who it is and who runs it. */
export const redditAgent = (app: RedditApp): string => `web:maiz-agents:v1 (by /u/${app.username})`;

/** An app-only, read-only token. Also what the Connections page test uses. */
export async function redditToken(http: typeof fetch, app: RedditApp): Promise<string> {
  const j = await getJson(http, "Reddit", "https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", "user-agent": redditAgent(app) },
    body: "grant_type=client_credentials",
  });
  if (typeof j?.access_token !== "string" || !j.access_token) throw new ResearchError("Reddit did not accept the keys. Check the Client ID, secret and username on the Reddit card.");
  return j.access_token;
}

export function parseReddit(json: any): Mention[] {
  const out: Mention[] = [];
  for (const c of Array.isArray(json?.data?.children) ? json.data.children : []) {
    const d = c?.data;
    if (!d || d.over_18 || typeof d.permalink !== "string" || !/^\/r\/[\w]+\/comments\//.test(d.permalink)) continue;
    out.push({ source: "reddit", title: clean(d.title, 200), url: `https://www.reddit.com${d.permalink}`, community: `r/${clean(d.subreddit, 30)}`, author: clean(d.author, 30) || undefined, score: count(d.score), comments: count(d.num_comments), createdAt: iso(d.created_utc), snippet: clean(d.selftext) });
  }
  return out;
}

export async function searchReddit(http: typeof fetch, app: RedditApp, o: SearchOptions): Promise<Mention[]> {
  const token = await redditToken(http, app);
  const headers = { authorization: `Bearer ${token}`, "user-agent": redditAgent(app) };
  const subs = o.subreddits?.length ? o.subreddits : [undefined];
  const out: Mention[] = [];
  for (const sub of subs) {
    const q = new URLSearchParams({ q: o.query, sort: o.sort, t: o.within, limit: String(o.limit), type: "link", raw_json: "1", ...(sub ? { restrict_sr: "1" } : {}) });
    const path = sub ? `/r/${encodeURIComponent(sub)}/search` : "/search";
    out.push(...parseReddit(await getJson(http, "Reddit", `https://oauth.reddit.com${path}?${q}`, { headers })));
  }
  return out;
}

// ---------------------------------------------------------------- Hacker News (Algolia's public search, no key)

export function parseHackerNews(json: any): Mention[] {
  const out: Mention[] = [];
  for (const h of Array.isArray(json?.hits) ? json.hits : []) {
    const id = String(h?.objectID ?? "");
    if (!/^\d{1,12}$/.test(id) || !h.title) continue;
    out.push({ source: "hackernews", title: clean(h.title, 200), url: `https://news.ycombinator.com/item?id=${id}`, community: "Hacker News", author: clean(h.author, 30) || undefined, score: count(h.points), comments: count(h.num_comments), createdAt: iso(h.created_at_i), snippet: clean(String(h.story_text ?? "").replace(/<[^>]*>/g, " ")) });
  }
  return out;
}

export async function searchHackerNews(http: typeof fetch, o: SearchOptions): Promise<Mention[]> {
  const days = o.within === "week" ? 7 : o.within === "month" ? 31 : 365;
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const q = new URLSearchParams({ query: o.query, tags: "story", hitsPerPage: String(o.limit), numericFilters: `created_at_i>${since}` });
  const path = o.sort === "new" ? "search_by_date" : "search";
  return parseHackerNews(await getJson(http, "Hacker News", `https://hn.algolia.com/api/v1/${path}?${q}`, {}));
}

// ---------------------------------------------------------------- YouTube

export function parseYouTube(search: any, stats: any): Mention[] {
  const views = new Map<string, { views: number; comments: number }>();
  for (const v of Array.isArray(stats?.items) ? stats.items : []) views.set(String(v?.id), { views: count(v?.statistics?.viewCount), comments: count(v?.statistics?.commentCount) });
  const out: Mention[] = [];
  for (const i of Array.isArray(search?.items) ? search.items : []) {
    const id = String(i?.id?.videoId ?? "");
    if (!/^[\w-]{6,20}$/.test(id)) continue;
    const s = views.get(id);
    out.push({ source: "youtube", title: clean(i.snippet?.title, 200), url: `https://www.youtube.com/watch?v=${id}`, community: clean(i.snippet?.channelTitle, 60) || "YouTube", score: s?.views ?? 0, comments: s?.comments ?? 0, createdAt: typeof i.snippet?.publishedAt === "string" ? i.snippet.publishedAt.slice(0, 25) : "", snippet: clean(i.snippet?.description) });
  }
  return out;
}

export async function searchYouTube(http: typeof fetch, key: string, o: SearchOptions): Promise<Mention[]> {
  const headers = { "x-goog-api-key": key };
  const days = o.within === "week" ? 7 : o.within === "month" ? 31 : 365;
  const q = new URLSearchParams({ part: "snippet", type: "video", q: o.query, maxResults: String(Math.min(o.limit, 25)), order: o.sort === "new" ? "date" : o.sort === "top" ? "viewCount" : "relevance", publishedAfter: new Date(Date.now() - days * 86_400_000).toISOString() });
  const search = await getJson(http, "YouTube", `https://www.googleapis.com/youtube/v3/search?${q}`, { headers });
  const ids = (Array.isArray(search?.items) ? search.items : []).map((i: any) => String(i?.id?.videoId ?? "")).filter((x: string) => /^[\w-]{6,20}$/.test(x));
  const stats = ids.length ? await getJson(http, "YouTube", `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(",")}`, { headers }) : {};
  return parseYouTube(search, stats);
}

/** One cheap read to prove a YouTube key works. */
export async function youtubeKeyWorks(http: typeof fetch, key: string): Promise<void> {
  await getJson(http, "YouTube", "https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=GB", { headers: { "x-goog-api-key": key } });
}

// ---------------------------------------------------------------- X (Twitter), recent search, app-only bearer token

export function parseX(json: any): Mention[] {
  const names = new Map<string, string>();
  for (const u of Array.isArray(json?.includes?.users) ? json.includes.users : []) if (/^[A-Za-z0-9_]{1,15}$/.test(String(u?.username))) names.set(String(u.id), String(u.username));
  const out: Mention[] = [];
  for (const t of Array.isArray(json?.data) ? json.data : []) {
    const id = String(t?.id ?? ""), who = names.get(String(t?.author_id ?? ""));
    if (!/^\d{1,25}$/.test(id) || !who) continue;
    const m = t.public_metrics ?? {};
    const text = clean(t.text, 400);
    out.push({ source: "x", title: text.slice(0, 200), url: `https://x.com/${who}/status/${id}`, community: `@${who}`, author: who, score: count(m.like_count) + count(m.retweet_count), comments: count(m.reply_count), createdAt: typeof t.created_at === "string" ? t.created_at.slice(0, 25) : "", snippet: text.length > 200 ? text.slice(200) : "" });
  }
  return out;
}

/** X only searches the last seven days, however long a window is asked for. */
export async function searchX(http: typeof fetch, bearer: string, o: SearchOptions): Promise<Mention[]> {
  const q = new URLSearchParams({
    query: `${o.query} -is:retweet`, max_results: String(Math.min(Math.max(o.limit, 10), 100)), sort_order: o.sort === "new" ? "recency" : "relevancy",
    "tweet.fields": "public_metrics,created_at,author_id", expansions: "author_id", "user.fields": "username",
  });
  return parseX(await getJson(http, "X", `https://api.x.com/2/tweets/search/recent?${q}`, { headers: { authorization: `Bearer ${bearer}` } }));
}

/** One small read to prove an X token works. */
export async function xTokenWorks(http: typeof fetch, bearer: string): Promise<void> {
  await getJson(http, "X", "https://api.x.com/2/users/by/username/X", { headers: { authorization: `Bearer ${bearer}` } });
}
