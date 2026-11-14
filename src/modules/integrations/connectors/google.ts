import { IntegrationError, type Credentials, type OAuthApp } from "../types.js";

/**
 * Shared by the Google Analytics and Search Console connectors: one Google app for both (GOOGLE_DATA_CLIENT_ID),
 * read-only scopes, and a refresh token kept so the data keeps coming without the client signing in again.
 *
 * Google's rules (checked 2026-11): both scopes are "sensitive", so until Google has verified MAIZ's app only listed
 * test users can connect and their permission ends after 7 days. Google does not rotate refresh tokens.
 */
export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
/** `prompt=consent` makes Google hand over a refresh token every time; `include_granted_scopes=false` keeps the ask minimal. */
export const GOOGLE_PARAMS = { access_type: "offline", prompt: "consent", include_granted_scopes: "false" } as const;

async function tokenCall(http: typeof fetch, form: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
  let res: Response;
  try {
    res = await http(GOOGLE_TOKEN, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new IntegrationError("Google could not be reached. Try again in a minute.");
  }
  const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !o.access_token) {
    // invalid_grant: the permission was withdrawn or (while Google's review is pending) its 7 days ran out.
    throw new IntegrationError(o.error === "invalid_grant" ? "Google says the permission has ended. Please connect Google again." : "Google did not approve the connection. Please connect Google again.");
  }
  return { accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: new Date(Date.now() + (o.expires_in ?? 3600) * 1000).toISOString() };
}

export const googleExchange = async (http: typeof fetch, app: OAuthApp, code: string): Promise<Credentials> => ({
  kind: "oauth2",
  ...(await tokenCall(http, { grant_type: "authorization_code", code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri })),
});

export async function googleRefresh(http: typeof fetch, app: OAuthApp, creds: Credentials): Promise<Credentials> {
  if (creds.kind !== "oauth2" || !creds.refreshToken) throw new IntegrationError("Please connect Google again.");
  const t = await tokenCall(http, { grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: app.clientId, client_secret: app.clientSecret });
  return { ...creds, accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: creds.refreshToken };
}

/** One Google API call with the plain-English failures the owner can act on. */
export async function googleApi<T>(http: typeof fetch, accessToken: string, url: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await http(url, {
      method: init.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new IntegrationError("Google could not be reached. Try again in a minute.");
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { status?: string; message?: string; errors?: { reason?: string }[] } };
  if (res.ok) return json;
  const reason = json.error?.errors?.[0]?.reason ?? json.error?.status ?? "";
  if (res.status === 401) throw new IntegrationError("Google refused access. Please connect Google again.");
  if (res.status === 429 || /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reason)) throw new IntegrationError("Google asked us to slow down. Try again in a few minutes.");
  if (/SERVICE_DISABLED|accessNotConfigured/i.test(reason) || /has not been used|is disabled/i.test(json.error?.message ?? "")) throw new IntegrationError("This Google service is not switched on for MAIZ yet. MAIZ has been told.");
  if (res.status === 403) throw new IntegrationError("Google refused access to that account. Please connect Google again and tick every box on Google's screen.");
  throw new IntegrationError(`Google answered ${res.status}`);
}

/**
 * Text that came from the public (search phrases) or from a client's own settings (channel names) ends up in an
 * employee's instructions, so it is reduced to plain, short, quote-free words first.
 */
export function plainWords(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff<>`"'\\{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Best effort: tell Google the permission is no longer wanted. A failure changes nothing for the client. */
export async function googleRevoke(http: typeof fetch, creds: Credentials): Promise<void> {
  if (creds.kind !== "oauth2") return;
  const token = creds.refreshToken ?? creds.accessToken;
  try {
    await http("https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) });
  } catch { /* the client can also remove access in their Google account */ }
}
