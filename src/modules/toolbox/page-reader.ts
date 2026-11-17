import { SiteReadError, fetchPublicHtml, publicPage } from "../onboarding/site-reader.js";
import { ToolError, plain } from "./providers.js";

/**
 * Reads the words of one public web page for an employee, through the same guarded reader that reads a business's
 * home page at signup: https only, a real public host checked before every request and every redirect, a short time
 * limit and only the first part of the page. What comes back is plain text written by a stranger, so it is clipped
 * and only ever used as reference with its address, never as instructions.
 */
export interface PageText { url: string; title: string; text: string }

export const PAGE_TEXT_MAX = 6_000;
const TITLE_MAX = 160;
const SKIPPED = ["script", "style", "noscript", "template", "svg", "head"];

/** Tags out, in one pass over the page with no backtracking, so a page built to be slow to read cannot hold the server. */
export function wordsOf(html: string, max = PAGE_TEXT_MAX): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let size = 0;
  let at = 0;
  // Three times the limit is collected before tidying, because entities and repeated spaces shrink.
  while (at < html.length && size < max * 3) {
    const open = html.indexOf("<", at);
    const text = html.slice(at, open < 0 ? html.length : open);
    if (text) { out.push(text); size += text.length; }
    if (open < 0) break;
    const name = /^<([a-z0-9]+)/.exec(lower.slice(open, open + 12))?.[1] ?? "";
    if (SKIPPED.includes(name)) {
      const close = lower.indexOf(`</${name}`, open);
      if (close < 0) break;
      at = close;
    }
    const end = html.indexOf(">", Math.max(at, open));
    if (end < 0) break;
    out.push(" ");
    at = end + 1;
  }
  const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", "#39": "'", nbsp: " ", pound: "£", euro: "€", ndash: "-", mdash: "-" };
  return plain(out.join("").replace(/&(#?\w{1,8});/g, (_m, n: string) => entities[n.toLowerCase()] ?? " "), max);
}

function titleOf(html: string): string {
  const lower = html.slice(0, 20_000).toLowerCase();
  const open = lower.indexOf("<title");
  const start = open < 0 ? -1 : lower.indexOf(">", open);
  const end = start < 0 ? -1 : lower.indexOf("</title", start);
  return start < 0 || end < 0 ? "" : plain(html.slice(start + 1, Math.min(end, start + 1 + 400)), TITLE_MAX);
}

export async function readPage(address: string, http: typeof fetch = fetch): Promise<PageText> {
  try {
    const start = publicPage(typeof address === "string" ? address : "");
    const { html, url } = await fetchPublicHtml(start, (target) => publicPage(target.toString()), http);
    const text = wordsOf(html);
    if (text.length < 40) throw new ToolError("That page has no words we can read. It may need a login, or it is built in a way a simple reader cannot see.");
    return { url: url.toString(), title: titleOf(html) || url.hostname, text };
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e instanceof SiteReadError) throw new ToolError(`That page could not be read (${e.message}). It must be a public https web page.`);
    throw e;
  }
}
