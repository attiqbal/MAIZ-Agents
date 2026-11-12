import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { Sink } from "../../core/persistence.js";

/** What is stored for one person's password: only a salted hash, never the password. */
export interface CredentialRecord { hash: string; changedAt: string }

export class PasswordError extends Error {}

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
/** The passwords everyone tries first. Not a full breach list; it stops the worst ones. */
const COMMON = new Set([
  "password", "password1", "password12", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "iloveyou1",
  "11111111", "00000000", "abcd1234", "letmein123", "welcome123", "admin1234", "changeme123", "passw0rd", "p@ssw0rd", "maizagents",
]);

const N = 16_384, R = 8, P = 1, KEYLEN = 32;

const derive = (password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p }, (e, key) => (e ? reject(e) : resolve(key))));

/** A readable reason the password is not allowed, or undefined when it is fine. */
export function passwordProblem(password: unknown, email?: string): string | undefined {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return "That password is too easy to guess. Try a short sentence instead.";
  if (email && (lower === email.toLowerCase() || lower === email.split("@")[0]!.toLowerCase())) return "Your password can't be your email address.";
  return undefined;
}

/** scrypt hash with a fresh salt, as "scrypt$N$r$p$salt$key" (the cost is stored so it can be raised later). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

async function check(password: string, hash: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = hash.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Hash used when the email has no password, so a wrong email costs the same time as a wrong password. */
let decoy: Promise<string> | undefined;

const bindHash = (bind: string): string => createHash("sha256").update(bind).digest("hex");

const MAX_PENDING = 5_000;

export class CredentialStore {
  private records = new Map<string, CredentialRecord>(); // key: user id
  private pending = new Map<string, { userId: string; hash: string; bind: string; expiresAt: number }>(); // key: sign-up link nonce
  private sink?: Sink;

  constructor(private readonly now: () => number = Date.now) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(userId: string, rec: CredentialRecord): void { this.records.set(userId, rec); }

  has(userId: string): boolean { return this.records.has(userId); }

  /** When the password last changed (seconds), so older sessions can be refused. */
  changedAtSeconds(userId: string): number | undefined {
    const at = this.records.get(userId)?.changedAt;
    return at ? Math.floor(Date.parse(at) / 1000) : undefined;
  }

  /** Sets or replaces a person's password. Callers must already have proved the email. */
  async set(userId: string, password: string): Promise<void> {
    const rec = { hash: await hashPassword(password), changedAt: new Date(this.now()).toISOString() };
    this.records.set(userId, rec);
    this.sink?.credential(userId, rec);
  }

  /** True when the password is right. Takes about the same time whether or not the person has one. */
  async verify(userId: string, password: string): Promise<boolean> {
    const rec = this.records.get(userId);
    if (!rec) {
      decoy ??= hashPassword("decoy-password-never-used");
      await check(password, await decoy);
      return false;
    }
    return check(password, rec.hash);
  }

  /**
   * Holds a hashed password until the person proves the email by clicking the link, so nobody can claim an
   * address they do not own. Returns the link's nonce.
   */
  async hold(userId: string, password: string, ttlSeconds: number, bind: string): Promise<string> {
    const nonce = randomBytes(12).toString("hex");
    const t = this.now();
    if (this.pending.size >= MAX_PENDING) for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(nonce, { userId, hash: await hashPassword(password), bind: bindHash(bind), expiresAt: t + ttlSeconds * 1000 });
    return nonce;
  }

  /**
   * Turns a held password into the real one. Works once per link, only for the browser that registered (it holds
   * `bind`, so a link sent to someone else cannot be used to plant a password), and never over an existing password.
   */
  release(nonce: string, userId: string, bind: string): boolean {
    const held = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!held || held.userId !== userId || held.expiresAt <= this.now() || this.records.has(userId)) return false;
    if (held.bind !== bindHash(bind)) return false;
    const rec = { hash: held.hash, changedAt: new Date(this.now()).toISOString() };
    this.records.set(userId, rec);
    this.sink?.credential(userId, rec);
    return true;
  }
}
