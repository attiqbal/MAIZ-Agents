import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

/** Content types for the files Vite emits into web/dist. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
};

export interface HeaderRule { pattern: string; headers: Record<string, string> }

/**
 * Reads the Netlify/Cloudflare-style `_headers` file that the website ships (web/public/_headers),
 * so the Node server sends exactly the same security headers as a static host would.
 */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: {} }); continue; }
    const rule = rules[rules.length - 1];
    const i = line.indexOf(":");
    if (rule && i > 0) rule.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}

const matches = (pattern: string, path: string) =>
  pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

export function headersFor(rules: HeaderRule[], path: string): Record<string, string> {
  return Object.assign({}, ...rules.filter((r) => matches(r.pattern, path)).map((r) => r.headers));
}

export interface StaticFile { status: number; headers: Record<string, string>; body: Buffer }

/** Serves the built website from `root`. Returns undefined when there is no site (API-only mode). */
export function createStatic(root: string) {
  const base = resolve(root);
  if (!existsSync(join(base, "index.html"))) return undefined;
  const rulesFile = join(base, "_headers");
  const rules = existsSync(rulesFile) ? parseHeaders(readFileSync(rulesFile, "utf8")) : [];

  const fileFor = (urlPath: string): string | undefined => {
    let p: string;
    try { p = decodeURIComponent(urlPath); } catch { return undefined; }
    if (p.includes("\0")) return undefined;
    if (p.endsWith("/")) p += "index.html";
    const candidates = [p, extname(p) ? undefined : `${p}.html`].filter(Boolean) as string[];
    for (const c of candidates) {
      const full = resolve(base, "." + normalize(c));
      if (full !== base && !full.startsWith(base + sep)) return undefined; // no path traversal
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
    return undefined;
  };

  return function serve(urlPath: string): StaticFile {
    const file = fileFor(urlPath);
    const hidden = file?.endsWith(`${sep}_headers`);
    const target = file && !hidden ? file : join(base, "404.html");
    const status = file && !hidden ? 200 : 404;
    const type = TYPES[extname(target)] ?? "application/octet-stream";
    const cache: Record<string, string> = type.startsWith("text/html") ? { "Cache-Control": "no-cache" } : {};
    return {
      status,
      headers: { "Content-Type": type, ...cache, ...headersFor(rules, urlPath) },
      body: existsSync(target) ? readFileSync(target) : Buffer.from("not found"),
    };
  };
}
