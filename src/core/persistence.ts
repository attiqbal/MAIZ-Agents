import type { AuditEvent } from "../modules/audit/index.js";
import type { Workspace, Role } from "../modules/identity/index.js";
import type { Employee, BusinessProfile } from "../modules/workforce/index.js";
import type { Account, JournalEntry } from "../modules/ledger/index.js";
import type { EnergyPlan, UsageRecord } from "../modules/energy/index.js";
import type { Connection } from "../modules/channels/index.js";
import type { AdminMessage, AdminOrgRecord } from "../modules/admin-manager/index.js";
import type { IntegrationConnection, StoredRecord } from "../modules/integrations/service.js";
import type { ReviewItem } from "../modules/review/index.js";
import type { PriceChange } from "../modules/pricing/index.js";
import type { SpecialistRequest } from "../modules/review/specialists.js";

/**
 * Where services report every change so it can be stored. Services stay fast and
 * synchronous in memory; the sink writes behind them, in order. Methods must not throw.
 */
export interface Sink {
  workspace(w: Workspace): void;
  membership(workspaceId: string, userId: string, role: Role): void;
  employee(e: Employee): void;
  profile(workspaceId: string, p: BusinessProfile): void;
  /** notes undefined means the training was cleared. */
  training(workspaceId: string, employeeId: string, notes: string | undefined): void;
  account(workspaceId: string, a: Account): void;
  entry(e: JournalEntry): void;
  usage(u: UsageRecord): void;
  plan(workspaceId: string, p: EnergyPlan): void;
  audit(e: AuditEvent): void;
  connection(c: Connection): void;
  link(workspaceId: string, key: string, userId: string): void;
  adminOrg(workspaceId: string, record: AdminOrgRecord): void;
  adminMessage(m: AdminMessage): void;
  slackToken(workspaceId: string, team: string, token: string): void;
  integration(c: IntegrationConnection): void;
  /** Credentials for a connected app as JSON. The store must encrypt it. Empty string means removed. */
  integrationSecret(workspaceId: string, connectionId: string, secret: string): void;
  integrationRecord(r: StoredRecord): void;
  /** A specialised task in MAIZ quality review, replaced on every change. */
  review(r: ReviewItem): void;
  /** A custom specialist waiting for (or past) the platform owner's review. */
  specialistRequest(r: SpecialistRequest): void;
  /** Platform-level (no workspace): a price change by the platform owner. removed = a scheduled change was cancelled. */
  priceChange(c: PriceChange, removed?: boolean): void;
}

/** Everything stored, in the order it must be restored. */
export interface Snapshot {
  workspaces: Workspace[];
  memberships: { workspaceId: string; userId: string; role: Role }[];
  employees: Employee[];
  profiles: { workspaceId: string; profile: BusinessProfile }[];
  training: { workspaceId: string; employeeId: string; notes: string }[];
  accounts: { workspaceId: string; account: Account }[];
  entries: JournalEntry[];
  usage: UsageRecord[];
  plans: { workspaceId: string; plan: EnergyPlan }[];
  audit: AuditEvent[];
  connections: Connection[];
  links: { workspaceId: string; key: string; userId: string }[];
  adminOrgs: AdminOrgRecord[];
  adminMessages: AdminMessage[];
  slackTokens: { team: string; token: string }[];
  integrations?: IntegrationConnection[];
  integrationSecrets?: { connectionId: string; secret: string }[];
  integrationRecords?: StoredRecord[];
  reviews?: ReviewItem[];
  priceChanges?: PriceChange[];
  specialistRequests?: SpecialistRequest[];
}
