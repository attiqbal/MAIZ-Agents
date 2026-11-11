import { createHash, createHmac } from "node:crypto";

/**
 * Sign in with Google or Microsoft (OpenID Connect, authorization code flow with PKCE).
 *
 * The provider only tells us which email address the person controls. We never keep their provider
 * tokens: once the email is proven we hand the browser the same one-time sign-in link an emailed one
 * would be, so there is one way to become signed in and one place that issues sessions.
 *
 * Safety rules, each with a test:
 * - the ID token must come straight from the provider's token endpoint (never from the browser);
 * - issuer, audience, expiry and nonce are all checked;
 * - the email must be one the provider says it verified. Microsoft's `email` claim alone is NOT proof
 *   (anyone can set it in a tenant they control), so a work account is accepted only when Microsoft
 *   marks the address verified (`xms_edov`); personal Microsoft accounts are verified by Microsoft.
 */
export type LoginProvider = "google" | "microsoft";
export const LOGIN_PROVIDERS: readonly LoginProvider[] = ["google", "microsoft"];

export interface LoginApp {
  clientId: string;
  clientSecret: string;
  /** Microsoft only: "common" (any work or personal account), or one tenant's id. */
  tenant?: string;
}
export type LoginApps = Partial<Record<LoginProvider, LoginApp>>;

/** The tenant id Microsoft uses for personal accounts (outlook.com, hotmail.com, live.com). */
const MICROSOFT_PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const TENANT_ID = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TENANT_NAME = /^(common|organizations|consumers|[a-z0-9][a-z0-9.-]{0,79})$/i;

export const isLoginProvider = (v: string | undefined): v is LoginProvider => v === "google" || v === "microsoft";

/** Providers whose id and secret are both set. Setting only one is caught at start-up (checkEnv). */
export function loginAppsFromEnv(env: Record<string, string | undefined>): LoginApps {
  const apps: LoginApps = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) apps.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    const tenant = env.MICROSOFT_TENANT?.trim() || "common";
    apps.microsoft = { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenant: TENANT_NAME.test(tenant) ? tenant : "common" };
  }
  return apps;
}

/** Start-up problems with the login settings. */
export function loginEnvProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const prefix of ["GOOGLE", "MICROSOFT"]) {
    const pair = [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`];
    if (pair.filter((k) => env[k]).length === 1) problems.push(`${pair.join(" and ")} must be set together (or neither)`);
  }
  if (env.MICROSOFT_TENANT && !TENANT_NAME.test(env.MICROSOFT_TENANT.trim())) problems.push("MICROSOFT_TENANT must be common, organizations, consumers, or a tenant id/domain");
  if ((env.GOOGLE_CLIENT_ID || env.MICROSOFT_CLIENT_ID) && !env.APP_URL) problems.push("APP_URL is required for Google or Microsoft sign-in (it builds the return address)");
  return problems;
}

/** Where the provider sends the browser back to. Register exactly this address in the provider's console. */
export const loginRedirectUri = (appUrl: string, provider: LoginProvider): string => `${appUrl.replace(/\/$/, "")}/api/signin/oauth/${provider}/callback`;

const b64url = (b: Buffer): string => b.toString("base64url");

/**
 * The values for one sign-in attempt, worked out from a random secret held only in the browser's cookie plus the
 * server secret. `binding` goes in the signed state; the PKCE verifier and the ID-token nonce are recomputed in
 * the callback, so none of the secrets is ever sent in a URL.
 */
export function attemptSecrets(secret: string, nonce: string): { verifier: string; challenge: string; idNonce: string; binding: string } {
  const verifier = b64url(createHmac("sha256", secret).update(`pkce:${nonce}`).digest());
  return {
    binding: b64url(createHmac("sha256", secret).update(`bind:${nonce}`).digest()),
    verifier,
    challenge: b64url(createHash("sha256").update(verifier).digest()),
    idNonce: b64url(createHmac("sha256", secret).update(`nonce:${nonce}`).digest()),
  };
}

export function authorizeUrl(provider: LoginProvider, app: LoginApp, p: { redirectUri: string; state: string; challenge: string; idNonce: string }): string {
  const url = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : `https://login.microsoftonline.com/${app.tenant ?? "common"}/oauth2/v2.0/authorize`);
  const q = url.searchParams;
  q.set("client_id", app.clientId);
  q.set("redirect_uri", p.redirectUri);
  q.set("response_type", "code");
  q.set("scope", "openid email");
  q.set("state", p.state);
  q.set("nonce", p.idNonce);
  q.set("code_challenge", p.challenge);
  q.set("code_challenge_method", "S256");
  q.set("prompt", "select_account");
  return url.toString();
}

export type LoginProblem = "failed" | "unverified";
export type LoginResult = { email: string } | { problem: LoginProblem };

const tokenUrl = (provider: LoginProvider, app: LoginApp): string =>
  provider === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${app.tenant ?? "common"}/oauth2/v2.0/token`;

function claimsOf(idToken: unknown): Record<string, unknown> | undefined {
  if (typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Trades the one-time code for the person's verified email. The ID token is taken from the provider's token
 * endpoint over TLS, which is why its signature need not be re-checked (OpenID Connect Core 3.1.3.7); every
 * claim that says who it is for, and that it is fresh, is checked here.
 */
export async function completeLogin(
  provider: LoginProvider,
  app: LoginApp,
  p: { code: string; redirectUri: string; verifier: string; idNonce: string; http: typeof fetch; nowMs: number },
): Promise<LoginResult> {
  let body: Record<string, unknown>;
  try {
    const res = await p.http(tokenUrl(provider, app), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: p.verifier }),
    });
    if (!res.ok) return { problem: "failed" };
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { problem: "failed" };
  }
  const c = claimsOf(body?.id_token);
  if (!c) return { problem: "failed" };

  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(app.clientId) || c.nonce !== p.idNonce) return { problem: "failed" };
  if (typeof c.exp !== "number" || c.exp * 1000 <= p.nowMs) return { problem: "failed" };

  if (provider === "google") {
    if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return { problem: "failed" };
    const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 200) return { problem: "failed" };
    return c.email_verified === true || c.email_verified === "true" ? { email } : { problem: "unverified" };
  }

  const tid = typeof c.tid === "string" ? c.tid : "";
  if (!TENANT_ID.test(tid) || c.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) return { problem: "failed" };
  // A single-tenant app only takes people from that tenant.
  if (app.tenant && TENANT_ID.test(app.tenant) && app.tenant.toLowerCase() !== tid.toLowerCase()) return { problem: "failed" };
  const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 200) return { problem: "unverified" };
  const verified = c.xms_edov === true || c.xms_edov === "true" || tid.toLowerCase() === MICROSOFT_PERSONAL_TENANT;
  return verified ? { email } : { problem: "unverified" };
}
