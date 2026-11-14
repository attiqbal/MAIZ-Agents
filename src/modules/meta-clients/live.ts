import { createHmac } from "node:crypto";
import { MetaGraph, MetaRejected, type PublishInput } from "../meta/index.js";
import { scopeParam } from "./permissions.js";
import { isRateLimit, MetaThrottled, MetaTokenInvalid, type MetaProvider } from "./provider.js";
import type { AccountInsights, ExchangeResult, FoundAsset, MetaConnection, MetaKind, MetaSecret, PostResults, Published } from "./types.js";

export interface LiveConfig {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id (the permissions are set on that configuration in Meta's dashboard). */
  loginConfigId?: string;
  version?: string;
}

const DEFAULT_WAIT_MS = 30 * 60_000;

/** The real Meta Graph API. Tokens travel in an Authorization header and every call carries appsecret_proof. */
export class LiveProvider implements MetaProvider {
  readonly mode = "live" as const;
  constructor(private readonly cfg: LiveConfig, private readonly http: typeof fetch = fetch) {}

  private base(): string { return `https://graph.facebook.com/${this.cfg.version ?? "v23.0"}`; }
  private proof(token: string): string { return createHmac("sha256", this.cfg.appSecret).update(token).digest("hex"); }

  private async call(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>, token?: string): Promise<any> {
    const all = { ...params, ...(token ? { appsecret_proof: this.proof(token) } : {}) };
    const qs = new URLSearchParams(all).toString();
    let res: Response;
    try {
      res = await this.http(method === "POST" ? `${this.base()}${path}` : `${this.base()}${path}?${qs}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        body: method === "POST" ? qs : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new MetaRejected("Meta could not be reached just now"); }
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    if (!res.ok || json?.error) throw mapError(json?.error, res.status, token);
    return json;
  }

  authorizeUrl(kind: MetaKind, state: string, redirectUri: string): string {
    const u = new URL(`https://www.facebook.com/${this.cfg.version ?? "v23.0"}/dialog/oauth`);
    u.searchParams.set("client_id", this.cfg.appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    if (this.cfg.loginConfigId) { u.searchParams.set("config_id", this.cfg.loginConfigId); u.searchParams.set("override_default_response_type", "true"); }
    else u.searchParams.set("scope", scopeParam(kind));
    return u.toString();
  }

  private async userToken(code: string, redirectUri?: string): Promise<string> {
    const short = await this.call("POST", "/oauth/access_token", { client_id: this.cfg.appId, client_secret: this.cfg.appSecret, code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) });
    if (typeof short?.access_token !== "string") throw new MetaRejected("Meta did not give an access token");
    const long = await this.call("POST", "/oauth/access_token", { grant_type: "fb_exchange_token", client_id: this.cfg.appId, client_secret: this.cfg.appSecret, fb_exchange_token: short.access_token });
    return typeof long?.access_token === "string" ? long.access_token : short.access_token;
  }

  async exchange(kind: MetaKind, code: string, redirectUri: string): Promise<ExchangeResult> {
    const token = await this.userToken(code, redirectUri);
    const me = await this.call("GET", "/me", { fields: "id,name" }, token);
    const perms = await this.call("GET", "/me/permissions", {}, token);
    const scopes: string[] = (perms?.data ?? []).filter((p: any) => p?.status === "granted").map((p: any) => String(p.permission));
    const accounts = await this.call("GET", "/me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username,name}", limit: "100" }, token);
    const assets: FoundAsset[] = [];
    for (const a of accounts?.data ?? []) {
      if (typeof a?.id !== "string" || typeof a?.access_token !== "string") continue;
      if (kind === "facebook") assets.push({ kind, externalId: a.id, name: String(a.name ?? a.id).slice(0, 120), accessToken: a.access_token });
      const ig = a.instagram_business_account;
      if (kind === "instagram" && typeof ig?.id === "string") assets.push({ kind, externalId: ig.id, name: String(ig.name ?? ig.username ?? ig.id).slice(0, 120), handle: ig.username ? `@${ig.username}` : undefined, accessToken: a.access_token, pageId: a.id });
    }
    return { metaUserId: String(me?.id ?? ""), scopes, assets };
  }

  async exchangeWhatsApp(code: string, wabaId: string, phoneNumberId: string): Promise<FoundAsset> {
    const token = await this.userToken(code);
    const phone = await this.call("GET", `/${phoneNumberId}`, { fields: "display_phone_number,verified_name" }, token);
    // Subscribe our app to this account's webhooks so replies reach /api/meta/webhook.
    await this.call("POST", `/${wabaId}/subscribed_apps`, {}, token);
    return { kind: "whatsapp", externalId: phoneNumberId, name: String(phone?.verified_name ?? "WhatsApp Business").slice(0, 120), accessToken: token, wabaId, phoneNumberId, displayNumber: String(phone?.display_phone_number ?? "") };
  }

  async inspect(secret: MetaSecret): Promise<{ valid: boolean; scopes: string[]; expiresAt?: string }> {
    const r = await this.call("GET", "/debug_token", { input_token: secret.accessToken }, `${this.cfg.appId}|${this.cfg.appSecret}`).catch((e) => { if (e instanceof MetaTokenInvalid) return undefined; throw e; });
    const d = r?.data;
    if (!d?.is_valid) return { valid: false, scopes: [] };
    // Page tokens from a long-lived login have expires_at 0 (no expiry); data_access_expires_at is the 90-day window Meta enforces.
    const ts = Number(d.expires_at) || Number(d.data_access_expires_at) || 0;
    return { valid: true, scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [], expiresAt: ts ? new Date(ts * 1000).toISOString() : undefined };
  }

  private graphFor(conn: MetaConnection, s: MetaSecret): MetaGraph {
    return new MetaGraph({ accessToken: s.accessToken, appSecret: this.cfg.appSecret, version: this.cfg.version, ...(conn.kind === "facebook" ? { pageId: conn.externalId } : { instagramId: conn.externalId }) }, this.http);
  }

  async publish(conn: MetaConnection, s: MetaSecret, input: PublishInput): Promise<Published> {
    try {
      const p = await this.graphFor(conn, s).publish(input);
      return { id: p.id, url: p.url, simulated: false };
    } catch (e) { throw translate(e); }
  }

  async results(conn: MetaConnection, s: MetaSecret, postId: string, now: Date): Promise<PostResults> {
    try { return await this.graphFor(conn, s).stats(conn.kind as "facebook" | "instagram", postId, now); } catch (e) { throw translate(e); }
  }

  async insights(conn: MetaConnection, s: MetaSecret, now: Date): Promise<AccountInsights> {
    const fields = conn.kind === "instagram" ? "followers_count" : "followers_count,fan_count";
    const r = await this.call("GET", `/${conn.externalId}`, { fields }, s.accessToken);
    return { followers: Number(r?.followers_count ?? r?.fan_count ?? 0), fetchedAt: now.toISOString() };
  }

  async sendWhatsApp(conn: MetaConnection, s: MetaSecret, to: string, m: { text: string } | { template: { name: string; language: string }; body: string }): Promise<void> {
    const body = "template" in m
      ? { type: "template", template: { name: m.template.name, language: { code: m.template.language }, components: [{ type: "body", parameters: [{ type: "text", text: m.body.replace(/[\n\r\t]+/g, " ").slice(0, 900) }] }] } }
      : { type: "text", text: { body: m.text.slice(0, 4000), preview_url: false } };
    let res: Response;
    try {
      res = await this.http(`${this.base()}/${conn.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new MetaRejected("WhatsApp could not be reached just now"); }
    if (!res.ok) {
      let err: any; try { err = (await res.json() as any)?.error; } catch { /* keep status */ }
      throw mapError(err, res.status, s.accessToken);
    }
  }

  async revoke(conn: MetaConnection, s: MetaSecret): Promise<void> {
    try {
      if (conn.kind === "whatsapp" && conn.wabaId) await this.call("DELETE", `/${conn.wabaId}/subscribed_apps`, {}, s.accessToken);
      else await this.call("DELETE", "/me/permissions", {}, s.accessToken);
    } catch { /* best effort: the grant also ends when the client removes MAIZ in their Facebook settings */ }
  }
}

function mapError(err: any, status: number, token?: string): Error {
  const code = typeof err?.code === "number" ? err.code : status === 429 ? 4 : undefined;
  const reason = String(err?.error_user_msg ?? err?.message ?? `error ${status}`).replace(token ?? "\u0000", "[token]").slice(0, 300);
  if (code === 190 || status === 401) return new MetaTokenInvalid(reason);
  if (isRateLimit(code)) return new MetaThrottled(reason, DEFAULT_WAIT_MS);
  return new MetaRejected(`Meta said no: ${reason}`, code);
}

function translate(e: unknown): unknown {
  if (e instanceof MetaRejected) {
    if (e.code === 190) return new MetaTokenInvalid(e.message);
    if (isRateLimit(e.code)) return new MetaThrottled(e.message, DEFAULT_WAIT_MS);
  }
  return e;
}
