import { defaultRegistry, type OAuthApp } from "../modules/integrations/index.js";

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

  if (!production) return problems;
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
