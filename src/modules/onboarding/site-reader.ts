import { assertPublicHost } from "../integrations/connectors/util.js";
import { guessSector } from "./recommend.js";
import { OTHER_SECTOR } from "./sectors.js";

/**
 * Reads a business's own home page at signup, so the owner does not have to type what the page already says:
 * the business name, what it does, the kind of business, the apps the site runs on and its social pages.
 *
 * The address comes from a stranger, so it is treated as hostile: https only, a real public name that does not
 * point inside a network (checked again on every redirect), a short timeout and only the first part of the page.
 * What comes back is plain text, clipped, and is only ever a suggestion the owner can change.
 */
export class SiteReadError extends Error {}

export interface SiteReading {
  /** The host that was read, for example "kestrelcoffee.co.uk". */
  site: string;
  name?: string;
  about?: string;
  /** A sector key from the signup list, when the page makes it clear. */
  sector?: string;
  /** Keys from the signup app list that the page visibly uses. */
  apps: string[];
  /** Social networks the page links to, by name. */
  socials: string[];
}

export interface SiteReaderDeps { http?: typeof fetch }

const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;
/** Enough for the head and the top of the page; the rest is never downloaded. */
const MAX_BYTES = 400_000;
/**
 * Words about the business are only looked for near the top, and every tag is found by position inside a small
 * window. A page is written by a stranger, so nothing here may take longer on a page built to be slow to read.
 */
const TEXT_BYTES = 64_000;
const TAG_MAX = 600;
const INNER_MAX = 1_000;
const META_TAGS_MAX = 200;
const NAME_MAX = 80;
const ABOUT_MAX = 240;
const ADDRESS_MAX = 200;
/** Says who is asking, the way any polite reader of public pages does. Carries nothing about the person signing up. */
const USER_AGENT = "MAIZAgentsSetup/1.0 (+https://maizagents.com)";

/** What a page loads or links to when it runs on one of the apps offered at signup. */
const APP_MARKS: readonly [key: string, mark: RegExp][] = [
  ["shopify", /cdn\.shopify\.com|myshopify\.com/i],
  ["woocommerce", /woocommerce|wc-ajax/i],
  ["stripe", /js\.stripe\.com|buy\.stripe\.com/i],
  ["paypal", /paypal\.com\/sdk|paypalobjects\.com/i],
  ["square", /squareup\.com|square\.site|squarecdn\.com/i],
  ["sumup", /sumup\.(com|link)/i],
  ["gocardless", /pay\.gocardless\.com/i],
];
const SOCIAL_MARKS: readonly [name: string, mark: RegExp][] = [
  ["Instagram", /https?:\/\/(www\.)?instagram\.com\/[\w.]+/i],
  ["Facebook", /https?:\/\/(www\.)?facebook\.com\/[\w.-]+/i],
  ["TikTok", /https?:\/\/(www\.)?tiktok\.com\/@[\w.]+/i],
  ["LinkedIn", /https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[\w-]+/i],
  ["YouTube", /https?:\/\/(www\.)?youtube\.com\/(@|channel\/|c\/)[\w-]+/i],
  ["X", /https?:\/\/(www\.)?(twitter|x)\.com\/\w+/i],
];
const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", "#39": "'", "#039": "'", nbsp: " ", ndash: "-", mdash: "-", lt: "", gt: "", pound: "£", euro: "€" };
/** Words a page title carries that are not the business's name. */
const TITLE_NOISE = /^(home|homepage|welcome|welcome to|official site|official website|index)$/i;

/** Tags and scripts out, entities to characters, one line, no angle brackets, clipped. */
function plainText(raw: string | undefined, max: number): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .slice(0, INNER_MAX)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#?\w+);/g, (_m, name: string) => ENTITIES[name.toLowerCase()] ?? " ")
    .replace(/[<>\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Same length as the page, so a position found in it is the same position in the page. */
const lowerAscii = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
const endsTagName = (ch: string): boolean => ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/** Where the tag that opens at `open` closes, looking only a short way ahead. */
function tagEnd(lower: string, open: number): number {
  const at = lower.slice(open, open + TAG_MAX).indexOf(">");
  return at < 0 ? -1 : open + at;
}

/** What sits between the first `<name ...>` and its closing tag, clipped. */
function innerOf(html: string, lower: string, name: string): string | undefined {
  let from = 0;
  for (let tries = 0; tries < META_TAGS_MAX; tries++) {
    const open = lower.indexOf(`<${name}`, from);
    if (open < 0) return undefined;
    from = open + name.length + 1;
    if (!endsTagName(lower.charAt(from))) continue; // "<titlebar>" is not "<title>"
    const end = tagEnd(lower, open);
    if (end < 0) continue;
    const inner = html.slice(end + 1, end + 1 + INNER_MAX);
    const close = lowerAscii(inner).indexOf(`</${name}`);
    return close < 0 ? inner : inner.slice(0, close);
  }
  return undefined;
}

/** The page's `<meta>` tags near the top, each one short. */
function metaTags(html: string, lower: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (let tries = 0; tries < META_TAGS_MAX; tries++) {
    const open = lower.indexOf("<meta", from);
    if (open < 0) break;
    from = open + 5;
    if (!endsTagName(lower.charAt(from))) continue;
    const end = tagEnd(lower, open);
    if (end >= 0) tags.push(html.slice(open, end + 1));
  }
  return tags;
}

function metaContent(tags: readonly string[], name: string): string | undefined {
  const tag = tags.find((t) => /\b(?:name|property)\s*=\s*["']?([\w:.-]+)/i.exec(t)?.[1]?.toLowerCase() === name);
  return tag ? /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)?.slice(1).find((v) => v !== undefined) : undefined;
}

/** "Home - Bright Dental Studio" and "Kestrel Coffee | Roasters in Leeds" both name the business in one of their parts. */
function nameFromTitle(title: string | undefined): string | undefined {
  const parts = (title ?? "").split(/\s+[|\-–—·:]\s+/).map((p) => p.trim()).filter((p) => p && !TITLE_NOISE.test(p));
  return parts[0];
}

/** Pure: what a home page says about the business. No network, so it is easy to test. */
export function understand(pageHtml: string, site: string): SiteReading {
  const head = pageHtml.slice(0, MAX_BYTES);
  // Scripts and styles are code, not words about the business; they are only looked at for which apps they load.
  const words = head.slice(0, TEXT_BYTES).replace(/<(script|style|noscript|template)\b[\s\S]*?(<\/\1>|$)/gi, " ");
  const lower = lowerAscii(words);
  const tags = metaTags(words, lower);
  const title = plainText(innerOf(words, lower, "title"), 200);
  const heading = plainText(innerOf(words, lower, "h1"), 200);
  const name = plainText(metaContent(tags, "og:site_name") ?? nameFromTitle(title), NAME_MAX);
  const about = plainText(metaContent(tags, "description") ?? metaContent(tags, "og:description"), ABOUT_MAX);
  const sector = guessSector([title, heading, about].filter(Boolean).join(". "));
  return {
    site,
    ...(name ? { name } : {}),
    ...(about ? { about } : {}),
    ...(sector !== OTHER_SECTOR ? { sector } : {}),
    apps: APP_MARKS.filter(([, mark]) => mark.test(head)).map(([key]) => key),
    socials: SOCIAL_MARKS.filter(([, mark]) => mark.test(head)).map(([label]) => label),
  };
}

/** The home page of a normal public https site, or an error. Paths and queries are dropped: only the front page is read. */
function homePage(input: string): URL {
  const typed = input.trim().slice(0, ADDRESS_MAX);
  if (/^[a-z][a-z0-9+.-]*:/i.test(typed) && !/^https?:\/\//i.test(typed)) throw new SiteReadError("not a web address");
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`); } catch { throw new SiteReadError("not a web address"); }
  const host = u.hostname.toLowerCase();
  const normal = u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443")
    && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !/\.(local|internal|localhost|lan|home|corp|test|invalid)$/.test(host) && !/^\d+(\.\d+){3}$/.test(host);
  if (!normal) throw new SiteReadError("not a public https website");
  return new URL(`https://${host}/`);
}

/** Reads at most MAX_BYTES of the body, then stops the download. */
async function firstPart(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8");
}

/** Fetches the home page of `address` and returns what it says. Throws SiteReadError for anything it will not or cannot read. */
export async function readSite(address: string, deps: SiteReaderDeps = {}): Promise<SiteReading> {
  const http = deps.http ?? fetch;
  let url = homePage(typeof address === "string" ? address : "");
  const site = url.hostname.replace(/^www\./, "");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Checked before every request, so a redirect cannot lead inside a network.
    try { await assertPublicHost(url.hostname, "That website"); } catch { throw new SiteReadError("not reachable"); }
    let res: Response;
    try {
      res = await http(url.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/html", "user-agent": USER_AGENT } });
    } catch { throw new SiteReadError("not reachable"); }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!next) throw new SiteReadError("redirect with no address");
      let target: URL;
      try { target = new URL(next, url); } catch { throw new SiteReadError("redirect to a bad address"); }
      // Only the front page of the new host is read, and only if it passes the same checks.
      url = homePage(target.protocol === "https:" ? `https://${target.host}` : target.toString());
      continue;
    }
    if (!res.ok) throw new SiteReadError("the site answered with an error");
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) throw new SiteReadError("not a web page");
    return understand(await firstPart(res), site);
  }
  throw new SiteReadError("too many redirects");
}
