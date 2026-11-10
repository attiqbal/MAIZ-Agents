import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { createApp } from "./app.js";
import { checkEnv, integrationAppsFromEnv } from "./config.js";
import { ResendEmailSender } from "./email.js";
import { createPlatform } from "./platform.js";
import { clientIp, limitFor, RateLimiter } from "./rate-limit.js";
import { createStatic } from "./static.js";

const env = process.env;
const production = env.NODE_ENV === "production";
const problems = checkEnv(env);
if (problems.length) {
  for (const p of problems) console.error(`config: ${p}`);
  process.exit(1);
}

const platform = createPlatform({
  appUrl: env.APP_URL ?? "http://localhost:5173",
  email: env.RESEND_API_KEY && env.EMAIL_FROM ? new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM) : undefined,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  anthropicModel: env.ANTHROPIC_MODEL,
  sessionSecret: env.SESSION_SECRET ?? randomBytes(32).toString("hex"),
  allowDevAuth: env.ALLOW_DEV_AUTH === "1",
  slack:
    env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET && env.SLACK_REDIRECT_URI
      ? { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET, signingSecret: env.SLACK_SIGNING_SECRET, redirectUri: env.SLACK_REDIRECT_URI }
      : undefined,
  integrationApps: integrationAppsFromEnv(env, env.APP_URL ?? "http://localhost:5173"),
});

let store: { close(): Promise<void> } | undefined;
if (env.DATABASE_URL) {
  const { PgStore } = await import("../storage/postgres.js");
  const pg = new PgStore({ adminUrl: env.DATABASE_URL, appUrl: env.DATABASE_APP_URL!, tokenKeyHex: env.TOKEN_KEY! });
  const applied = await pg.migrate();
  if (applied.length) console.log("applied migrations:", applied.join(", "));
  await platform.attachStore(pg);
  store = pg;
  console.log("storage: postgres");
} else {
  console.log("storage: memory (data resets on restart)");
}
if (!env.ANTHROPIC_API_KEY) console.log("ai: mock answers (ANTHROPIC_API_KEY is not set)");

const handle = createApp(platform);
// One service serves the website and the API on the same address, so sign-in links, cookies-free
// bearer tokens and the website's CSP (connect-src 'self') all work without CORS.
const site = createStatic(env.WEB_DIST ?? join(import.meta.dirname, "../../web/dist"));
if (site) console.log("website: serving web/dist");
const limiter = new RateLimiter();
const trustProxy = env.TRUST_PROXY === "1" || production;
const API_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const MAX_BODY = 1_000_000;

const server = createServer(async (incoming, out) => {
  try {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    const method = incoming.method ?? "GET";
    if (!url.pathname.startsWith("/api/")) {
      if (!site || (method !== "GET" && method !== "HEAD")) { out.writeHead(404, API_HEADERS).end(); return; }
      const f = site(url.pathname);
      out.writeHead(f.status, f.headers).end(method === "HEAD" ? undefined : f.body);
      return;
    }
    const ip = clientIp(incoming.headers as Record<string, string | undefined>, incoming.socket.remoteAddress, trustProxy);
    const limit = limitFor(method, url.pathname);
    if (limit && !limiter.allow(`${ip} ${url.pathname}`, limit)) {
      out.writeHead(429, { "content-type": "application/json", "Retry-After": "60", ...API_HEADERS }).end(JSON.stringify({ error: "too many requests, try again in a minute" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of incoming) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) { out.writeHead(413, API_HEADERS).end(); return; }
      chunks.push(c as Buffer);
    }
    const res = await handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries(Object.entries(incoming.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
      rawBody: Buffer.concat(chunks).toString("utf8"),
    });
    out.writeHead(res.status, { "content-type": "application/json", ...API_HEADERS, ...res.headers });
    out.end(res.body === undefined ? undefined : JSON.stringify(res.body));
    if (res.after) res.after().catch((err) => console.error("background task failed:", err));
  } catch (err) {
    console.error("request failed:", err);
    if (!out.headersSent) out.writeHead(500, { "content-type": "application/json", ...API_HEADERS });
    out.end(JSON.stringify({ error: "something went wrong" }));
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const port = Number(env.PORT ?? 8787);
server.listen(port, () => console.log(`listening on :${port}`));

// Hosts send SIGTERM before replacing the instance: stop taking requests and write pending changes to Postgres.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close();
  try { await store?.close(); } catch (err) { console.error("flush on shutdown failed:", err); }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err));
