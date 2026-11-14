import { createHash } from "node:crypto";
import type { PublishInput } from "../meta/index.js";
import type { MetaProvider } from "./provider.js";
import { scopeParam } from "./permissions.js";
import type { AccountInsights, ExchangeResult, FoundAsset, MetaConnection, MetaKind, MetaSecret, PostResults, Published } from "./types.js";

export interface SentWhatsApp { to: string; at: string; text: string; template?: string }

/**
 * A pretend Meta. Every flow works end to end (login, choosing an account, posting, results, WhatsApp, revoking)
 * but nothing leaves the server and every id is marked sandbox. Used until Meta approves the app, and for demos and tests.
 * Results are derived from the post id, so they are stable and the same on every run.
 */
export class SandboxProvider implements MetaProvider {
  readonly mode = "sandbox" as const;
  readonly outbox: SentWhatsApp[] = [];
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  authorizeUrl(kind: MetaKind, state: string, redirectUri: string): string {
    // The sandbox "Meta login" is our own page that explains what a real login would ask for and returns a fake code.
    const u = new URL("/sandbox-meta.html", redirectUri);
    u.searchParams.set("kind", kind);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", scopeParam(kind));
    return u.toString();
  }

  async exchange(kind: MetaKind, code: string): Promise<ExchangeResult> {
    if (!code.startsWith("sandbox-")) throw new Error("not a sandbox code");
    const seed = hash(code);
    const metaUserId = `9${seed.slice(0, 14).replace(/\D/g, "1")}`.slice(0, 15);
    const mk = (k: "facebook" | "instagram", n: string, handle?: string): FoundAsset => ({
      kind: k, externalId: `sandbox-${k}-${hash(code + n).slice(0, 10)}`, name: n, handle, accessToken: `sandbox-token-${hash(code + n)}`,
      pageId: k === "instagram" ? `sandbox-facebook-${hash(code + "Sunrise Bakery").slice(0, 10)}` : undefined,
    });
    const assets: FoundAsset[] = kind === "instagram"
      ? [mk("instagram", "Sunrise Bakery (test)", "@sunrise_bakery_test")]
      : [mk("facebook", "Sunrise Bakery (test Page)"), mk("facebook", "Sunrise Cafe (test Page)")];
    return { metaUserId, scopes: scopeParam(kind).split(","), assets };
  }

  async exchangeWhatsApp(code: string, wabaId: string, phoneNumberId: string): Promise<FoundAsset> {
    if (!code.startsWith("sandbox-")) throw new Error("not a sandbox code");
    return { kind: "whatsapp", externalId: phoneNumberId, name: "Sunrise Bakery (test WhatsApp)", accessToken: `sandbox-token-${hash(code)}`, wabaId, phoneNumberId, displayNumber: "+44 7700 900 000 (test)" };
  }

  async inspect(secret: MetaSecret) {
    return { valid: secret.accessToken.startsWith("sandbox-token-"), scopes: [], expiresAt: secret.expiresAt };
  }

  async publish(conn: MetaConnection, _s: MetaSecret, input: PublishInput): Promise<Published> {
    this.counter++;
    const id = `sandbox-${conn.kind}-post-${hash(conn.id + input.message + this.counter + this.now().getTime()).slice(0, 10)}`;
    return { id, url: `https://example.invalid/sandbox/${conn.kind}/${id}`, simulated: true };
  }

  async results(_c: MetaConnection, _s: MetaSecret, postId: string, now: Date): Promise<PostResults> {
    const n = parseInt(hash(postId).slice(0, 6), 16);
    return { likes: 5 + (n % 60), comments: n % 9, shares: n % 5, fetchedAt: now.toISOString() };
  }

  async insights(conn: MetaConnection, _s: MetaSecret, now: Date): Promise<AccountInsights> {
    const n = parseInt(hash(conn.id).slice(0, 6), 16);
    return { followers: 120 + (n % 900), reach: 300 + (n % 4000), fetchedAt: now.toISOString() };
  }

  async sendWhatsApp(_c: MetaConnection, _s: MetaSecret, to: string, m: { text: string } | { template: { name: string; language: string }; body: string }): Promise<void> {
    this.outbox.push("template" in m ? { to, at: this.now().toISOString(), text: m.body, template: m.template.name } : { to, at: this.now().toISOString(), text: m.text });
    if (this.outbox.length > 200) this.outbox.shift();
  }

  async revoke(): Promise<void> { /* nothing was ever granted */ }
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
