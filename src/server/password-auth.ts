import { randomBytes } from "node:crypto";
import { passwordProblem } from "../modules/credentials/index.js";
import { userIdFor } from "./identity.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";
import { accountExistsEmail, brandFrom, confirmEmailEmail, passwordResetEmail, type Mail } from "./email-templates.js";

/** What the password routes borrow from the app: token signing and sessions live there. */
export interface AuthContext {
  p: Platform;
  makeToken: (claims: Record<string, unknown>, ttlSeconds: number) => string;
  readToken: (token: string | undefined) => Record<string, any> | undefined;
  issueSession: (email: string) => string;
  sessionClaims: (req: Req) => Record<string, any> | undefined;
  orgOf: (userId: string) => unknown;
  body: () => any;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Wrong passwords allowed per address in 15 minutes before the address is locked for the rest of that time. */
export const MAX_FAILED_LOGINS = 5;
const MAX_RESET_EMAILS_PER_HOUR = 3;
const MAX_CONFIRM_EMAILS_PER_HOUR = 5;
const CONFIRM_SECONDS = 3_600;
const RESET_SECONDS = 1_800;
const OWNER_MESSAGE = "Owner accounts sign in with an emailed link only. Use “Email me a link” instead.";

const json = (status: number, body: unknown): Res => ({ status, body, headers: { "cache-control": "no-store" } });

const emailOf = (v: unknown): string | undefined => {
  const e = String(v ?? "").trim().toLowerCase();
  return EMAIL.test(e) && e.length <= 200 ? e : undefined;
};

/**
 * Email and password sign-up, log-in, forgotten password and password change.
 * Sessions are the same signed tokens as the emailed link, so everything after log-in is unchanged.
 * A platform owner never uses a password: an owner session can approve every client's work, so it always needs the emailed link.
 */
export async function passwordRoutes(req: Req, c: AuthContext): Promise<Res | undefined> {
  const { p } = c;
  const { method, path } = req;
  if (method !== "POST" || !path.startsWith("/api/auth/")) return undefined;
  const nowMs = p.now().getTime();
  const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
  const brand = brandFrom(p.cfg);
  const signedIn = (email: string) => json(200, { token: c.issueSession(email), email, hasOrganisation: !!c.orgOf(userIdFor(email)), platformOwner: false });
  const send = (to: string, mail: Omit<Mail, "to">) => p.email.send({ to, ...mail }).catch((e) => console.error("auth email failed:", e));

  // ---- create an account: the password is held until the emailed link proves the address ----
  if (path === "/api/auth/register") {
    const b = c.body() ?? {};
    const email = emailOf(b.email);
    if (!email) return json(400, { error: "Enter a valid email address.", field: "email" });
    const problem = passwordProblem(b.password, email);
    if (problem) return json(400, { error: problem, field: "password" });
    const userId = userIdFor(email);
    if (p.isPlatformOwner(userId)) return json(403, { error: OWNER_MESSAGE });
    if (p.sends.recent(`confirm:${email}`, nowMs).length >= MAX_CONFIRM_EMAILS_PER_HOUR) return json(429, { error: "Too many emails to this address. Please try again in an hour." });
    p.sends.record(`confirm:${email}`, nowMs);
    // The answer is the same whether or not the address already has an account, so it cannot be used to find out.
    const bind = randomBytes(16).toString("hex");
    // An address that already has a password or a team gets the same answer; it is told by email, and uses "Forgot password" to set one.
    if (p.credentials.has(userId) || c.orgOf(userId)) {
      await p.credentials.hold(userId, String(b.password), 1, bind); // same work as a new address, so timing does not tell them apart
      await send(email, accountExistsEmail(`${base}/signin.html`, `${base}/signin.html#forgot`, brand));
      return json(200, { ok: true, bind, dev: p.cfg.allowDevAuth || undefined });
    }
    const nonce = await p.credentials.hold(userId, String(b.password), CONFIRM_SECONDS, bind);
    const link = c.makeToken({ k: "register", e: email, n: nonce }, CONFIRM_SECONDS);
    await send(email, confirmEmailEmail(`${base}/signin.html#confirm=${link}`, brand));
    return json(200, { ok: true, bind, ...(p.cfg.allowDevAuth ? { dev: true, devLink: link } : {}) });
  }
  if (path === "/api/auth/confirm") {
    const cb = c.body() ?? {};
    const t = c.readToken(String(cb.token ?? ""));
    if (!t || t.k !== "register" || typeof t.e !== "string" || typeof t.n !== "string") return json(400, { error: "This confirmation link is invalid or has expired. Create your account again to get a new one." });
    if (p.usedLinks.has(t.n) || !p.credentials.release(t.n, userIdFor(t.e), String(cb.bind ?? ""))) return json(400, { error: "This confirmation link was already used, has expired, or was opened in a different browser from the one you signed up in. Open it in that browser, or create your account again." });
    p.usedLinks.add(t.n, t.exp * 1000);
    return signedIn(t.e);
  }

  // ---- log in ----
  if (path === "/api/auth/login") {
    const b = c.body() ?? {};
    const email = emailOf(b.email);
    if (!email || typeof b.password !== "string" || !b.password || b.password.length > 1_000) return json(400, { error: "Enter your email and password." });
    const userId = userIdFor(email);
    if (p.isPlatformOwner(userId)) return json(403, { error: OWNER_MESSAGE });
    if (p.loginFails.recent(email, nowMs).length >= MAX_FAILED_LOGINS) return json(429, { error: "Too many incorrect attempts. Wait 15 minutes, or reset your password." });
    // The try is counted before the slow check, so a burst of parallel guesses cannot all slip under the limit.
    p.loginFails.record(email, nowMs);
    if (!(await p.credentials.verify(userId, b.password))) return json(401, { error: "Incorrect email or password." });
    p.loginFails.clear(email);
    return signedIn(email);
  }

  // ---- forgot or first-time password: an emailed link sets a new one (also how an existing link-only account gets a password) ----
  if (path === "/api/auth/forgot") {
    const email = emailOf((c.body() ?? {}).email);
    if (!email) return json(400, { error: "Enter a valid email address." });
    if (p.resets.recent(email, nowMs).length >= MAX_RESET_EMAILS_PER_HOUR) return json(429, { error: "Too many reset emails to this address. Please try again in an hour." });
    p.resets.record(email, nowMs);
    const link = c.makeToken({ k: "reset", e: email, n: randomBytes(12).toString("hex") }, RESET_SECONDS);
    if (!p.isPlatformOwner(userIdFor(email))) {
      await send(email, passwordResetEmail(`${base}/signin.html#reset=${link}`, brand));
    }
    const devLink = p.cfg.allowDevAuth && !p.isPlatformOwner(userIdFor(email)) ? { devLink: link } : {};
    return json(200, { ok: true, ...(p.cfg.allowDevAuth ? { dev: true, ...devLink } : {}) });
  }
  if (path === "/api/auth/reset") {
    const b = c.body() ?? {};
    const t = c.readToken(String(b.token ?? ""));
    if (!t || t.k !== "reset" || typeof t.e !== "string" || typeof t.n !== "string") return json(400, { error: "This reset link is invalid or has expired. Ask for a new one." });
    if (p.usedLinks.has(t.n)) return json(400, { error: "This reset link was already used. Ask for a new one." });
    const problem = passwordProblem(b.password, t.e);
    if (problem) return json(400, { error: problem, field: "password" });
    const userId = userIdFor(t.e);
    if (p.isPlatformOwner(userId)) return json(403, { error: OWNER_MESSAGE });
    p.usedLinks.add(t.n, t.exp * 1000);
    await p.credentials.set(userId, b.password);
    return signedIn(t.e);
  }

  // ---- change the password while logged in ----
  if (path === "/api/auth/password") {
    const claims = c.sessionClaims(req);
    if (!claims || typeof claims.e !== "string") return json(401, { error: "sign in first" });
    const userId = userIdFor(claims.e);
    if (p.isPlatformOwner(userId)) return json(403, { error: OWNER_MESSAGE });
    const b = c.body() ?? {};
    const problem = passwordProblem(b.password, claims.e);
    if (problem) return json(400, { error: problem, field: "password" });
    if (p.credentials.has(userId)) {
      if (p.loginFails.recent(claims.e, nowMs).length >= MAX_FAILED_LOGINS) return json(429, { error: "Too many incorrect attempts. Wait 15 minutes." });
      if (typeof b.current !== "string" || !(await p.credentials.verify(userId, b.current))) {
        p.loginFails.record(claims.e, nowMs);
        return json(401, { error: "Your current password is not right.", field: "current" });
      }
    }
    await p.credentials.set(userId, b.password);
    // Sessions started before the change end, so this caller gets a fresh one.
    return json(200, { ok: true, token: c.issueSession(claims.e) });
  }
  return json(404, { error: "not found" });
}
