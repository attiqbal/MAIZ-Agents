import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SetupError } from "../modules/admin-manager/index.js";
import { ChannelError, parseSlackEvent } from "../modules/channels/index.js";
import { PermissionError } from "../modules/identity/index.js";
import { LedgerError } from "../modules/ledger/index.js";
import { SignupError, type SignupChoices, type TeamSize } from "../modules/onboarding/index.js";
import { getTemplate } from "../modules/workforce/templates.js";
import type { Platform } from "./platform.js";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Raw body text (Slack signatures are over the exact bytes). */
  rawBody: string;
}
export interface Res {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Work to do after the reply is sent (Slack needs an answer within 3 seconds). */
  after?: () => Promise<void>;
}

const json = (status: number, body: unknown): Res => ({ status, body });

// ---- sessions: signed token "payload.signature", 7 days ----
const b64 = (s: string) => Buffer.from(s).toString("base64url");
function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
export function makeToken(secret: string, claims: Record<string, unknown>, ttlSeconds: number, nowMs: number): string {
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(nowMs / 1000) + ttlSeconds }));
  return `${payload}.${sign(secret, payload)}`;
}
export function readToken(secret: string, token: string | undefined, nowMs: number): Record<string, any> | undefined {
  if (!token) return undefined;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return undefined;
  const good = Buffer.from(sign(secret, payload));
  const got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return undefined;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof c.exp === "number" && c.exp * 1000 > nowMs ? c : undefined;
  } catch {
    return undefined;
  }
}

export const userIdFor = (email: string) => `u_${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
const SIZES: Record<string, TeamSize> = { "just me": "solo", solo: "solo", "2–10": "2-10", "2-10": "2-10", "11–50": "11-50", "11-50": "11-50", "51+": "51+" };

export function createApp(p: Platform) {
  const secret = p.cfg.sessionSecret;
  /** Only tokens issued as sessions count. Other signed tokens (sign-in links, Slack install state) never do. */
  const sessionClaims = (req: Req) => {
    const h = req.headers["authorization"];
    const t = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    const c = readToken(secret, t, p.now().getTime());
    return c?.k === "session" ? c : undefined;
  };
  const session = (req: Req): string | undefined => sessionClaims(req)?.u;
  const issueSession = (email: string) => makeToken(secret, { k: "session", u: userIdFor(email), e: email }, 7 * 86400, p.now().getTime());
  const orgOf = (userId: string) => p.identity.workspacesFor(userId)[0];

  async function route(req: Req): Promise<Res> {
    const { method, path } = req;
    const body = () => {
      try { return req.rawBody ? JSON.parse(req.rawBody) : {}; } catch { throw new BadRequest("invalid JSON"); }
    };

    if (method === "GET" && path === "/api/health") return p.healthy() ? json(200, { ok: true }) : json(503, { ok: false, error: "storage is failing" });

    // ---- sign in by email link ----
    if (method === "POST" && path === "/api/signin/start") {
      const email = String(body().email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new BadRequest("a valid email is required");
      const nowMs = p.now().getTime();
      const recent = (p.sends.get(email) ?? []).filter((t) => nowMs - t < 3_600_000);
      if (recent.length >= 5) return json(429, { error: "too many sign-in emails, try again later" });
      p.sends.set(email, [...recent, nowMs]);
      const link = makeToken(secret, { k: "magic", e: email, n: randomBytes(12).toString("hex") }, 900, nowMs);
      const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
      // The link opens a page that posts the token back, so mail scanners that pre-open links cannot use it up.
      await p.email.send({
        to: email,
        subject: "Your MAIZ agents sign-in link",
        text: `Click to sign in. The link works once and expires in 15 minutes.\n\n${base}/signin.html#token=${link}\n\nIf you didn't ask for this, ignore this email.`,
      }).catch(() => undefined);
      // Same answer whether or not the address has an account. In development the website skips the email step.
      return json(200, p.cfg.allowDevAuth ? { ok: true, dev: true } : { ok: true });
    }
    if (method === "POST" && path === "/api/signin/verify") {
      const c = readToken(secret, String(body().token ?? ""), p.now().getTime());
      if (!c || c.k !== "magic" || typeof c.e !== "string" || typeof c.n !== "string") return json(400, { error: "this sign-in link is invalid or has expired" });
      if (p.usedLinks.has(c.n)) return json(400, { error: "this sign-in link was already used" });
      p.usedLinks.add(c.n);
      return json(200, { token: issueSession(c.e), email: c.e, hasOrganisation: !!orgOf(userIdFor(c.e)) });
    }

    // ---- sign up: needs a verified email (or the development shortcut) ----
    if (method === "POST" && path === "/api/signup") {
      const b = body();
      const claims = sessionClaims(req);
      let email: string;
      if (claims && typeof claims.e === "string") email = claims.e; // verified by a sign-in link
      else if (p.cfg.allowDevAuth) email = String(b.email ?? "").trim().toLowerCase(); // development only: no check
      else return json(401, { error: "verify your email first" });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequest("a valid email is required");
      const userId = userIdFor(email);
      if (orgOf(userId)) return json(409, { error: "this email already has an organisation" });
      const choices: SignupChoices = {
        businessName: String(b.businessName ?? ""),
        businessType: String(b.sells ?? "") || "small business",
        description: [b.sells, b.goal ? `Main goal: ${b.goal}` : "", b.website ? `Website: ${b.website}` : ""].filter(Boolean).join(". ") || String(b.businessName ?? ""),
        country: String(b.country ?? "GB"),
        teamSize: SIZES[String(b.size ?? "").toLowerCase()] ?? "2-10",
        monthlyVolume: typeof b.monthlyVolume === "number" ? b.monthlyVolume : undefined,
        addOns: Array.isArray(b.addOns) ? b.addOns.map(String) : [],
        prepaidMonths: typeof b.prepaidMonths === "number" ? b.prepaidMonths : undefined,
        contact: b.contact === "slack" ? "slack" : "dashboard",
      };
      const org = await p.onboarding.signUp(userId, choices);
      await p.admin.welcome(userId, org);
      const token = issueSession(email);
      return json(201, { token, workspaceId: org.workspaceId, blueprint: org.blueprint, trialEndsAt: org.trialEndsAt });
    }

    // ---- Slack events: public, signed by Slack ----
    if (method === "POST" && path === "/api/slack/events") {
      if (!p.cfg.slack) return json(503, { error: "slack is not configured" });
      const { result, message } = parseSlackEvent(
        p.cfg.slack.signingSecret,
        { timestamp: req.headers["x-slack-request-timestamp"] ?? "", signature: req.headers["x-slack-signature"] ?? "" },
        req.rawBody,
        Math.floor(p.now().getTime() / 1000),
      );
      return { status: result.status, body: result.body, after: message ? async () => { await p.router.handle(message).catch(() => undefined); } : undefined };
    }

    // ---- Slack install callback: browser arrives from Slack, no session header; the signed state proves who started it ----
    if (method === "GET" && path === "/api/slack/callback") {
      const cfg = p.cfg.slack;
      if (!cfg) return json(503, { error: "slack is not configured" });
      const state = readToken(secret, req.query.get("state") ?? undefined, p.now().getTime());
      const code = req.query.get("code");
      if (!state?.u || state.k !== "slack-install" || !code) return json(400, { error: "invalid or expired install link" });
      const res = await (p.cfg.http ?? fetch)("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri }),
      });
      const o = (await res.json()) as any;
      if (!o.ok || !o.access_token || !o.team?.id) return json(400, { error: "Slack did not approve the install" });
      const org = orgOf(state.u);
      if (!org) return json(400, { error: "no organisation for this user" });
      const team = p.workforce.team(state.u, org.id);
      const lead = team.find((e) => e.templateKey === "business-consultant") ?? team[0]!;
      p.router.connect(state.u, { workspaceId: org.id, channel: "slack", externalWorkspace: o.team.id, defaultEmployeeId: lead.id }, []);
      p.saveSlackToken(org.id, o.team.id, o.access_token);
      if (o.authed_user?.id) p.router.linkUser(state.u, org.id, "slack", o.team.id, o.authed_user.id);
      // Anything the Admin manager was holding for Slack goes out now.
      await p.admin.deliverPending(state.u, org.id).catch(() => 0);
      return { status: 302, headers: { location: "/app.html#team" } };
    }

    // ---- everything below needs a signed-in user ----
    const userId = session(req);
    if (!userId) return json(401, { error: "sign in first" });
    const org = orgOf(userId);
    if (!org) return json(404, { error: "no organisation yet" });

    if (method === "GET" && path === "/api/org") {
      const plan = p.energy.planOf(org.id);
      return json(200, {
        id: org.id,
        name: org.name,
        trialEndsAt: plan.expiresAt,
        dailyQuotaPerEmployee: plan.dailyQuotaPerEmployee,
        team: p.workforce.team(userId, org.id).map((e) => ({
          id: e.id,
          templateKey: e.templateKey,
          name: e.name,
          blurb: getTemplate(e.templateKey)?.title,
          energyLeft: p.energy.remainingToday(userId, org.id, e.id),
        })),
      });
    }

    // ---- Admin manager: messages, setup form, setup run ----
    if (method === "GET" && path === "/api/setup") {
      return json(200, { ...p.admin.status(userId, org.id), messages: p.admin.messages(userId, org.id) });
    }
    if (method === "POST" && path === "/api/setup") {
      const b = body();
      if (!b.answers || typeof b.answers !== "object" || Array.isArray(b.answers)) throw new BadRequest("answers are required");
      const run = await p.admin.submitForm(userId, org.id, b.answers);
      return json(200, { run, ...p.admin.status(userId, org.id), messages: p.admin.messages(userId, org.id) });
    }
    if (method === "POST" && path === "/api/setup/rollback") {
      const run = await p.admin.rollback(userId, org.id);
      return json(200, { run, ...p.admin.status(userId, org.id), messages: p.admin.messages(userId, org.id) });
    }

    if (method === "POST" && path === "/api/ask") {
      const b = body();
      const text = String(b.text ?? "").trim();
      if (!text) throw new BadRequest("say what you need");
      if (text.length > 4000) throw new BadRequest("that is too long");
      const emp = p.workforce.team(userId, org.id).find((e) => e.id === b.employeeId);
      if (!emp) throw new BadRequest("pick one of your employees");
      const task = await p.workforce.assign(userId, org.id, emp.id, text);
      return json(200, { status: task.status, reason: task.reason, answer: task.deliverable, energyUsed: task.energyUsed });
    }

    if (method === "GET" && path === "/api/finance/summary") {
      const today = p.now().toISOString().slice(0, 10);
      const from = `${today.slice(0, 7)}-01`;
      return json(200, {
        asOf: today,
        profitAndLoss: p.ledger.profitAndLoss(userId, org.id, { from, to: today }),
        runway: p.ledger.runway(userId, org.id, today),
        balanceSheet: p.ledger.balanceSheet(userId, org.id, today),
      });
    }

    if (method === "POST" && path === "/api/finance/entries") {
      const b = body();
      const entry = p.ledger.post(userId, org.id, { date: String(b.date ?? ""), memo: String(b.memo ?? ""), source: b.source ? String(b.source) : undefined, lines: Array.isArray(b.lines) ? b.lines : [] });
      return json(201, { id: entry.id });
    }

    // ---- start the Slack install; the QR code on the website encodes this URL ----
    if (method === "GET" && path === "/api/slack/install") {
      const cfg = p.cfg.slack;
      if (!cfg) return json(503, { error: "slack is not configured" });
      const state = makeToken(secret, { u: userId, k: "slack-install" }, 600, p.now().getTime());
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("scope", "app_mentions:read,chat:write,im:history,im:read,im:write");
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("state", state);
      return json(200, { url: url.toString() });
    }

    return json(404, { error: "not found" });
  }

  return async function handle(req: Req): Promise<Res> {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof BadRequest || err instanceof SetupError || err instanceof SignupError || err instanceof LedgerError || err instanceof ChannelError) return json(400, { error: err.message });
      if (err instanceof PermissionError) return json(403, { error: "you don't have permission to do that" });
      return json(500, { error: "something went wrong" });
    }
  };
}

class BadRequest extends Error {}
