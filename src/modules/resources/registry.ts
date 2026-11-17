import { allowedTemplate } from "../integrations/access.js";
import { cheaperAlternatives } from "./rule.js";
import type { Resource, ResourceCost, ResourceState } from "./types.js";

/**
 * The one place that answers, for one client and one employee: what can I use right now, what is each thing good for,
 * what does it cost, and what must I ask first.
 *
 * Nothing is stored here. Every answer is assembled, at the moment it is asked, from the modules that own the data,
 * through the same public functions their own screens use (`ResourceSources`, wired in `src/server/platform.ts`). So an
 * app, data source or paid service that is added to one of those modules shows up here without a change to this file.
 */

/** One app from the integrations catalogue (`IntegrationService.catalogue()`). */
export interface AppEntry {
  key: string;
  name: string;
  category: string;
  availability: string;
  capabilities: readonly string[];
  /** How a client can connect it today. "bridge" means not directly yet. */
  connect: string;
  /** Employees that get this app's data unless the owner changes it. */
  defaultAccess: readonly string[];
}

/** One of the client's app connections (`IntegrationService.list()`). */
export interface ConnectionEntry {
  connectorKey: string;
  status: string;
  access: readonly string[];
  lastSyncAt?: string;
  needsChoice?: boolean;
}

/** The Data mining agent's desk for one client (`DataMiningService.overview()`). */
export interface MiningEntry {
  hired: boolean;
  sources: readonly { id: string; label: string; gives: string; energy: number; paid: boolean; available: boolean; reason?: string }[];
  datasets: readonly { topic: string; createdAt: string; sharedWith: readonly string[]; sources: readonly { id: string; status: string }[] }[];
}

/** One paid-per-use service (`PaidServices.list()`). */
export interface PaidEntry {
  key: string;
  name: string;
  kind: string;
  summary: string;
  connected: boolean;
  quote?: { energy: number };
}

/** Records the client keeps inside MAIZ (staff records, the rota): whether this employee is given them, and whether any exist. */
export interface RecordsEntry {
  key: string;
  name: string;
  goodFor: string;
  gives: readonly string[];
  /** "ready": there are records and this employee is given them. "empty": it would be given them, but none exist yet. */
  state: "ready" | "empty";
  fix: { label: string; href: string };
}

/** One of the client's own outside AI tools (`AgentService.overview()`). */
export interface OutsideToolEntry { name: string; status: string; employees: readonly string[] }

export interface ResourceSources {
  /** The client's employees as this person may see them. Must throw when the person is not a member of the workspace. */
  team(userId: string, workspaceId: string): readonly { templateKey: string }[];
  hasProfile(userId: string, workspaceId: string): boolean;
  apps(): readonly AppEntry[];
  connections(userId: string, workspaceId: string): readonly ConnectionEntry[];
  mining(userId: string, workspaceId: string): MiningEntry;
  paid(): readonly PaidEntry[];
  records(userId: string, workspaceId: string, templateKey: string): readonly RecordsEntry[];
  outsideTools?(userId: string, workspaceId: string): readonly OutsideToolEntry[];
  /** What an ordinary task has been using lately, for the "about N energy" figure. */
  taskEnergy?(workspaceId: string): number;
  now(): Date;
}

export const DATA_MINING_KEY = "data-mining-agent";
const APPS = "#apps";
const STORE = "#store";
const MARKET_DATA = "#mining";
const DAY_MS = 86_400_000;

/** What each kind of app data is, as a tag for the choice rule and in words a client would use. */
const CAPABILITY: Record<string, { tag: string; words: string }> = {
  "sales.read": { tag: "sales", words: "sales and takings" },
  "payroll.read": { tag: "payroll", words: "payroll totals" },
  "accounts.read": { tag: "books", words: "monthly income, costs and profit" },
  "traffic.read": { tag: "website-visits", words: "website visits" },
  "search.read": { tag: "search", words: "Google search clicks" },
  "crm.read": { tag: "leads", words: "leads and deals" },
  "support.read": { tag: "support", words: "support tickets" },
  "inbox.read": { tag: "inbox", words: "message counts" },
  "bookings.read": { tag: "bookings", words: "bookings" },
  "audience.read": { tag: "audience", words: "email list and campaigns" },
  "tasks.read": { tag: "tasks", words: "tasks and projects" },
  "reviews.read": { tag: "reviews", words: "customer reviews" },
};
/** A capability added later still appears: its tag is the part before the dot. */
const capabilityOf = (c: string): { tag: string; words: string } => CAPABILITY[c] ?? { tag: c.split(".")[0] || c, words: (c.split(".")[0] || c).replace(/-/g, " ") };

/** What each public source supplies. A source added later still appears, under its own id. */
const SOURCE_TAG: Record<string, string> = {
  hackernews: "public-opinion", reddit: "public-opinion", youtube: "public-opinion", x: "public-opinion",
  news: "news", economy: "economy", prices: "share-price", companies: "company-records",
};
const sourceTag = (id: string): string => SOURCE_TAG[id] ?? id;

/** Employees whose job is making content, so media rendering is theirs to ask for. */
const MEDIA_ROLES = new Set(["marketing-manager", "content-creator", "social-media-content", "creative-studio", "pr-communications"]);
const mediaTag = (p: PaidEntry): string | undefined => (/video/i.test(p.summary) ? "video" : /voice|speech|audio/i.test(p.summary) ? "audio" : /image|picture|photo/i.test(p.summary) ? "image" : undefined);

const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** How old something is, in words. */
export function ageWords(iso: string | undefined, now: Date, verb: string): string {
  if (!iso) return `nothing ${verb} yet`;
  const days = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.parse(iso.slice(0, 10))) / DAY_MS);
  if (!Number.isFinite(days)) return `nothing ${verb} yet`;
  return days <= 0 ? `${verb} today` : days === 1 ? `${verb} yesterday` : `${verb} ${days} days ago`;
}

const KNOWN: ResourceCost = { class: "known" };

/** Runs one module's part on its own: a module that fails drops its own resources, never the whole list. */
function part(out: Resource[], build: () => Resource[]): void {
  try { out.push(...build()); } catch { /* that module has nothing to offer this employee right now */ }
}

export class ResourceRegistry {
  constructor(private readonly s: ResourceSources) {}

  /**
   * Everything one employee of one client could use, ready or not. The person must be a member of the workspace and
   * the employee must be on that client's team; anything else looks like an employee that does not exist.
   */
  forEmployee(userId: string, workspaceId: string, templateKey: string): Resource[] {
    // Outside the try blocks on purpose: a person who is not a member gets the permission error, not an empty list.
    const team = this.s.team(userId, workspaceId);
    if (!team.some((e) => e.templateKey === templateKey)) throw new Error("employee not found");
    const out: Resource[] = [];
    part(out, () => this.profile(userId, workspaceId));
    part(out, () => this.records(userId, workspaceId, templateKey));
    part(out, () => this.apps(userId, workspaceId, templateKey));
    part(out, () => this.mining(userId, workspaceId, templateKey));
    part(out, () => this.paid(templateKey));
    part(out, () => this.outsideTools(userId, workspaceId, templateKey));
    out.push({
      key: "model:open", kind: "model", name: "Your own writing and analysis", goodFor: "Drafts, plans, summaries and analysis.", gives: ["writing"],
      state: "ready", allowed: true, needsApproval: false, cost: { class: "energy", ...(this.s.taskEnergy ? { energy: this.s.taskEnergy(workspaceId) } : {}) },
    });
    const cheaper = cheaperAlternatives(out);
    return out.map((r) => (cheaper.has(r.key) ? { ...r, cheaper: cheaper.get(r.key)!.name } : r));
  }

  private profile(userId: string, workspaceId: string): Resource[] {
    const has = this.s.hasProfile(userId, workspaceId);
    return [{
      key: "known:profile", kind: "profile", name: "Business profile", goodFor: "What the business does, who it serves, its tone, country and currency.", gives: ["business-profile"],
      state: has ? "ready" : "not_connected", allowed: true, cost: KNOWN, needsApproval: false,
      ...(has ? {} : { fix: { by: "client" as const, label: "Fill in your business profile", href: "#settings" } }),
    }];
  }

  private records(userId: string, workspaceId: string, templateKey: string): Resource[] {
    return this.s.records(userId, workspaceId, templateKey).map((r): Resource => ({
      key: `known:${r.key}`, kind: "records", name: r.name, goodFor: r.goodFor, gives: r.gives,
      state: r.state === "ready" ? "ready" : "not_connected", allowed: true, cost: KNOWN, needsApproval: false,
      ...(r.state === "ready" ? { freshness: "current" } : { fix: { by: "client" as const, ...r.fix } }),
    }));
  }

  private apps(userId: string, workspaceId: string, templateKey: string): Resource[] {
    // The Admin manager runs setup, not the business: it is never given app data (integrations/access.ts).
    const mayHaveAppData = allowedTemplate(templateKey);
    const conns = new Map(this.s.connections(userId, workspaceId).map((c) => [c.connectorKey, c]));
    const now = this.s.now();
    return this.s.apps().filter((a) => a.capabilities.length > 0).map((a): Resource => {
      const caps = a.capabilities.map(capabilityOf);
      const conn = conns.get(a.key);
      const base = { key: `app:${a.key}`, kind: "app" as const, name: a.name, goodFor: `Your ${caps.map((c) => c.words).join(", ")}, read from ${a.name}.`, gives: caps.map((c) => c.tag), cost: KNOWN, needsApproval: false };
      if (conn) {
        // Connected: the owner's own list for this connection decides, nothing else.
        const allowed = mayHaveAppData && conn.access.includes(templateKey);
        const usable = !conn.needsChoice && (conn.status === "connected" || !!conn.lastSyncAt);
        return {
          ...base, allowed, state: usable ? "ready" : "not_connected",
          freshness: ageWords(conn.lastSyncAt, now, "read"),
          ...(usable ? {} : { fix: { by: "client" as const, label: conn.needsChoice ? `Choose which ${a.name} account to use` : `Reconnect ${a.name}`, href: APPS } }),
        };
      }
      const allowed = mayHaveAppData && a.defaultAccess.includes(templateKey);
      const clientCanConnect = a.connect !== "bridge";
      const state: ResourceState = clientCanConnect ? "not_connected" : "waiting_approval";
      return { ...base, allowed, state, fix: clientCanConnect ? { by: "client", label: a.connect === "file" ? `Upload a file from ${a.name}` : `Connect ${a.name}`, href: APPS } : { by: "maiz", label: `${a.name} is not switched on yet`, href: APPS } };
    });
  }

  private mining(userId: string, workspaceId: string, templateKey: string): Resource[] {
    const m = this.s.mining(userId, workspaceId);
    const isMiner = templateKey === DATA_MINING_KEY;
    const out: Resource[] = [];
    const mine = m.datasets.filter((d) => isMiner || d.sharedWith.includes(templateKey));
    if (mine.length) {
      const newest = mine.map((d) => d.createdAt).sort().at(-1)!;
      const tags = [...new Set(mine.flatMap((d) => d.sources.filter((s) => s.status === "ok").map((s) => sourceTag(s.id))))];
      out.push({
        key: "known:datasets", kind: "dataset", name: mine.length === 1 ? `Saved dataset on "${mine[0]!.topic}"` : `${mine.length} saved datasets`,
        goodFor: "Public posts, news and figures already gathered on a topic, each with its link.", gives: tags, state: "ready", allowed: true, cost: KNOWN, needsApproval: false,
        freshness: `newest gathered ${shortDate(newest)}`,
      });
    }
    const hireFix = { by: "client" as const, label: "Hire the Data mining agent", href: STORE };
    for (const s of m.sources) {
      const state: ResourceState = !m.hired ? "not_hired" : s.available ? "ready" : "waiting_approval";
      out.push({
        key: `source:${s.id}`, kind: "data-source", name: s.label, goodFor: s.gives, gives: [sourceTag(s.id)],
        // Only the Data mining agent gathers. Everyone else works from the datasets it shares.
        allowed: isMiner, state, needsApproval: true, cost: { class: s.paid ? "double_energy" : "energy", energy: s.energy },
        ...(state === "not_hired" ? { fix: hireFix } : state === "waiting_approval" ? { fix: { by: "maiz" as const, label: s.reason ?? `${s.label} is not switched on yet`, href: MARKET_DATA } } : {}),
      });
    }
    if (!isMiner && allowedTemplate(templateKey) && m.sources.length) {
      const cheapest = Math.min(...m.sources.filter((s) => s.available).map((s) => s.energy));
      out.push({
        key: "dataset:new", kind: "dataset", name: "Public data on a topic", goodFor: "What people are saying, the news and market figures on a topic you choose, gathered by the Data mining agent and shared with this employee.",
        gives: [...new Set(m.sources.map((s) => sourceTag(s.id)))], allowed: true, needsApproval: true,
        state: m.hired ? "not_connected" : "not_hired",
        cost: m.hired ? { class: "energy", ...(Number.isFinite(cheapest) ? { energy: cheapest } : {}) } : { class: "money" },
        fix: m.hired ? { by: "client", label: "Gather a dataset on Market data and share it", href: MARKET_DATA } : hireFix,
      });
    }
    return out;
  }

  private paid(templateKey: string): Resource[] {
    return this.s.paid().filter((p) => p.kind === "api").map((p): Resource => {
      const tag = mediaTag(p);
      return {
        key: `paid:${p.key}`, kind: "paid-service", name: p.name, goodFor: p.summary, gives: [tag ?? p.key],
        allowed: tag ? MEDIA_ROLES.has(templateKey) : allowedTemplate(templateKey),
        state: p.connected ? "ready" : "waiting_approval", needsApproval: true,
        cost: { class: "double_energy", ...(p.quote ? { energy: p.quote.energy } : {}) },
        ...(p.connected ? {} : { fix: { by: "maiz" as const, label: `${p.name} is not switched on yet`, href: APPS } }),
      };
    });
  }

  private outsideTools(userId: string, workspaceId: string, templateKey: string): Resource[] {
    return (this.s.outsideTools?.(userId, workspaceId) ?? []).filter((t) => t.status === "active" && t.employees.includes(templateKey)).map((t): Resource => ({
      key: `tool:${t.name}`, kind: "outside-tool", name: t.name, goodFor: "Your own AI tool or automation. It can send this employee jobs, inside the limits you set.", gives: [],
      state: "ready", allowed: true, needsApproval: false, cost: { class: "energy" },
    }));
  }
}
