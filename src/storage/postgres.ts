import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import type { Sink, Snapshot } from "../core/persistence.js";
import type { AuditEvent } from "../modules/audit/index.js";
import type { Connection } from "../modules/channels/index.js";
import type { EnergyPlan, UsageRecord } from "../modules/energy/index.js";
import type { Role, Workspace } from "../modules/identity/index.js";
import type { AdminMessage, AdminOrgRecord } from "../modules/admin-manager/index.js";
import type { Account, JournalEntry } from "../modules/ledger/index.js";
import type { BusinessProfile, Employee } from "../modules/workforce/index.js";
import type { IntegrationConnection, StoredRecord } from "../modules/integrations/service.js";
import type { ReviewItem } from "../modules/review/index.js";
import type { PriceChange } from "../modules/pricing/index.js";
import type { SpecialistRequest } from "../modules/review/specialists.js";
import type { AiRoutingSettings } from "../modules/model-gateway/routing/settings.js";
import type { BatchJob, BatchRunRecord } from "../modules/batch/service.js";
import type { ClientSchedule } from "../modules/batch/schedule.js";
import type { AiDay } from "../modules/model-gateway/routing/ledger.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Dates come back as plain "YYYY-MM-DD" strings and bigints as numbers (all our amounts are far below 2^53).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export interface PgConfig {
  /** Platform role: creates customers and loads everything at start. Bypasses row-level security. */
  adminUrl: string;
  /** Customer role (app_user): every write runs inside one workspace and cannot touch another. */
  appUrl: string;
  /** 32 bytes as 64 hex characters. Encrypts chat bot tokens at rest. */
  tokenKeyHex: string;
}

/** Stores every change in order, behind the in-memory services. A failed write marks the store unhealthy. */
export class PgStore implements Sink {
  private admin: pg.Pool;
  private app: pg.Pool;
  private key: Buffer;
  private chain: Promise<void> = Promise.resolve();
  lastError?: Error;

  constructor(cfg: PgConfig) {
    this.admin = new pg.Pool({ connectionString: cfg.adminUrl, max: 4 });
    this.app = new pg.Pool({ connectionString: cfg.appUrl, max: 8 });
    this.key = Buffer.from(cfg.tokenKeyHex, "hex");
    if (this.key.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes as 64 hex characters");
  }

  get healthy(): boolean {
    return !this.lastError;
  }

  /** Waits until everything queued so far is written. */
  async flush(): Promise<void> {
    await this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
    await Promise.all([this.admin.end(), this.app.end()]);
  }

  /** Applies db/*.sql files not yet applied, in name order. */
  async migrate(dir = join(import.meta.dirname, "../../db")): Promise<string[]> {
    await this.admin.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await this.admin.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()) {
      if (done.has(f)) continue;
      const c = await this.admin.connect();
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(join(dir, f), "utf8"));
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    return applied;
  }

  // ---------- writing ----------
  private queue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch((e) => {
      this.lastError = e instanceof Error ? e : new Error(String(e));
      console.error("storage write failed:", this.lastError.message);
    });
  }

  /** Runs inside one transaction with the workspace declared, so row-level security applies. */
  private scoped(workspaceId: string, fn: (c: pg.PoolClient) => Promise<void>): void {
    this.queue(async () => {
      const c = await this.app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        await fn(c);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    });
  }

  private state(workspaceId: string, kind: string, id: string, data: unknown): void {
    // Captured now, so later changes to the object cannot slip into an earlier write.
    const json = JSON.stringify(data);
    this.scoped(workspaceId, async (c) => {
      await c.query(
        `INSERT INTO state_records(workspace_id, kind, id, data) VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id, kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [workspaceId, kind, id, json],
      );
    });
  }

  workspace(w: Workspace): void {
    this.queue(async () => {
      await this.admin.query(
        "INSERT INTO workspaces(id, name, type, language, base_currency, time_zone, owner_email) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING",
        [w.id, w.name, w.type, w.language, w.baseCurrency, w.timeZone, w.ownerEmail ?? null],
      );
    });
  }
  membership(workspaceId: string, userId: string, role: Role): void {
    this.scoped(workspaceId, async (c) => {
      await c.query(
        "INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        [workspaceId, userId, role],
      );
    });
  }
  employee(e: Employee): void {
    this.scoped(e.workspaceId, async (c) => {
      await c.query("INSERT INTO employees(id, workspace_id, template_key, name) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [e.id, e.workspaceId, e.templateKey, e.name]);
    });
  }
  profile(workspaceId: string, p: BusinessProfile): void {
    this.state(workspaceId, "profile", "main", p);
  }
  adminOrg(workspaceId: string, r: AdminOrgRecord): void {
    this.state(workspaceId, "admin_org", "main", r);
  }
  adminMessage(m: AdminMessage): void {
    this.state(m.workspaceId, "admin_msg", m.id, m);
  }
  training(workspaceId: string, employeeId: string, notes: string | undefined): void {
    this.state(workspaceId, "training", employeeId, { notes: notes ?? null });
  }
  account(workspaceId: string, a: Account): void {
    this.state(workspaceId, "account", a.code, a);
  }
  plan(workspaceId: string, p: EnergyPlan): void {
    this.state(workspaceId, "plan", "main", p);
  }
  connection(c: Connection): void {
    this.state(c.workspaceId, "connection", `${c.channel}:${c.externalWorkspace}`, c);
  }
  link(workspaceId: string, key: string, userId: string): void {
    this.state(workspaceId, "link", key, { userId });
  }
  slackToken(workspaceId: string, team: string, token: string): void {
    this.state(workspaceId, "slack_token", team, { enc: this.encrypt(token) });
  }
  integration(c: IntegrationConnection): void {
    this.state(c.workspaceId, "integration", c.id, c);
  }
  integrationSecret(workspaceId: string, connectionId: string, secret: string): void {
    // Same AES-256-GCM as chat bot tokens. A removed secret is stored as an empty value.
    this.state(workspaceId, "int_secret", connectionId, { enc: secret ? this.encrypt(secret) : "" });
  }
  integrationRecord(r: StoredRecord): void {
    this.state(r.workspaceId, "int_record", r.id, r);
  }
  review(r: ReviewItem): void {
    // Stored under the client's workspace, so row-level security keeps one client's tasks from another.
    this.state(r.workspaceId, "review", r.id, r);
  }
  specialistRequest(r: SpecialistRequest): void {
    this.state(r.workspaceId, "specialist_req", r.id, r);
  }
  /** Platform records belong to no client: written with the platform role, never readable by app_user. */
  priceChange(c: PriceChange, removed = false): void {
    const json = JSON.stringify(c);
    this.queue(async () => {
      if (removed) await this.admin.query("DELETE FROM platform_records WHERE kind = 'price_change' AND id = $1", [c.id]);
      else await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('price_change', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [c.id, json],
      );
    });
  }
  aiSettings(s: AiRoutingSettings): void {
    const json = JSON.stringify(s);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('ai_settings', 'current', $1)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [json],
      );
    });
  }
  aiDay(d: AiDay): void {
    const json = JSON.stringify(d);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('ai_day', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [d.day, json],
      );
    });
  }
  batchJob(j: BatchJob): void {
    this.state(j.workspaceId, "batch_job", j.id, j);
  }
  batchSchedule(workspaceId: string, s: ClientSchedule): void {
    this.state(workspaceId, "batch_schedule", "current", s);
  }
  batchRun(r: BatchRunRecord): void {
    const json = JSON.stringify(r);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('batch_run', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [r.id, json],
      );
    });
  }
  entry(e: JournalEntry): void {
    this.scoped(e.workspaceId, async (c) => {
      await c.query("INSERT INTO journal_entries(id, workspace_id, entry_date, memo, source, reverses) VALUES ($1,$2,$3,$4,$5,$6)", [e.id, e.workspaceId, e.date, e.memo, e.source ?? null, e.reverses ?? null]);
      let n = 0;
      for (const l of e.lines) await c.query("INSERT INTO journal_lines(entry_id, workspace_id, account, debit, credit, line_no) VALUES ($1,$2,$3,$4,$5,$6)", [e.id, e.workspaceId, l.account, l.debit, l.credit, n++]);
    });
  }
  usage(u: UsageRecord): void {
    this.scoped(u.workspaceId, async (c) => {
      await c.query(
        "INSERT INTO energy_usage(workspace_id, employee_id, day, provider, input_tokens, output_tokens, cost_micro, energy, overtime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [u.workspaceId, u.employeeId, u.day, u.provider, u.inputTokens, u.outputTokens, u.costMicro, u.energy, u.overtime],
      );
    });
  }
  audit(e: AuditEvent): void {
    this.scoped(e.workspaceId, async (c) => {
      await c.query("INSERT INTO audit_log(workspace_id, at, actor, action, target, data, event_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [e.workspaceId, e.at, e.actor, e.action, e.target ?? null, e.data ? JSON.stringify(e.data) : null, e.id]);
    });
  }

  // ---------- reading (platform role, at start-up) ----------
  async load(): Promise<Snapshot> {
    await this.flush();
    const q = async (sql: string) => (await this.admin.query(sql)).rows;
    const states = await q("SELECT workspace_id, kind, id, data FROM state_records ORDER BY updated_at, id");
    const of = (kind: string) => states.filter((s) => s.kind === kind);
    const lines = await q("SELECT entry_id, account, debit, credit FROM journal_lines ORDER BY entry_id, line_no");
    const byEntry = new Map<string, { account: string; debit: number; credit: number }[]>();
    for (const l of lines) (byEntry.get(l.entry_id) ?? byEntry.set(l.entry_id, []).get(l.entry_id)!).push({ account: l.account, debit: l.debit, credit: l.credit });
    return {
      workspaces: (await q("SELECT * FROM workspaces ORDER BY created_at")).map((r) => ({ id: r.id, name: r.name, type: r.type, language: r.language, baseCurrency: r.base_currency, timeZone: r.time_zone, ...(r.owner_email ? { ownerEmail: r.owner_email } : {}), ...(r.created_at ? { createdAt: new Date(r.created_at).toISOString() } : {}) })),
      memberships: (await q("SELECT * FROM memberships")).map((r) => ({ workspaceId: r.workspace_id, userId: r.user_id, role: r.role })),
      employees: (await q("SELECT * FROM employees")).map((r) => ({ id: r.id, workspaceId: r.workspace_id, templateKey: r.template_key, name: r.name })),
      profiles: of("profile").map((s) => ({ workspaceId: s.workspace_id, profile: s.data })),
      adminOrgs: of("admin_org").map((s) => s.data),
      adminMessages: of("admin_msg").map((s) => s.data).sort((a, b) => a.at.localeCompare(b.at)),
      training: of("training").filter((s) => s.data.notes !== null).map((s) => ({ workspaceId: s.workspace_id, employeeId: s.id, notes: s.data.notes })),
      accounts: of("account").map((s) => ({ workspaceId: s.workspace_id, account: s.data })),
      entries: (await q("SELECT * FROM journal_entries ORDER BY created_at, id")).map((r) => ({
        id: r.id, workspaceId: r.workspace_id, date: r.entry_date, memo: r.memo, source: r.source ?? undefined, reverses: r.reverses ?? undefined, lines: byEntry.get(r.id) ?? [],
      })),
      usage: (await q("SELECT * FROM energy_usage ORDER BY id")).map((r) => ({
        workspaceId: r.workspace_id, employeeId: r.employee_id, day: r.day, provider: r.provider, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costMicro: r.cost_micro, energy: r.energy, overtime: r.overtime,
      })),
      plans: of("plan").map((s) => ({ workspaceId: s.workspace_id, plan: s.data })),
      audit: (await q("SELECT * FROM audit_log ORDER BY id")).map((r) => ({
        id: r.event_id, workspaceId: r.workspace_id, actor: r.actor, action: r.action, target: r.target ?? undefined, data: r.data ?? undefined, at: r.at,
      })) as AuditEvent[],
      connections: of("connection").map((s) => s.data),
      links: of("link").map((s) => ({ workspaceId: s.workspace_id, key: s.id, userId: s.data.userId })),
      slackTokens: of("slack_token").map((s) => ({ team: s.id, token: this.decrypt(s.data.enc) })),
      integrations: of("integration").map((s) => s.data),
      integrationSecrets: of("int_secret").filter((s) => s.data.enc).map((s) => ({ connectionId: s.id, secret: this.decrypt(s.data.enc) })),
      integrationRecords: of("int_record").map((s) => s.data),
      reviews: of("review").map((s) => s.data),
      specialistRequests: of("specialist_req").map((s) => s.data),
      priceChanges: (await q("SELECT data FROM platform_records WHERE kind = 'price_change' ORDER BY updated_at, id")).map((r) => r.data),
      aiSettings: (await q("SELECT data FROM platform_records WHERE kind = 'ai_settings' AND id = 'current'"))[0]?.data,
      batchJobs: of("batch_job").map((s) => s.data),
      batchSchedules: of("batch_schedule").map((s) => ({ workspaceId: s.workspace_id, schedule: s.data })),
      batchRuns: (await q("SELECT data FROM platform_records WHERE kind = 'batch_run' ORDER BY updated_at, id")).map((r) => r.data),
      aiDays: (await q("SELECT data FROM platform_records WHERE kind = 'ai_day' ORDER BY id")).map((r) => r.data),
    } as Snapshot;
  }

  // ---------- chat bot tokens: AES-256-GCM ----------
  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
  }
  private decrypt(enc: string): string {
    const [iv, tag, ct] = enc.split(".").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(ct!), d.final()]).toString("utf8");
  }
}
