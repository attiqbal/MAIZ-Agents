import { createApp, makeToken, type Req, type Res } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { DATA_MINING_AGENT } from "../src/modules/data-mining/index.js";

const SECRET = "s3";
export const START = "2026-11-16T09:00:00Z";
export const WEEK_MS = 7 * 86_400_000;

/**
 * A pretend internet (the build machine cannot reach the real sources): a forum search and a news index, the two
 * sources that need no key. The test can add articles between weekly checks.
 */
export function fakeWeb() {
  const calls: string[] = [];
  const state = { articles: [{ title: "Coffee carts are booming", url: "https://news.example/coffee" }] };
  const http = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const host = new URL(u).host;
    if (host === "hn.algolia.com") return new Response(JSON.stringify({ hits: [{ objectID: "4242", title: "Ask HN: is a coffee cart worth it?", points: 31, num_comments: 12, created_at_i: 1_794_000_000, story_text: "We ran one for a year." }] }));
    if (host === "api.gdeltproject.org") return new Response(JSON.stringify({ articles: state.articles.map((a) => ({ ...a, domain: "news.example", seendate: "20261112T101500Z" })) }));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { http, calls, state };
}

/** The whole server with a pretend internet and a clock the test moves, driven through its routes like a browser would. */
export function miningApp() {
  const clock = { d: new Date(START) };
  const web = fakeWeb();
  const platform = createPlatform({ sessionSecret: SECRET, allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d, http: web.http });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  /** Signs a business up. With `hire`, the Data mining agent is accepted as an add-on on the plan screen. */
  const signUp = async (email: string, name: string, hire = true) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB", ...(hire ? { needs: ["know-my-market"], addOns: [DATA_MINING_AGENT] } : {}) });
    if (r.status !== 201) throw new Error(`sign-up failed: ${r.status}`);
    const userId = userIdFor(email);
    const ws = platform.identity.workspacesFor(userId)[0]!.id;
    return { auth: { authorization: `Bearer ${(r.body as { token: string }).token}` }, ws, userId, agent: platform.workforce.employeeIn(ws, DATA_MINING_AGENT) };
  };
  /** Runs a search the way the Market data screen does: ask, see the quote, confirm that exact figure. */
  const run = async (auth: Record<string, string>, body: Record<string, unknown>): Promise<Res> => {
    const asked = await call("POST", "/api/mining/run", body, auth);
    if (asked.status !== 409) return asked;
    return call("POST", "/api/mining/run", { ...body, confirm: true, confirmEnergy: (asked.body as { quote: { total: number } }).quote.total }, auth);
  };
  const after = (ms: number) => { clock.d = new Date(clock.d.getTime() + ms); };
  const tokenFor = (email: string) => ({ authorization: `Bearer ${makeToken(SECRET, { k: "session", u: userIdFor(email), e: email }, 7 * 86_400, clock.d.getTime())}` });
  return { platform, call, clock, web, signUp, run, after, tokenFor };
}
