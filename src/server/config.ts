import { defaultRegistry, type OAuthApp } from "../modules/integrations/index.js";
import { loginEnvProblems } from "./social-login.js";

/**
 * Start-up checks. The server refuses to start with a setup that would lose data, leak sign-ins or
 * give trial customers fake answers. Returns the list of problems (empty when the setup is fine).
 */
export function checkEnv(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";
  const need = (name: string, why: string) => { if (!env[name]) problems.push(`${name} is required ${why}`); };

  if (env.DATABASE_URL) {
    need("DATABASE_APP_URL", "when DATABASE_URL is set");
    need("TOKEN_KEY", "when DATABASE_URL is set");
  }
  if (env.TOKEN_KEY && !/^[0-9a-fA-F]{64}$/.test(env.TOKEN_KEY)) problems.push("TOKEN_KEY must be 64 hex characters (openssl rand -hex 32)");
  const slack = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "SLACK_REDIRECT_URI"];
  const slackSet = slack.filter((k) => env[k]);
  if (slackSet.length && slackSet.length < slack.length) problems.push(`Slack needs all of ${slack.join(", ")} (or none)`);
  for (const prefix of oauthPrefixes()) {
    const pair = [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`];
    if (pair.filter((k) => env[k]).length === 1) problems.push(`${pair.join(" and ")} must be set together (or neither)`);
  }

  problems.push(...loginEnvProblems(env));

  if (!!env.RUNPOD_API_KEY !== !!env.RUNPOD_ENDPOINT_ID) problems.push("RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set together (or neither)");
  if (env.RUNPOD_ENDPOINT_ID && !/^[a-z0-9]{6,40}$/i.test(env.RUNPOD_ENDPOINT_ID)) problems.push("RUNPOD_ENDPOINT_ID must be the endpoint's id (letters and digits only), not a URL");

  if (env.PAYMENTS_PROVIDER && env.PAYMENTS_PROVIDER !== "mock" && env.PAYMENTS_PROVIDER !== "stripe") problems.push(`PAYMENTS_PROVIDER "${env.PAYMENTS_PROVIDER}" is not built (use "stripe", or "mock" for development)`);
  if (production && env.PAYMENTS_PROVIDER === "mock") problems.push("PAYMENTS_PROVIDER=mock must not be used in production: it hands out paid items for free");
  if (env.PAYMENTS_PROVIDER === "stripe") problems.push(...stripeEnvProblems(env, production));

  const owners = (env.PLATFORM_OWNER_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  if (owners.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) problems.push("PLATFORM_OWNER_EMAILS must be a comma-separated list of email addresses");

  if (!production) return problems;
  if (!owners.length) problems.push("PLATFORM_OWNER_EMAILS is required in production (without it no one can sign off specialised tasks)");
  if (env.ALLOW_DEV_AUTH === "1") problems.push("ALLOW_DEV_AUTH must not be on in production");
  need("SESSION_SECRET", "in production");
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) problems.push("SESSION_SECRET must be at least 32 characters");
  need("DATABASE_URL", "in production");
  need("RESEND_API_KEY", "in production");
  need("EMAIL_FROM", "in production");
  need("APP_URL", "in production");
  if (env.APP_URL && !env.APP_URL.startsWith("https://")) problems.push("APP_URL must start with https:// in production");
  need("ANTHROPIC_API_KEY", "in production (without it every employee gives mock answers)");
  return problems;
}

const oauthPrefixes = (): string[] => defaultRegistry().list().flatMap((c) => (c.auth.kind === "oauth2" ? [c.auth.envPrefix] : []));

/**
 * Our OAuth app per business app, from `<PREFIX>_CLIENT_ID` and `<PREFIX>_CLIENT_SECRET` (for example SQUARE_CLIENT_ID).
 * Apps without both stay on file upload. Every app returns to one callback on our API.
 */
/** The MAIZ platform owner(s): only they review and sign off specialised tasks. */
export const platformOwnersFromEnv = (env: Record<string, string | undefined>): string[] =>
  (env.PLATFORM_OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export function integrationAppsFromEnv(env: Record<string, string | undefined>, appUrl: string): Record<string, OAuthApp> {
  const apps: Record<string, OAuthApp> = {};
  const redirectUri = `${appUrl.replace(/\/$/, "")}/api/integrations/callback`;
  for (const c of defaultRegistry().list()) {
    if (c.auth.kind !== "oauth2") continue;
    const clientId = env[`${c.auth.envPrefix}_CLIENT_ID`];
    const clientSecret = env[`${c.auth.envPrefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) apps[c.key] = { clientId, clientSecret, redirectUri };
  }
  return apps;
}

/** Stripe needs its key and webhook secret. Live keys and test keys in production each need a deliberate opt-in. */
function stripeEnvProblems(env: Record<string, string | undefined>, production: boolean): string[] {
  const out: string[] = [];
  const key = env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_(test|live)_\w+$/.test(key)) out.push("STRIPE_SECRET_KEY is required with PAYMENTS_PROVIDER=stripe (a restricted key rk_test_... or secret key sk_test_...)");
  if (!/^whsec_\w+$/.test(env.STRIPE_WEBHOOK_SECRET ?? "")) out.push("STRIPE_WEBHOOK_SECRET (whsec_...) is required with PAYMENTS_PROVIDER=stripe");
  if (/^(sk|rk)_live_/.test(key) && env.STRIPE_ALLOW_LIVE !== "1") out.push("a live Stripe key takes real money: set STRIPE_ALLOW_LIVE=1 only when the owner has said to go live");
  if (production && /^(sk|rk)_test_/.test(key) && env.STRIPE_ALLOW_TEST_IN_PRODUCTION !== "1") out.push("a test Stripe key in production lets anyone 'pay' with a test card and get paid items free: use a staging server, or set STRIPE_ALLOW_TEST_IN_PRODUCTION=1 on purpose");
  return out;
}
