import { IntegrationError, type Credentials, type OAuthApp } from "../types.js";

/**
 * Token calls for the connectors that need their own shape (PKCE, no secret, key in the address). They answer in plain
 * words with the provider's own short error code, so an owner who gets a "no" can see what to fix.
 */
const TIMEOUT_MS = 20_000;
const SHORT_CODE = /^[\w.:-]{1,60}$/;

export interface TokenReply { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; error?: unknown; error_description?: unknown; [k: string]: unknown }
export interface TokenOptions {
  /** Send id and secret as a Basic header instead of in the form. */
  basic?: boolean;
  /** Providers such as Etsy take no secret at the token address. */
  noSecret?: boolean;
  /** Put the form in the address and use GET (Meta documents it that way). */
  get?: boolean;
  /** The form field that carries the app's id (TikTok calls it client_key). */
  idField?: string;
}

const HINTS: Record<string, string> = {
  invalid_client: "Check the Client ID and secret on this site's Connections page.",
  invalid_client_id: "The provider does not know that Client ID. Check it, and wait a few minutes if the app is new.",
  bad_client_secret: "The secret is wrong. Copy it again in full.",
  invalid_grant: "The sign-in code ran out or was already used. Please connect again.",
  redirect_uri_mismatch: "The redirect address saved with the provider differs from the one on this site's Connections page.",
  invalid_request: "The provider did not accept the request. Check the redirect address and permissions saved with it.",
  unauthorized_client: "The provider says this app may not use this kind of sign-in. Check the app's settings there.",
  access_denied: "The permission was refused.",
};

/** What a person sees: who said no, the provider's own code (only when it looks like one), and what to try. */
export function sayNo(name: string, error: unknown): string {
  const code = typeof error === "string" && SHORT_CODE.test(error) ? error : "";
  const hint = code ? HINTS[code] ?? "" : "";
  return `${name} did not approve the connection${code ? ` (it answered: ${code})` : ""}. ${hint}`.trim();
}

export async function tokenCall(http: typeof fetch, name: string, url: string, form: Record<string, string>, app: OAuthApp, opts: TokenOptions = {}): Promise<TokenReply> {
  const body: Record<string, string> = { ...form };
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.basic) headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  else {
    body[opts.idField ?? "client_id"] = app.clientId;
    if (!opts.noSecret) body.client_secret = app.clientSecret;
  }
  let res: Response;
  try {
    if (opts.get) res = await http(`${url}?${new URLSearchParams(body)}`, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    else res = await http(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  } catch {
    throw new IntegrationError(`${name} could not be reached. Try again in a minute.`);
  }
  if (res.status === 429) throw new IntegrationError(`${name} asked us to slow down. Try again in a few minutes.`);
  const o = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok || typeof o.access_token !== "string" || !o.access_token) throw new IntegrationError(sayNo(name, o.error));
  return o;
}

export const expiresIn = (seconds: unknown, fallback: number): string => new Date(Date.now() + (typeof seconds === "number" && seconds > 0 ? seconds : fallback) * 1000).toISOString();

export const asCredentials = (o: TokenReply, fallbackSeconds: number, extra: { tenant?: string } = {}): Credentials => ({
  kind: "oauth2", accessToken: o.access_token!, refreshToken: typeof o.refresh_token === "string" ? o.refresh_token : undefined, expiresAt: expiresIn(o.expires_in, fallbackSeconds), ...extra,
});

/** A refresh that replaces the refresh token when the provider hands out a new one, and keeps the old one when it does not. */
export function makeRefresh(name: string, tokenUrl: string, opts: TokenOptions & { fallbackSeconds?: number } = {}) {
  return async (http: typeof fetch, app: OAuthApp, creds: Credentials): Promise<Credentials> => {
    if (creds.kind !== "oauth2" || !creds.refreshToken) throw new IntegrationError(`Please connect ${name} again.`);
    let o: TokenReply;
    try {
      o = await tokenCall(http, name, tokenUrl, { grant_type: "refresh_token", refresh_token: creds.refreshToken }, app, opts);
    } catch (e) {
      throw new IntegrationError(e instanceof IntegrationError && /slow down|reached/.test(e.message) ? e.message : `${name} did not renew the connection. Please connect ${name} again.`);
    }
    return { ...creds, accessToken: o.access_token!, refreshToken: typeof o.refresh_token === "string" ? o.refresh_token : creds.refreshToken, expiresAt: expiresIn(o.expires_in, opts.fallbackSeconds ?? 3600) };
  };
}

/** Standard exchange for a provider that wants the code, the redirect address and (optionally) the PKCE proof. */
export async function exchange(http: typeof fetch, name: string, url: string, app: OAuthApp, code: string, verifier: string | undefined, opts: TokenOptions & { redirect?: string; fallbackSeconds?: number } = {}): Promise<{ credentials: Credentials; raw: TokenReply }> {
  const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: opts.redirect ?? app.redirectUri, ...(verifier ? { code_verifier: verifier } : {}) };
  const raw = await tokenCall(http, name, url, form, app, opts);
  return { credentials: asCredentials(raw, opts.fallbackSeconds ?? 3600), raw };
}
