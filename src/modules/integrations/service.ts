import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { Ledger } from "../ledger/index.js";
import { allowedTemplate, defaultAccessFor } from "./access.js";
import type { ConnectorRegistry } from "./catalogue.js";
import { parseWebhookBody } from "./connectors/webhook.js";
import { toPayrollEntry, toSalesEntry, PAYROLL_ACCOUNTS } from "./posting.js";
import { IntegrationError, type Connector, type Credentials, type DateRange, type OAuthApp, type AccountsMonth, type ParsedFile, type PayrollRun, type SalesDay } from "./types.js";

export interface IntegrationConnection {
  id: string;
  workspaceId: string;
  connectorKey: string;
  status: "connected" | "disconnected" | "error";
  connectedAt: string;
  connectedBy: string;
  /** The account in the other app (Square merchant id). Never a secret. */
  externalAccount?: string;
  lastSyncAt?: string;
  lastError?: string;
  /** Employee template keys allowed to use this connection's data. */
  access: string[];
}

export interface StoredRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  kind: "sales" | "payroll" | "accounts";
  /** YYYY-MM-DD, or YYYY-MM for a month of accounts. */
  date: string;
  data: SalesDay | PayrollRun | AccountsMonth;
  /** pending: waiting for the owner to add it to the books. reference: the owner's own books elsewhere, read only. */
  status: "pending" | "posted" | "reference";
  entryId?: string;
}

export interface ImportResult {
  connectionId: string;
  added: number;
  updated: number;
  unchanged: number;
  /** Records already in the books whose numbers changed in the app: the owner must look. */
  conflicts: string[];
  warnings: string[];
  unmapped: string[];
}

export interface IntegrationOptions {
  http?: typeof fetch;
  now?: () => Date;
  /** Our OAuth app per connector key, from environment variables. */
  oauthApps?: Record<string, OAuthApp>;
}

const DAY_MS = 86_400_000;
/** The API accepts bodies up to 1 MB, and the file travels inside JSON. */
const MAX_FILE_BYTES = 900_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Connects apps to an organisation, keeps their credentials, imports their data as pending
 * records, and posts confirmed records to the ledger. Employees see only what they are granted.
 */
export class IntegrationService {
  private connections = new Map<string, IntegrationConnection>();
  private secrets = new Map<string, Credentials>();
  private records = new Map<string, StoredRecord>();
  private sink?: Sink;
  private http: typeof fetch;
  private now: () => Date;

  constructor(
    private identity: IdentityService,
    private audit: AuditLog,
    private ledger: Ledger,
    readonly registry: ConnectorRegistry,
    private opts: IntegrationOptions = {},
  ) {
    this.http = opts.http ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  useSink(sink: Sink): void { this.sink = sink; }
  restoreConnection(c: IntegrationConnection): void { this.connections.set(c.id, c); }
  restoreSecret(connectionId: string, secret: string): void { if (secret) this.secrets.set(connectionId, JSON.parse(secret)); }
  restoreRecord(r: StoredRecord): void { this.records.set(r.id, r); }

  /** The store page: every app, with whether we can connect it directly right now. */
  catalogue() {
    return this.registry.list().map((c) => ({
      key: c.key, name: c.name, category: c.category, summary: c.summary, availability: c.availability, note: c.note, regions: c.regions,
      capabilities: c.capabilities,
      connect: connectMode(c, !!this.opts.oauthApps?.[c.key]),
      fields: c.auth.kind === "api_key" ? c.auth.fields : undefined,
      howToExport: c.auth.kind === "file" ? c.auth.howToExport : undefined,
      acceptsFiles: !!c.parseFile,
      defaultAccess: defaultAccessFor(c.capabilities),
    }));
  }

  list(userId: string, workspaceId: string): IntegrationConnection[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.connections.values()].filter((c) => c.workspaceId === workspaceId && c.status !== "disconnected").map((c) => ({ ...c, access: [...c.access] }));
  }

  /** Platform-level (no user check): every stored record of one workspace, for the nightly reconciliation. */
  recordsOf(workspaceId: string): StoredRecord[] {
    return [...this.records.values()].filter((r) => r.workspaceId === workspaceId);
  }

  pending(userId: string, workspaceId: string): StoredRecord[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.records.values()].filter((r) => r.workspaceId === workspaceId && r.status === "pending").sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------- connecting ----------

  /** Where to send the owner to approve an OAuth app. `state` is signed by the caller and comes back to the callback. */
  authorizeUrl(userId: string, workspaceId: string, key: string, state: string): string {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.registry.require(key);
    const app = this.opts.oauthApps?.[key];
    if (c.auth.kind !== "oauth2" || !app) throw new IntegrationError(`${c.name} cannot be connected directly yet. Upload a file instead.`);
    const url = new URL(c.auth.authorizeUrl);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("scope", c.auth.scopes.join(" "));
    url.searchParams.set("redirect_uri", app.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    for (const [k, v] of Object.entries(c.auth.authorizeParams ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  async completeOAuth(userId: string, workspaceId: string, key: string, code: string): Promise<IntegrationConnection> {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.registry.require(key);
    const app = this.opts.oauthApps?.[key];
    if (c.auth.kind !== "oauth2" || !app) throw new IntegrationError("this app is not set up for direct connection");
    const { credentials, externalAccount } = c.exchangeCode ? await c.exchangeCode(this.http, app, code) : await standardExchange(this.http, c.auth.tokenUrl, app, code);
    return this.save(userId, workspaceId, c, credentials, externalAccount);
  }

  connectWithKey(userId: string, workspaceId: string, key: string, values: Record<string, unknown>): IntegrationConnection {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.registry.require(key);
    if (c.auth.kind !== "api_key") throw new IntegrationError(`${c.name} does not use an API key`);
    const clean: Record<string, string> = {};
    for (const f of c.auth.fields) {
      const v = typeof values[f.key] === "string" ? (values[f.key] as string).trim() : "";
      if (!v || v.length > 500) throw new IntegrationError(`${f.label} is required`);
      clean[f.key] = v;
    }
    const problem = c.validate?.(clean);
    if (problem) throw new IntegrationError(problem);
    return this.save(userId, workspaceId, c, { kind: "api_key", values: clean });
  }

  /** Creates a private webhook link. The secret is returned once and only its hash is kept. */
  createWebhook(userId: string, workspaceId: string): { connection: IntegrationConnection; secret: string } {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const secret = randomBytes(24).toString("base64url");
    const connection = this.save(userId, workspaceId, this.registry.require("webhook"), { kind: "webhook", secret: sha256(secret) });
    return { connection, secret };
  }

  disconnect(userId: string, workspaceId: string, connectionId: string): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const conn = this.own(workspaceId, connectionId);
    this.update({ ...conn, status: "disconnected" });
    this.secrets.delete(conn.id);
    this.sink?.integrationSecret(workspaceId, conn.id, "");
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "integration.disconnected", target: conn.id, data: { app: conn.connectorKey } });
  }

  /** Owner decides which employees may use this app's data. */
  setAccess(userId: string, workspaceId: string, connectionId: string, templateKeys: readonly unknown[]): IntegrationConnection {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const conn = this.own(workspaceId, connectionId);
    const access = [...new Set(templateKeys.map(String))].filter(allowedTemplate);
    const next = { ...conn, access };
    this.update(next);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "integration.access_changed", target: conn.id, data: { access } });
    return next;
  }

  // ---------- data in ----------

  /** Pull from a live app. Default: the last 30 days. */
  async sync(userId: string, workspaceId: string, connectionId: string, range?: DateRange): Promise<ImportResult> {
    this.identity.require(userId, workspaceId, "task.create");
    const conn = this.own(workspaceId, connectionId);
    const c = this.registry.require(conn.connectorKey);
    const creds = this.secrets.get(conn.id);
    if (!c.read || !creds) throw new IntegrationError(`${c.name} cannot be synced: upload a file instead`);
    const today = this.now().toISOString().slice(0, 10);
    const r = range ?? { from: new Date(this.now().getTime() - 30 * DAY_MS).toISOString().slice(0, 10), to: today };
    try {
      const fresh = await this.freshCredentials(conn, c, creds);
      const data = await c.read({ credentials: fresh, http: this.http, now: this.now, currency: this.currency(userId, workspaceId) }, r);
      this.update({ ...conn, status: "connected", lastSyncAt: this.now().toISOString(), lastError: undefined });
      return this.store(conn.id, workspaceId, { ...data, warnings: [], unmapped: [] });
    } catch (e) {
      const msg = e instanceof IntegrationError ? e.message : "the app could not be reached";
      this.update({ ...conn, status: "error", lastError: msg });
      throw new IntegrationError(msg);
    }
  }

  /** An exported file from an app. Creates the connection on first upload so access rules apply. */
  importFile(userId: string, workspaceId: string, key: string, text: string, opts: { date?: string } = {}): ImportResult {
    this.identity.require(userId, workspaceId, "task.create");
    const c = this.registry.require(key);
    if (!c.parseFile) throw new IntegrationError(`${c.name} does not take files`);
    if (!text.trim()) throw new IntegrationError("the file is empty");
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new IntegrationError("the file is too big: export a shorter date range");
    const parsed = c.parseFile(text, { currency: this.currency(userId, workspaceId), date: opts.date });
    const conn = [...this.connections.values()].find((x) => x.workspaceId === workspaceId && x.connectorKey === key && x.status !== "disconnected")
      ?? this.save(userId, workspaceId, c, undefined);
    this.update({ ...conn, lastSyncAt: this.now().toISOString() });
    return this.store(conn.id, workspaceId, parsed);
  }

  /** Public webhook. Answers the same "not found" for a wrong id and a wrong secret. */
  receiveWebhook(connectionId: string, secret: string, body: unknown): ImportResult | undefined {
    const conn = this.connections.get(connectionId);
    const creds = conn ? this.secrets.get(conn.id) : undefined;
    if (!conn || conn.status === "disconnected" || creds?.kind !== "webhook") return undefined;
    const a = Buffer.from(sha256(secret)), b = Buffer.from(creds.secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    const ws = this.identity.workspacesFor(conn.connectedBy).find((w) => w.id === conn.workspaceId);
    const result = this.store(conn.id, conn.workspaceId, parseWebhookBody(body, ws?.baseCurrency ?? "USD"));
    this.update({ ...conn, lastSyncAt: this.now().toISOString() });
    return result;
  }

  // ---------- data out: books and employees ----------

  /** Adds every pending record to the books. Numbers come from the app, never from a model. */
  post(userId: string, workspaceId: string): { posted: number; skipped: string[] } {
    this.identity.require(userId, workspaceId, "task.create");
    const base = this.currency(userId, workspaceId);
    this.ensureAccounts(userId, workspaceId);
    let posted = 0;
    const skipped: string[] = [];
    for (const r of this.pending(userId, workspaceId)) {
      const conn = this.connections.get(r.connectionId)!;
      const label = `${this.registry.get(conn.connectorKey)?.name ?? conn.connectorKey} ${r.kind} ${r.date}`;
      if (r.data.currency !== base) { skipped.push(`${label}: in ${r.data.currency}, your books are in ${base}`); continue; }
      const input = r.kind === "sales" ? toSalesEntry(r.data as SalesDay, label) : toPayrollEntry(r.data as PayrollRun, label);
      if (!input) { skipped.push(`${label}: nothing to record`); continue; }
      try {
        const entry = this.ledger.post(userId, workspaceId, { ...input, source: `app:${r.id}` });
        this.saveRecord({ ...r, status: "posted", entryId: entry.id });
        posted++;
      } catch (e) {
        skipped.push(`${label}: ${e instanceof Error ? e.message : "could not be recorded"}`);
      }
    }
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "integration.posted", data: { posted, skipped: skipped.length } });
    return { posted, skipped };
  }

  /**
   * What an employee may know from connected apps, as plain text for its instructions.
   * Only connections that list the employee's template; totals only, no personal pay data.
   */
  contextFor(workspaceId: string, templateKey: string): string | undefined {
    const allowed = new Set([...this.connections.values()].filter((c) => c.workspaceId === workspaceId && c.status !== "disconnected" && c.access.includes(templateKey)).map((c) => c.id));
    if (!allowed.size) return undefined;
    const since = new Date(this.now().getTime() - 92 * DAY_MS).toISOString().slice(0, 10);
    const recs = [...this.records.values()].filter((r) => allowed.has(r.connectionId) && r.date >= since.slice(0, r.kind === "accounts" ? 7 : 10));
    if (!recs.length) return "Connected apps: none have sent data in the last three months.";
    const fmt = (n: number, cur: string) => `${(n / 100).toFixed(2)} ${cur}`;
    const lines = ["Figures from the owner's connected apps (from the app itself, not estimates; 'pending' means not yet in the books):"];
    const months = new Map<string, { gross: number; tax: number; fees: number; refunds: number; n: number; cur: string; pending: boolean }>();
    for (const r of recs.filter((x) => x.kind === "sales")) {
      const d = r.data as SalesDay;
      const k = `${r.date.slice(0, 7)}|${d.currency}`;
      const m = months.get(k) ?? { gross: 0, tax: 0, fees: 0, refunds: 0, n: 0, cur: d.currency, pending: false };
      m.gross += d.gross; m.tax += d.tax; m.fees += d.fees; m.refunds += d.refunds; m.n += d.transactions; m.pending ||= r.status === "pending";
      months.set(k, m);
    }
    for (const [k, m] of [...months].sort()) lines.push(`- Sales ${k.split("|")[0]}: takings ${fmt(m.gross, m.cur)} (tax ${fmt(m.tax, m.cur)}), card fees ${fmt(m.fees, m.cur)}, refunds ${fmt(m.refunds, m.cur)}, ${m.n} transactions${m.pending ? ", some pending" : ""}`);
    for (const r of recs.filter((x) => x.kind === "accounts").sort((a, b) => a.date.localeCompare(b.date))) {
      const a = r.data as AccountsMonth;
      const app = this.registry.get(this.connections.get(r.connectionId)?.connectorKey ?? "")?.name ?? "accounting app";
      lines.push(`- Books in ${app} ${a.month}: income ${fmt(a.income, a.currency)}, cost of sales ${fmt(a.costOfSales, a.currency)}, expenses ${fmt(a.expenses, a.currency)}, net profit ${fmt(a.netProfit, a.currency)}`);
    }
    for (const r of recs.filter((x) => x.kind === "payroll").sort((a, b) => a.date.localeCompare(b.date))) {
      const p = r.data as PayrollRun;
      lines.push(`- Payroll paid ${p.payDate}: ${p.headcount} staff, gross ${fmt(p.gross, p.currency)}, employer costs ${fmt(p.employerInsurance + p.employerPension, p.currency)}, net ${fmt(p.net, p.currency)}${r.status === "pending" ? " (pending)" : ""}`);
    }
    return lines.join("\n");
  }

  // ---------- internals ----------

  /** Refreshes an expired OAuth token (Xero's last 30 minutes) and stores the new one. */
  private async freshCredentials(conn: IntegrationConnection, c: Connector, creds: Credentials): Promise<Credentials> {
    if (creds.kind !== "oauth2" || !c.refresh || !creds.expiresAt) return creds;
    if (Date.parse(creds.expiresAt) - this.now().getTime() > 60_000) return creds;
    const app = this.opts.oauthApps?.[c.key];
    if (!app) throw new IntegrationError(`${c.name} is not set up for direct connection`);
    const next = await c.refresh(this.http, app, creds);
    this.secrets.set(conn.id, next);
    this.sink?.integrationSecret(conn.workspaceId, conn.id, JSON.stringify(next));
    return next;
  }

  private save(userId: string, workspaceId: string, c: Connector, creds: Credentials | undefined, externalAccount?: string): IntegrationConnection {
    const existing = [...this.connections.values()].find((x) => x.workspaceId === workspaceId && x.connectorKey === c.key && x.status !== "disconnected" && c.auth.kind !== "webhook");
    const conn: IntegrationConnection = existing
      ? { ...existing, status: "connected", externalAccount: externalAccount ?? existing.externalAccount, lastError: undefined }
      : { id: newId("integration"), workspaceId, connectorKey: c.key, status: "connected", connectedAt: this.now().toISOString(), connectedBy: userId, externalAccount, access: defaultAccessFor(c.capabilities) };
    this.update(conn);
    if (creds) {
      this.secrets.set(conn.id, creds);
      this.sink?.integrationSecret(workspaceId, conn.id, JSON.stringify(creds));
    }
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "integration.connected", target: conn.id, data: { app: c.key } });
    return conn;
  }

  private store(connectionId: string, workspaceId: string, parsed: ParsedFile): ImportResult {
    const out: ImportResult = { connectionId, added: 0, updated: 0, unchanged: 0, conflicts: [], warnings: [...parsed.warnings], unmapped: parsed.unmapped };
    const items: { kind: StoredRecord["kind"]; date: string; data: StoredRecord["data"] }[] = [
      ...(parsed.sales ?? []).map((d) => ({ kind: "sales" as const, date: d.date, data: d })),
      ...(parsed.payroll ?? []).map((d) => ({ kind: "payroll" as const, date: d.payDate, data: d })),
      ...(parsed.accounts ?? []).map((d) => ({ kind: "accounts" as const, date: d.month, data: d })),
    ];
    for (const it of items) {
      const id = `${connectionId}:${it.kind}:${it.date}`;
      const prev = this.records.get(id);
      const same = prev && JSON.stringify(prev.data) === JSON.stringify(it.data);
      if (same) { out.unchanged++; continue; }
      if (it.kind === "accounts") {
        // The owner's books in their accounting app change as they work: always take the latest, never post.
        this.saveRecord({ id, workspaceId, connectionId, kind: it.kind, date: it.date, data: it.data, status: "reference" });
        if (prev) out.updated++; else out.added++;
        continue;
      }
      if (prev?.status === "posted") { out.conflicts.push(`${it.kind} ${it.date} is already in your books with different numbers. Reverse that entry first if the app is right.`); continue; }
      this.saveRecord({ id, workspaceId, connectionId, kind: it.kind, date: it.date, data: it.data, status: "pending" });
      if (prev) out.updated++; else out.added++;
    }
    return out;
  }

  private ensureAccounts(userId: string, workspaceId: string): void {
    const have = new Set(this.ledger.chart(userId, workspaceId).map((a) => a.code));
    for (const a of PAYROLL_ACCOUNTS) if (!have.has(a.code) && this.identity.can(userId, workspaceId, "workspace.manage")) this.ledger.addAccount(userId, workspaceId, a);
  }

  private currency(userId: string, workspaceId: string): string {
    return this.identity.workspacesFor(userId).find((w) => w.id === workspaceId)?.baseCurrency ?? "USD";
  }

  private own(workspaceId: string, connectionId: string): IntegrationConnection {
    const c = this.connections.get(connectionId);
    // Another organisation's connection looks exactly like one that does not exist.
    if (!c || c.workspaceId !== workspaceId || c.status === "disconnected") throw new IntegrationError("connection not found");
    return c;
  }

  private update(c: IntegrationConnection): void {
    this.connections.set(c.id, c);
    this.sink?.integration(c);
  }

  private saveRecord(r: StoredRecord): void {
    this.records.set(r.id, r);
    this.sink?.integrationRecord(r);
  }
}

/** RFC 6749 authorization-code exchange, form encoded. Most apps accept this as is. */
async function standardExchange(http: typeof fetch, tokenUrl: string, app: OAuthApp, code: string) {
  const res = await http(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri }),
  });
  const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!res.ok || !o.access_token) throw new IntegrationError("the app did not approve the connection");
  const expiresAt = o.expires_in ? new Date(Date.now() + o.expires_in * 1000).toISOString() : undefined;
  return { credentials: { kind: "oauth2" as const, accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt }, externalAccount: undefined };
}

/** How the store card connects an app today. An OAuth app without our keys set falls back to its file or the bridge. */
function connectMode(c: Connector, haveOAuthApp: boolean): "oauth" | "api_key" | "webhook" | "file" | "bridge" {
  if (c.auth.kind === "oauth2") return haveOAuthApp ? "oauth" : c.parseFile ? "file" : "bridge";
  if (c.auth.kind === "api_key" || c.auth.kind === "webhook" || c.auth.kind === "bridge") return c.auth.kind;
  return "file";
}
