import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { IntegrationError, type ConnectorContext } from "../types.js";

/** Small helpers shared by the customer-app connectors. Each connector stays a few lines of mapping. */
export const DAY_MS = 86_400_000;
const TIMEOUT_MS = 20_000;

export const dayOf = (d: Date | string | number): string => new Date(d).toISOString().slice(0, 10);
/** True when a timestamp falls on or between the two YYYY-MM-DD dates. */
export const inRange = (stamp: string | number | undefined, from: string, to: string): boolean => {
  if (stamp === undefined || stamp === "") return false;
  const t = typeof stamp === "number" ? stamp : Date.parse(stamp);
  if (!Number.isFinite(t)) return false;
  const d = dayOf(t);
  return d >= from && d <= to;
};

/** Only these app addresses may be called with a client's key: https, a plain host name, no credentials in the address. */
export function safeHost(host: string, allowed: RegExp, what: string): string {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!allowed.test(h)) throw new IntegrationError(`That ${what} does not look right. Copy it again from the address bar.`);
  return h;
}

export interface JsonReply { status: number; body: any }

/** One GET that never follows a redirect (a key must only reach the address we chose) and times out. */
export async function getJson(ctx: ConnectorContext, url: string, headers: Record<string, string>, app: string): Promise<any> {
  const r = await send(ctx, url, { headers: { accept: "application/json", ...headers } }, app);
  return r;
}

export async function postJson(ctx: ConnectorContext, url: string, body: unknown, headers: Record<string, string>, app: string): Promise<any> {
  return send(ctx, url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, app);
}

async function send(ctx: ConnectorContext, url: string, init: RequestInit, app: string): Promise<any> {
  let res: Response;
  try {
    res = await ctx.http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new IntegrationError(`${app} could not be reached. Try again in a minute.`);
  }
  if (res.status === 401 || res.status === 403) throw new IntegrationError(`${app} refused access. Please connect ${app} again, and check the key can read.`);
  if (res.status === 429) throw new IntegrationError(`${app} asked us to slow down. Try again in a few minutes.`);
  if (!res.ok) throw new IntegrationError(`${app} answered ${res.status}`);
  try { return await res.json(); } catch { throw new IntegrationError(`${app} sent something we could not read`); }
}

/** Every date from `from` to `to`, inclusive, capped at a year. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from), end = Date.parse(to); t <= end && out.length < 366; t += DAY_MS) out.push(dayOf(t));
  return out;
}

export function oauth(ctx: ConnectorContext, app: string): { accessToken: string; tenant?: string } {
  if (ctx.credentials.kind !== "oauth2") throw new IntegrationError(`${app} needs a one-click connection`);
  return { accessToken: ctx.credentials.accessToken, tenant: ctx.credentials.tenant };
}

export function keys(ctx: ConnectorContext, app: string): Record<string, string> {
  if (ctx.credentials.kind !== "api_key") throw new IntegrationError(`${app} needs a key`);
  return ctx.credentials.values;
}

/** Refresh for apps that use the standard refresh_token form exchange (HubSpot, Calendly, Microsoft). */
export function standardRefresh(tokenUrl: string, basic = false) {
  return async (http: typeof fetch, app: { clientId: string; clientSecret: string }, creds: import("../types.js").Credentials): Promise<import("../types.js").Credentials> => {
    if (creds.kind !== "oauth2" || !creds.refreshToken) throw new IntegrationError("Please connect the app again.");
    const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: creds.refreshToken };
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (basic) headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
    else { form.client_id = app.clientId; form.client_secret = app.clientSecret; }
    const res = await http(tokenUrl, { method: "POST", headers, body: new URLSearchParams(form), redirect: "error" });
    const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !o.access_token) throw new IntegrationError("The app did not renew the connection. Please connect it again.");
    // Rotating refresh tokens must replace the old one.
    return { ...creds, accessToken: o.access_token, refreshToken: o.refresh_token ?? creds.refreshToken, expiresAt: new Date(Date.now() + (o.expires_in ?? 1800) * 1000).toISOString() };
  };
}

/** A shop or site address typed by a client: https, a real public name, never an address inside our network. */
export function publicSite(input: string, what: string): URL {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`); } catch { throw new IntegrationError(`That ${what} does not look right.`); }
  const h = u.hostname.toLowerCase();
  const bad = u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /\.(local|internal|localhost|lan|home|corp)$/.test(h) || /^\d+(\.\d+){3}$/.test(h);
  if (bad) throw new IntegrationError(`That ${what} must be a normal https address such as https://myshop.co.uk.`);
  return new URL(`https://${h}`);
}

/** Builds ActivityDay records one count at a time. */
export class DayBook {
  private days = new Map<string, import("../types.js").ActivityDay>();
  constructor(private area: import("../types.js").ActivityArea, private currency: string) {}
  add(date: string, key: string, n = 1): void {
    const d = this.days.get(date) ?? { date, area: this.area, currency: this.currency, figures: {} };
    d.figures[key] = (d.figures[key] ?? 0) + n;
    this.days.set(date, d);
  }
  /** Sets a snapshot figure (open deals now) on one date. */
  set(date: string, key: string, n: number): void {
    const d = this.days.get(date) ?? { date, area: this.area, currency: this.currency, figures: {} };
    d.figures[key] = n;
    this.days.set(date, d);
  }
  list(): import("../types.js").ActivityDay[] { return [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date)); }
}

export const toMinor = (v: unknown): number => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0; return Number.isFinite(n) ? Math.round(n * 100) : 0; };

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses (IPv4 and IPv6). */
export function isPrivateIp(ip: string): boolean {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? (isIP(ip) === 4 ? ip : undefined);
  if (v4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const l = ip.toLowerCase();
  return l === "::" || l === "::1" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith("ff");
}

let resolver: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address);
/** For tests: replace the DNS lookup. */
export function setHostResolver(fn: (host: string) => Promise<string[]>): void { resolver = fn; }

/**
 * Before calling a client's own website, resolve its name and refuse anything that points inside a network.
 * Known limit: the name is resolved again by the HTTP client, so a hostile DNS server could change its answer in
 * between (rebinding). Run the API server where private networks are unreachable as well.
 */
export async function assertPublicHost(host: string, app: string): Promise<void> {
  let addrs: string[];
  try { addrs = await resolver(host); } catch { throw new IntegrationError(`${app} could not be reached. Check the address.`); }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new IntegrationError(`${app} could not be reached. Check the address.`);
}

/** A next-page link is followed only when it is https on exactly the host we have been talking to. */
export function sameHttpsHost(link: string | undefined | null, host: string): string | undefined {
  if (!link) return undefined;
  try { const u = new URL(link); return u.protocol === "https:" && u.host === host ? u.toString() : undefined; } catch { return undefined; }
}
