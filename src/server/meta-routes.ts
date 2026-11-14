import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connectionView, permissionsFor, type MetaKind } from "../modules/meta-clients/index.js";
import { PermissionError } from "../modules/identity/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

/** The bits of app.ts these routes share (passed in, so this file does not import app.ts). */
export interface MetaRouteCtx {
  p: Platform;
  makeToken: (claims: Record<string, unknown>, ttl: number) => string;
  readToken: (t: string | undefined) => Record<string, any> | undefined;
  readCookie: (header: string | undefined, name: string) => string | undefined;
  orgOf: (userId: string) => { id: string } | undefined;
  body: () => any;
}

const json = (status: number, body: unknown): Res => ({ status, body });
const COOKIE = "maiz_meta";
const STATE_SECONDS = 600;
const KINDS: MetaKind[] = ["facebook", "instagram", "whatsapp"];
const cookie = (nonce: string, maxAge: number, appUrl?: string) => `${COOKIE}=${nonce}; Path=/api/meta; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl?.startsWith("https://") ? "; Secure" : ""}`;
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const redirect = (to: string, extra: Record<string, string> = {}): Res => ({ status: 302, headers: { location: to, "cache-control": "no-store", ...extra } });

/** Meta's own calls and the OAuth return. Public: each is proved by a signature or by the signed state plus the browser cookie. */
export async function metaPublicRoute(req: Req, c: MetaRouteCtx): Promise<Res | undefined> {
  const { p } = c;
  const { method, path } = req;
  const svc = p.metaClients;
  const secret = p.metaSettings.appSecret;

  if (method === "GET" && path === "/api/meta/callback") {
    const state = c.readToken(req.query.get("state") ?? undefined);
    const code = req.query.get("code");
    if (!state?.u || state.k !== "meta-oauth" || !KINDS.includes(state.a) || typeof state.n !== "string" || typeof state.w !== "string") return json(400, { error: "invalid or expired connect link" });
    // Bound to the browser that started it and usable once, so a link sent to someone else cannot attach their account.
    if (c.readCookie(req.headers["cookie"], COOKIE) !== state.n || p.usedLinks.has(state.n)) return json(400, { error: "invalid or expired connect link" });
    p.usedLinks.add(state.n, state.exp * 1000);
    const clear = { "set-cookie": cookie("", 0, p.cfg.appUrl) };
    if (!code || req.query.get("error")) return redirect("/connect-social.html?result=cancelled", clear);
    try {
      const r = await svc.completeLogin(state.u, state.w, state.a, code, redirectUri(p));
      return redirect(`/connect-social.html?result=choose&kind=${state.a}#pending=${r.pendingId}`, clear);
    } catch { return redirect("/connect-social.html?result=failed", clear); }
  }

  if (path === "/api/meta/webhook") {
    const s = p.metaSettings;
    if (!s.verifyToken || !s.appSecret) return json(503, { error: "the Meta webhook is not configured" });
    if (method === "GET") {
      const ch = req.query.get("hub.challenge");
      if (req.query.get("hub.mode") !== "subscribe" || !ch || !same(req.query.get("hub.verify_token") ?? "", s.verifyToken)) return json(403, { error: "bad verify token" });
      return { status: 200, text: ch.slice(0, 200), headers: { "content-type": "text/plain; charset=utf-8" } };
    }
    if (method === "POST") {
      const sig = req.headers["x-hub-signature-256"];
      if (!sig?.startsWith("sha256=") || !same(sig.slice(7), createHmac("sha256", s.appSecret).update(req.rawBody).digest("hex"))) return json(401, { error: "bad signature" });
      let payload: unknown;
      try { payload = JSON.parse(req.rawBody || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
      // Answer Meta at once (it retries slow replies). A reply is for a client's number or for MAIZ's own owner line.
      return { status: 200, body: { ok: true }, after: async () => {
        await svc.handleWhatsApp(payload).catch((e) => console.error("meta webhook (clients) failed:", e instanceof Error ? e.message : e));
        await p.ownerWhatsApp?.handle(payload).catch((e) => console.error("meta webhook (owner) failed:", e instanceof Error ? e.message : e));
      } };
    }
  }

  // Meta posts these as application/x-www-form-urlencoded with one field, signed_request.
  if (method === "POST" && (path === "/api/meta/deauthorize" || path === "/api/meta/data-deletion")) {
    if (!secret) return json(503, { error: "not configured" });
    const signed = new URLSearchParams(req.rawBody).get("signed_request");
    if (path === "/api/meta/deauthorize") return svc.handleDeauthorize(signed) ? json(200, { ok: true }) : json(400, { error: "bad signed request" });
    const out = svc.handleDeletion(signed);
    return out ? json(200, out) : json(400, { error: "bad signed request" });
  }

  if (method === "GET" && path === "/api/meta/deletion-status") return json(200, svc.deletionStatus(req.query.get("code")));
  return undefined;
}

const redirectUri = (p: Platform): string => `${(p.cfg.appUrl ?? "").replace(/\/$/, "")}/api/meta/callback`;

/** A signed-in client managing their own connections and posts. */
export async function metaClientRoute(req: Req, userId: string, c: MetaRouteCtx): Promise<Res | undefined> {
  const { p } = c;
  const { method, path } = req;
  const svc = p.metaClients;
  if (!path.startsWith("/api/meta")) return undefined;
  const org = c.orgOf(userId);
  if (!org) return json(404, { error: "no organisation" });
  const ws = org.id;
  // A MetaClientError becomes a 400 with its plain-English message in the server's shared error handler.
  const run = async <T>(f: () => Promise<T> | T): Promise<T> => f();

  if (method === "GET" && path === "/api/meta") {
    const s = p.metaSettings;
    return json(200, {
      mode: svc.mode,
      connections: svc.list(userId, ws),
      kinds: Object.fromEntries(KINDS.map((k) => [k, svc.explain(k)])),
      limits: svc.limitsFor(ws),
      // Public by design: the Meta JS SDK needs the app id and Embedded Signup configuration id in the browser.
      embeddedSignup: s.mode === "live" && s.appId && s.whatsappConfigId ? { appId: s.appId, configId: s.whatsappConfigId, version: s.version ?? "v23.0" } : undefined,
    });
  }
  if (method === "POST" && path === "/api/meta/connect") {
    const kind = c.body().kind;
    if (!KINDS.includes(kind) || kind === "whatsapp") return json(400, { error: "choose Facebook or Instagram" });
    const nonce = randomBytes(16).toString("hex");
    const state = c.makeToken({ k: "meta-oauth", u: userId, w: ws, a: kind, n: nonce }, STATE_SECONDS);
    return { status: 200, body: { url: svc.authorizeUrl(userId, ws, kind, state, redirectUri(p)) }, headers: { "set-cookie": cookie(nonce, STATE_SECONDS, p.cfg.appUrl) } };
  }
  const pend = /^\/api\/meta\/pending\/([0-9a-f]{20,64})$/.exec(path);
  if (method === "GET" && pend) return json(200, await run(() => svc.pendingChoices(userId, ws, pend[1]!)));
  if (method === "POST" && path === "/api/meta/choose") {
    const b = c.body();
    return json(201, { connection: await run(() => svc.choose(userId, ws, String(b.pendingId ?? ""), Number(b.index))) });
  }
  if (method === "POST" && path === "/api/meta/whatsapp") {
    const b = c.body();
    return json(201, { connection: await run(() => svc.connectWhatsApp(userId, ws, { code: String(b.code ?? ""), wabaId: String(b.wabaId ?? ""), phoneNumberId: String(b.phoneNumberId ?? ""), approverNumber: b.approverNumber })) });
  }
  const conn = /^\/api\/meta\/connections\/([\w-]{1,64})(?:\/(approver))?$/.exec(path);
  if (conn) {
    if (method === "DELETE" && !conn[2]) { await run(() => svc.disconnect(userId, ws, conn[1]!)); return json(200, { ok: true }); }
    if (method === "POST" && conn[2] === "approver") return json(200, { connection: await run(() => svc.setApprover(userId, ws, conn[1]!, c.body().number)) });
  }
  if (method === "POST" && path === "/api/meta/delete-data") return json(200, { deletion: await run(() => svc.deleteMyMetaData(userId, ws)) });
  if (method === "GET" && path === "/api/meta/posts") return json(200, { posts: svc.listPosts(userId, ws) });
  if (method === "POST" && path === "/api/meta/posts") return json(201, { post: await run(() => svc.draft(userId, ws, c.body())) });
  const post = /^\/api\/meta\/posts\/([\w-]{1,64})\/(approve|reject|cancel|results)$/.exec(path);
  if (method === "POST" && post) {
    const [, id, action] = post as unknown as [string, string, string];
    return json(200, { post: await run(() => action === "cancel" ? svc.cancel(userId, ws, id) : action === "results" ? svc.refreshResults(userId, ws, id) : svc.decide(userId, ws, id, action === "approve" ? "approve" : "reject")) });
  }
  if (method === "GET" && path === "/api/meta/insights") return json(200, { insights: await svc.insights(userId, ws) });

  // Sandbox only: act as "Meta" so every flow can be tried end to end with nothing leaving the server.
  if (path.startsWith("/api/meta/sandbox/")) {
    if (svc.mode !== "sandbox") return json(404, { error: "not found" });
    if (method === "POST" && path === "/api/meta/sandbox/whatsapp-reply") {
      const b = c.body();
      const wa = svc.list(userId, ws).find((x) => x.kind === "whatsapp");
      const full = wa && svc.sandboxApproverPayload(userId, ws, wa.id, String(b.text ?? ""));
      if (!full) return json(400, { error: "connect WhatsApp first" });
      await svc.handleWhatsApp(full);
      return json(200, { outbox: svc.sandboxOutbox(userId, ws) });
    }
    if (method === "GET" && path === "/api/meta/sandbox/outbox") return json(200, { outbox: svc.sandboxOutbox(userId, ws) });
  }
  return undefined;
}

/** The platform owner's view: approved vs pending per permission, readiness, per-client limits. */
export async function metaOwnerRoute(req: Req, userId: string, c: MetaRouteCtx): Promise<Res | undefined> {
  const { p } = c;
  const { method, path } = req;
  if (path !== "/api/owner/meta" && !path.startsWith("/api/owner/meta/")) return undefined;
  if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see this" });
  const svc = p.metaClients;
  const owner = (u: string) => p.isPlatformOwner(u);
  if (method === "GET" && path === "/api/owner/meta") return json(200, { ...svc.overview(userId, owner), readiness: await readiness(p), urls: metaUrls(p) });
  if (method === "POST" && path === "/api/owner/meta/permissions") {
    const b = c.body();
    return json(200, { status: svc.setPermissionStatus(userId, b.key, b.state, b.note, owner) });
  }
  const lim = /^\/api\/owner\/meta\/clients\/([\w-]{1,64})\/limits$/.exec(path);
  if (method === "POST" && lim) {
    if (!p.identity.workspaceById(lim[1]!)) return json(404, { error: "client not found" });
    return json(200, { limits: svc.setLimits(userId, lim[1]!, c.body(), owner) });
  }
  return undefined;
}

export function metaUrls(p: Platform) {
  const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
  return {
    privacyPolicy: `${base}/privacy.html`, termsOfService: `${base}/terms.html`, dataDeletionInstructions: `${base}/data-deletion.html`,
    dataDeletionCallback: `${base}/api/meta/data-deletion`, deauthorizeCallback: `${base}/api/meta/deauthorize`,
    oauthRedirect: redirectUri(p), webhook: `${base}/api/meta/webhook`,
  };
}

export interface ReadinessCheck { key: string; label: string; ok: boolean; how: "config" | "fetched"; detail?: string }

/** Checks what can be checked from here. Page checks really fetch the public page; nothing is assumed. */
async function readiness(p: Platform): Promise<ReadinessCheck[]> {
  const s = p.metaSettings, urls = metaUrls(p);
  const out: ReadinessCheck[] = [
    { key: "app_id", label: "Meta App ID is set (META_APP_ID)", ok: !!s.appId, how: "config" },
    { key: "app_secret", label: "Meta App Secret is set (META_APP_SECRET)", ok: !!s.appSecret, how: "config" },
    { key: "https", label: "The site address is https (Meta only calls back to https)", ok: !!p.cfg.appUrl?.startsWith("https://"), how: "config", detail: p.cfg.appUrl },
    { key: "webhook_token", label: "Webhook verify token is set (META_WEBHOOK_VERIFY_TOKEN)", ok: !!s.verifyToken, how: "config" },
    { key: "login_config", label: "Facebook Login for Business configuration id is set (META_LOGIN_CONFIG_ID)", ok: !!s.loginConfigId, how: "config" },
    { key: "wa_config", label: "WhatsApp Embedded Signup configuration id is set (META_WHATSAPP_CONFIG_ID)", ok: !!s.whatsappConfigId, how: "config" },
    { key: "live", label: "Live mode is switched on (META_MODE=live)", ok: s.mode === "live", how: "config" },
  ];
  const http = p.cfg.http ?? fetch;
  for (const [key, label, url, needle] of [
    ["privacy_page", "Privacy policy page loads and mentions Meta data", urls.privacyPolicy, /meta|facebook/i],
    ["terms_page", "Terms of service page loads", urls.termsOfService, /terms/i],
    ["deletion_page", "Data deletion instructions page loads", urls.dataDeletionInstructions, /delet/i],
  ] as const) {
    try {
      const r = await http(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
      const text = r.ok ? await r.text() : "";
      out.push({ key, label, ok: r.ok && needle.test(text), how: "fetched", detail: r.ok ? undefined : `answered ${r.status}` });
    } catch { out.push({ key, label, ok: false, how: "fetched", detail: "could not be reached from the server" }); }
  }
  return out;
}

export { permissionsFor, connectionView, PermissionError };
