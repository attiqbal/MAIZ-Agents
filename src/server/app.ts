import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userIdFor } from "./identity.js";
import { SetupError } from "../modules/admin-manager/index.js";
import { ChannelError, parseSlackEvent } from "../modules/channels/index.js";
import { PermissionError } from "../modules/identity/index.js";
import { LedgerError } from "../modules/ledger/index.js";
import { IntegrationError } from "../modules/integrations/index.js";
import { ReviewError } from "../modules/review/index.js";
import { PricingError } from "../modules/pricing/index.js";
import { BatchError } from "../modules/batch/schedule.js";
import { SettingsError } from "../modules/model-gateway/routing/settings.js";
import { SignupError, type SignupChoices } from "../modules/onboarding/index.js";
import { planSignup, readSignupAnswers } from "../modules/onboarding/recommend.js";
import { OTHER_SECTOR, getSector } from "../modules/onboarding/sectors.js";
import { getTemplate, TEMPLATES } from "../modules/workforce/templates.js";
import { getJobDescription } from "../modules/workforce/job-descriptions.js";
import { CUSTOM_SPECIALIST, DEPARTMENTS } from "../modules/workforce/blueprints.js";
import { OVERAGE_RULE } from "../modules/workforce/task-roles.js";
import { CONSULTANTS, HOW_A_PASS_WORKS, menuOf } from "../modules/workforce/consultants.js";
import { quote } from "../modules/store/cart.js";
import type { Platform } from "./platform.js";

const OAUTH_STATE_SECONDS = 600;
const OAUTH_COOKIE = "maiz_oauth";
const oauthCookie = (nonce: string, maxAge: number, appUrl?: string): string =>
  `${OAUTH_COOKIE}=${nonce}; Path=/api/integrations; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl?.startsWith("https://") ? "; Secure" : ""}`;
function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

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

export { userIdFor };

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
    // Agent store: every employee with its full job description. Public, no sign-in needed.
    if (method === "GET" && path === "/api/store") {
      return json(200, {
        employees: TEMPLATES.map((t) => ({ key: t.key, title: t.title, summary: t.summary, kind: t.kind, tier: t.tier, firstJob: t.firstJob, jobDescription: getJobDescription(t.key) })),
        // Every department and role of a typical business; roles without a ready-made employee are custom specialists.
        departments: DEPARTMENTS.map((d) => ({ key: d.key, name: d.name, mission: d.mission, roles: d.roles.map((r) => ({ key: r.key, title: r.title, purpose: r.purpose, readyMade: Boolean(r.jd) })) })),
        customSpecialist: CUSTOM_SPECIALIST,
        // Consultants: one-off passes with an energy pool, and the task menu each can do.
        consultants: CONSULTANTS.map((c) => ({ key: c.key, title: c.title, purpose: c.purpose, passes: c.passes, menu: menuOf(c.key).map((t) => ({ key: t.key, title: t.title, energy: t.includedEnergy })) })),
        howAPassWorks: HOW_A_PASS_WORKS,
        overageRule: OVERAGE_RULE,
        // What can be added to a cart, and whether it is billed monthly or once.
        catalogue: p.prices.catalogue(),
        // Package prices and trial terms in force today, set by the platform owner.
        prices: p.prices.general(),
      });
    }
    // Prices a cart. Public and pure: nothing is charged or stored (payments are not connected yet).
    if (method === "POST" && path === "/api/cart/quote") {
      const lines = body().lines;
      if (!Array.isArray(lines) || lines.length > 100) throw new BadRequest("lines must be a list of up to 100 items");
      return json(200, quote(lines, p.prices.catalogue()));
    }

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
      // Development only: the link comes back in the reply so a tester can sign in without email. Never for a
      // platform owner: an owner session can approve every client's work, so it always needs the emailed link
      // (printed in the API log in development).
      const devLink = p.cfg.allowDevAuth && !p.isPlatformOwner(userIdFor(email)) ? { devLink: link } : {};
      return json(200, p.cfg.allowDevAuth ? { ok: true, dev: true, ...devLink } : { ok: true });
    }
    if (method === "POST" && path === "/api/signin/verify") {
      const c = readToken(secret, String(body().token ?? ""), p.now().getTime());
      if (!c || c.k !== "magic" || typeof c.e !== "string" || typeof c.n !== "string") return json(400, { error: "this sign-in link is invalid or has expired" });
      if (p.usedLinks.has(c.n)) return json(400, { error: "this sign-in link was already used" });
      p.usedLinks.add(c.n);
      return json(200, { token: issueSession(c.e), email: c.e, hasOrganisation: !!orgOf(userIdFor(c.e)), platformOwner: p.isPlatformOwner(userIdFor(c.e)) });
    }

    // ---- sign up: needs a verified email (or the development shortcut) ----
    if (method === "POST" && path === "/api/signup") {
      const b = body();
      const claims = sessionClaims(req);
      let email: string;
      if (claims && typeof claims.e === "string") email = claims.e; // verified by a sign-in link
      else if (p.cfg.allowDevAuth) email = String(b.email ?? "").trim().toLowerCase(); // development only: no check
      else return json(401, { error: "verify your email first" });
      if (!claims && p.isPlatformOwner(userIdFor(email))) return json(401, { error: "verify your email first" }); // never an unverified owner session
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequest("a valid email is required");
      const userId = userIdFor(email);
      if (orgOf(userId)) return json(409, { error: "this email already has an organisation" });
      // The three tapped answers (kind of business, needs, apps) become a plan by rules, with no AI call.
      const answers = readSignupAnswers(b);
      const plan = answers.businessName ? planSignup(answers) : undefined;
      const sectorLabel = plan && plan.sector !== OTHER_SECTOR ? getSector(plan.sector).label : "";
      const choices: SignupChoices = {
        ownerEmail: email,
        businessName: answers.businessName,
        businessType: sectorLabel || String(b.sells ?? "") || "small business",
        description: [answers.sells, plan ? plan.prefill.answers.goals : b.goal ? `Main goal: ${b.goal}` : "", answers.website ? `Website: ${answers.website}` : ""].filter(Boolean).join(" ") || answers.businessName,
        country: answers.country ?? "GB",
        currency: plan?.currency,
        teamSize: answers.size ?? "2-10",
        monthlyVolume: typeof b.monthlyVolume === "number" ? b.monthlyVolume : undefined,
        addOns: answers.addOns ? [...answers.addOns] : [],
        prepaidMonths: typeof b.prepaidMonths === "number" ? b.prepaidMonths : undefined,
        contact: b.contact === "slack" ? "slack" : "dashboard",
        plan,
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
      if (!state?.u || state.k !== "slack-install" || typeof state.n !== "string" || !code) return json(400, { error: "invalid or expired install link" });
      // Usable once. The QR flow finishes on a phone, so this link cannot be tied to the browser that started it.
      if (p.usedLinks.has(state.n)) return json(400, { error: "invalid or expired install link" });
      p.usedLinks.add(state.n);
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

    // ---- business apps: OAuth return and webhooks are public; state or the secret link proves who they are for ----
    if (method === "GET" && path === "/api/integrations/callback") {
      const state = readToken(secret, req.query.get("state") ?? undefined, p.now().getTime());
      const code = req.query.get("code");
      if (!state?.u || state.k !== "int-oauth" || typeof state.a !== "string" || typeof state.n !== "string") return json(400, { error: "invalid or expired connect link" });
      // Bound to the browser that started it (cookie) and usable once, so a link sent to someone else cannot attach their account.
      if (readCookie(req.headers["cookie"], OAUTH_COOKIE) !== state.n || p.usedLinks.has(state.n)) return json(400, { error: "invalid or expired connect link" });
      p.usedLinks.add(state.n);
      const org = orgOf(state.u);
      if (!code || !org) return { status: 302, headers: { location: "/app.html#apps" } }; // owner pressed Cancel in the app
      try {
        await p.integrations.completeOAuth(state.u, org.id, state.a, code);
      } catch (e) {
        if (!(e instanceof IntegrationError)) throw e;
        return { status: 302, headers: { location: "/app.html?connect=failed#apps" } };
      }
      return { status: 302, headers: { location: "/app.html#apps" } };
    }
    const hook = /^\/api\/integrations\/hooks\/([\w-]{1,64})\/([\w-]{16,128})$/.exec(path);
    if (method === "POST" && hook) {
      let payload: unknown;
      try { payload = JSON.parse(req.rawBody || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
      const result = p.integrations.receiveWebhook(hook[1]!, hook[2]!, payload);
      return result ? json(200, { ok: true, added: result.added, updated: result.updated, warnings: result.warnings }) : json(404, { error: "not found" });
    }

    // ---- everything below needs a signed-in user ----
    const userId = session(req);
    if (!userId) return json(401, { error: "sign in first" });
    // ---- MAIZ quality review: the platform owner's queue across every client. Clients get 403. ----
    if (path === "/api/owner/reviews" || path.startsWith("/api/owner/reviews/")) return ownerReviewRoutes(req, userId, body);
    if (path === "/api/owner/ai" || path.startsWith("/api/owner/ai/")) return ownerAiRoutes(req, userId, body);
    if (path === "/api/owner/prices" || path.startsWith("/api/owner/prices/")) return ownerPriceRoutes(req, userId, body);
    if (path.startsWith("/api/owner/")) {
      if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see this" });
      if (method === "GET" && path === "/api/owner/batch") return json(200, p.batch.ownerView(userId));
      if (method === "POST" && path === "/api/owner/batch/run-now") {
        const run = await p.batch.runAllNow(userId);
        return json(200, { started: !!run, run: run ?? null, ...p.batch.ownerView(userId) });
      }
      if (method === "GET" && path === "/api/owner/clients") return json(200, { clients: p.clients(userId) });
      if (method === "GET" && path === "/api/owner/specialists") return json(200, { requests: p.specialists.queue(userId) });
      const d = /^\/api\/owner\/specialists\/([\w-]{1,64})\/decide$/.exec(path);
      if (method === "POST" && d) {
        const b = body();
        await p.specialists.decide(userId, d[1]!, { decision: b.decision, message: b.message, priceGbp: b.priceGbp });
        return json(200, { requests: p.specialists.queue(userId) });
      }
      return json(404, { error: "not found" });
    }
    if (method === "GET" && path === "/api/me") return json(200, { platformOwner: p.isPlatformOwner(userId), hasOrganisation: !!orgOf(userId) });

    const org = orgOf(userId);
    if (!org) return json(404, { error: "no organisation yet" });

    // ---- new custom specialists: the client asks, MAIZ reviews before anything is trained ----
    if (method === "GET" && path === "/api/specialists") return json(200, { requests: p.specialists.forClient(userId, org.id) });
    if (method === "POST" && path === "/api/specialists") {
      const r = await p.specialists.request(userId, org.id, body());
      return json(201, { request: p.specialists.forClient(userId, org.id).find((x) => x.id === r.id), jobDescription: r.jobDescription, notes: r.notes });
    }

    // ---- specialised tasks: the client follows them through quality review but never approves ----
    if (method === "GET" && path === "/api/reviews") return json(200, { tasks: p.reviews.forClient(userId, org.id) });
    if (method === "POST" && path === "/api/reviews") {
      const item = await p.reviews.submit({ kind: "client", userId }, org.id, body());
      return json(201, { task: p.reviews.forClient(userId, org.id).find((t) => t.id === item.id) });
    }
    const answer = /^\/api\/reviews\/([\w-]{1,64})\/answer$/.exec(path);
    if (method === "POST" && answer) {
      const b = body();
      if (typeof b.label !== "string") throw new BadRequest("say which question you are answering");
      await p.reviews.answer({ kind: "client", userId }, org.id, answer[1]!, b.label, b.value);
      return json(200, { task: p.reviews.forClient(userId, org.id).find((t) => t.id === answer[1]) });
    }

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
      const task = await p.workforce.assign(userId, org.id, emp.id, text, { urgent: b.urgent === true });
      return json(200, { status: task.status, reason: task.reason, answer: task.deliverable, energyUsed: task.energyUsed, jobId: task.jobId, runsAt: task.runsAt, queueReason: task.queueReason });
    }

    // ---- batch queue: work that waits for the client's closing time ----
    if (method === "GET" && path === "/api/queue") return json(200, p.batch.forClient(userId, org.id));
    if (method === "POST" && path === "/api/queue/run-now") {
      const run = await p.batch.runNow(userId, org.id);
      return json(200, { started: !!run, ...p.batch.forClient(userId, org.id) });
    }
    const cancel = /^\/api\/queue\/([\w-]{1,64})\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      p.batch.cancel(userId, org.id, cancel[1]!);
      return json(200, p.batch.forClient(userId, org.id));
    }
    if (method === "GET" && path === "/api/batch/schedule") return json(200, p.batch.forClient(userId, org.id));
    if (method === "POST" && path === "/api/batch/schedule") {
      p.batch.setSchedule(userId, org.id, body());
      return json(200, p.batch.forClient(userId, org.id));
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

    // ---- business apps ----
    if (path.startsWith("/api/integrations")) {
      const r = await integrationRoutes(req, userId, org.id, body);
      if (r) return r;
    }

    // ---- start the Slack install; the QR code on the website encodes this URL ----
    if (method === "GET" && path === "/api/slack/install") {
      const cfg = p.cfg.slack;
      if (!cfg) return json(503, { error: "slack is not configured" });
      const state = makeToken(secret, { u: userId, k: "slack-install", n: randomBytes(16).toString("hex") }, OAUTH_STATE_SECONDS, p.now().getTime());
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("scope", "app_mentions:read,chat:write,im:history,im:read,im:write");
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("state", state);
      return json(200, { url: url.toString() });
    }

    return json(404, { error: "not found" });
  }

  /** Only the platform owner gets past the first line. The service checks again, so no route can skip it. */
  async function ownerReviewRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see quality review" });
    const { method, path } = req;
    if (method === "GET" && path === "/api/owner/reviews") return json(200, { reviews: p.reviews.queue(userId) });
    const m = /^\/api\/owner\/reviews\/([\w-]{1,64})\/(approve|request-info)$/.exec(path);
    if (method === "POST" && m) {
      const b = body();
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const item = m[2] === "approve"
        ? await p.reviews.approve(userId, m[1]!, { direction: str(b.direction), noteToClient: str(b.noteToClient), note: str(b.note), seenVersion: str(b.seenVersion) })
        : await p.reviews.requestInfo(userId, m[1]!, { question: str(b.question), note: str(b.note) });
      return json(200, { review: p.reviews.queue(userId).find((r) => r.id === item.id) });
    }
    return json(404, { error: "not found" });
  }

  /** AI spend and routing settings: the platform owner only (the service checks again). */
  async function ownerAiRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see AI spend" });
    const { method, path } = req;
    if (method === "GET" && path === "/api/owner/ai") return json(200, p.ai.overview(userId));
    if (method === "GET" && path === "/api/owner/ai/health") return json(200, await p.ai.health(userId));
    if (method === "POST" && path === "/api/owner/ai/settings") {
      p.ai.update(userId, body());
      return json(200, p.ai.overview(userId));
    }
    return json(404, { error: "not found" });
  }

  /** Prices and packages: the platform owner only. */
  async function ownerPriceRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can change prices" });
    const { method, path } = req;
    if (method === "GET" && path === "/api/owner/prices") return json(200, p.prices.view(userId));
    if (method === "POST" && path === "/api/owner/prices/changes") {
      const c = p.prices.change(userId, body());
      // The price book keeps its own history (who, when, from, to); client audit logs are per workspace.
      return json(201, { change: c, ...p.prices.view(userId) });
    }
    const m = /^\/api\/owner\/prices\/changes\/([\w-]{1,64})$/.exec(path);
    if (method === "DELETE" && m) {
      p.prices.cancel(userId, m[1]!);
      return json(200, p.prices.view(userId));
    }
    return json(404, { error: "not found" });
  }

  async function integrationRoutes(req: Req, userId: string, orgId: string, body: () => any): Promise<Res | undefined> {
    const { method, path } = req;
    const ig = p.integrations;
    if (method === "GET" && path === "/api/integrations") {
      return json(200, { catalogue: ig.catalogue(), connections: ig.list(userId, orgId), pending: ig.pending(userId, orgId) });
    }
    if (method === "POST" && path === "/api/integrations/post") return json(200, ig.post(userId, orgId));
    const app = /^\/api\/integrations\/apps\/([a-z0-9-]{2,40})\/(connect|import)$/.exec(path);
    if (method === "POST" && app) {
      const [, key, action] = app as unknown as [string, string, string];
      const c = ig.registry.require(key);
      if (action === "import") {
        const b = body();
        if (typeof b.csv !== "string") throw new BadRequest("attach the exported file");
        return json(200, ig.importFile(userId, orgId, key, b.csv, { date: typeof b.date === "string" ? b.date : undefined }));
      }
      if (c.auth.kind === "oauth2") {
        // The nonce is also set as a cookie, so only the browser that started the connection can finish it.
        const nonce = randomBytes(16).toString("hex");
        const state = makeToken(secret, { k: "int-oauth", u: userId, a: key, n: nonce }, OAUTH_STATE_SECONDS, p.now().getTime());
        return { status: 200, body: { url: ig.authorizeUrl(userId, orgId, key, state) }, headers: { "set-cookie": oauthCookie(nonce, OAUTH_STATE_SECONDS, p.cfg.appUrl) } };
      }
      if (c.auth.kind === "api_key") return json(201, { connection: ig.connectWithKey(userId, orgId, key, body().values ?? {}) });
      if (c.auth.kind === "webhook") {
        const { connection, secret: hookSecret } = ig.createWebhook(userId, orgId);
        const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
        // Shown once. Only a hash is stored, so a lost link is replaced, not recovered.
        return json(201, { connection, url: `${base}/api/integrations/hooks/${connection.id}/${hookSecret}` });
      }
      throw new BadRequest(`${c.name} works by file upload`);
    }
    const conn = /^\/api\/integrations\/connections\/([\w-]{1,64})(?:\/(sync|access))?$/.exec(path);
    if (conn) {
      const [, id, action] = conn as unknown as [string, string, string | undefined];
      if (method === "DELETE" && !action) { ig.disconnect(userId, orgId, id); return json(200, { ok: true }); }
      if (method === "POST" && action === "sync") return json(200, await ig.sync(userId, orgId, id));
      if (method === "POST" && action === "access") {
        const b = body();
        if (!Array.isArray(b.employees)) throw new BadRequest("employees must be a list");
        return json(200, { connection: ig.setAccess(userId, orgId, id, b.employees) });
      }
    }
    return undefined;
  }

  return async function handle(req: Req): Promise<Res> {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof BadRequest || err instanceof SetupError || err instanceof SignupError || err instanceof LedgerError || err instanceof ChannelError || err instanceof IntegrationError || err instanceof ReviewError || err instanceof PricingError || err instanceof SettingsError || err instanceof BatchError) return json(400, { error: err.message });
      if (err instanceof PermissionError) return json(403, { error: "you don't have permission to do that" });
      console.error(`${req.method} ${req.path} failed:`, err);
      return json(500, { error: "something went wrong" });
    }
  };
}

class BadRequest extends Error {}
