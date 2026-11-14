import type { PublishInput } from "../meta/index.js";
import type { AccountInsights, ExchangeResult, FoundAsset, MetaConnection, MetaKind, MetaMode, MetaSecret, PostResults, Published } from "./types.js";

/** Everything the service needs from Meta. Two implementations: LiveProvider (Graph API) and SandboxProvider (simulated). */
export interface MetaProvider {
  readonly mode: MetaMode;
  /** The Meta login address to send the client to (Facebook Login for Business). `state` comes back to the callback. */
  authorizeUrl(kind: MetaKind, state: string, redirectUri: string): string;
  /** Trades the login code for the person's id, the permissions they granted and the accounts they can choose. */
  exchange(kind: MetaKind, code: string, redirectUri: string): Promise<ExchangeResult>;
  /** WhatsApp Embedded Signup: the code from the signup window plus the ids it reported. */
  exchangeWhatsApp(code: string, wabaId: string, phoneNumberId: string): Promise<FoundAsset>;
  /** Asks Meta whether a token still works and when it expires. */
  inspect(secret: MetaSecret): Promise<{ valid: boolean; scopes: string[]; expiresAt?: string }>;
  publish(conn: MetaConnection, secret: MetaSecret, input: PublishInput): Promise<Published>;
  results(conn: MetaConnection, secret: MetaSecret, postId: string, now: Date): Promise<PostResults>;
  insights(conn: MetaConnection, secret: MetaSecret, now: Date): Promise<AccountInsights>;
  sendWhatsApp(conn: MetaConnection, secret: MetaSecret, to: string, message: { text: string } | { template: { name: string; language: string }; body: string }): Promise<void>;
  /** Removes the client's grant at Meta (best effort) when they disconnect. */
  revoke(conn: MetaConnection, secret: MetaSecret): Promise<void>;
}

/** Meta refused because the app or account is sending too much, or asked us to wait. */
export class MetaThrottled extends Error {
  constructor(message: string, readonly retryAfterMs: number) { super(message); }
}
/** The saved token no longer works (the person removed the app, changed their password, or it expired). */
export class MetaTokenInvalid extends Error {}

/** Meta error codes that mean "slow down": app-level 4, 17, 341; page-level 32; business-use 80001-80006, 80008; generic 613. */
export const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008]);
export const isRateLimit = (code: number | undefined): boolean => code !== undefined && RATE_LIMIT_CODES.has(code);
