// The three client screens that used to show examples: Approvals, Books and cash and the Compliance calendar.
// This module owns no business records of its own except the client's own calendar dates. It reads the modules
// that do (always through their own permission checks, as the signed-in person) and hands plain data to the pure
// builders next to it. See docs/OVERVIEW-DATA.md for every source each screen reads.
import { SetupError, type AdminManager } from "../admin-manager/index.js";
import { TEAM_PACKAGE_KEY } from "../store/cart.js";
import type { AgentService } from "../agents/index.js";
import type { EnergyMeter } from "../energy/index.js";
import type { IdentityService } from "../identity/index.js";
import type { IntegrationService } from "../integrations/index.js";
import type { Ledger } from "../ledger/index.js";
import type { MetaClientService } from "../meta-clients/index.js";
import type { PaymentService } from "../payments/index.js";
import type { PeopleService } from "../people/index.js";
import type { ReconciliationService } from "../reconciliation/index.js";
import type { QualityReviewService } from "../review/index.js";
import type { SpecialistReviewService } from "../review/specialists.js";
import { localParts } from "../batch/schedule.js";
import { buildApprovals, summarise, type ApprovalItem, type ApprovalSources, type ApprovalSummary } from "./approvals.js";
import { BOOKS_PERIODS, buildBooks, type BooksConnection, type BooksView, type Brings } from "./books.js";
import { REMIND_CHOICES, REPEATS, buildCalendar, finishedOwn, type CalendarItem, type CalendarSources } from "./calendar.js";
import { OwnDatesService } from "./own-dates.js";

export * from "./approvals.js";
export * from "./books.js";
export * from "./calendar.js";
export * from "./own-dates.js";

/** A specialist MAIZ approved stays on the list this long; after that it waits quietly on the Team screen. */
export const SPECIALIST_SHOWN_DAYS = 30;
const DAY_MS = 86_400_000;

export interface OverviewDeps {
  identity: IdentityService;
  now: () => Date;
  /** The client's time zone (the same one their batch schedule and weekly refill use). */
  timezone: (workspaceId: string) => string;
  agents: Pick<AgentService, "overview">;
  metaClients: Pick<MetaClientService, "list" | "listPosts">;
  people: Pick<PeopleService, "dated">;
  reviews: Pick<QualityReviewService, "forClient">;
  specialists: Pick<SpecialistReviewService, "forClient" | "approved">;
  integrations: Pick<IntegrationService, "list" | "recordsOf" | "signInExpiries" | "registry">;
  ledger: Pick<Ledger, "rawBooks">;
  reconciliation: Pick<ReconciliationService, "latestFor">;
  payments: Pick<PaymentService, "mine">;
  energy: Pick<EnergyMeter, "planOf">;
  admin: Pick<AdminManager, "status">;
  /** Everyone on the client's team, one entry per kind of employee. */
  team: (workspaceId: string) => { key: string; title: string }[];
  notify: (workspaceId: string, notice: { title: string; body: string }) => void;
  /** The next monthly anniversary of a payment after `at`. */
  paidThrough: (paidAt: string, at: Date) => Date;
}

export interface ApprovalsView { items: ApprovalItem[]; summary: ApprovalSummary; at: string }
export interface CalendarView {
  today: string;
  items: CalendarItem[];
  /** One-off dates of the client's own that were ticked, so a tick can be taken back. */
  done: { id: string; title: string; date: string }[];
  canEdit: boolean;
  /** False when this person may not open staff records, so the screen can say staff dates are left out. */
  staffIncluded: boolean;
  team: { key: string; title: string }[];
  choices: { repeat: readonly string[]; remindDays: readonly number[] };
}

const BRINGS: Record<string, Brings> = { "sales.read": "sales", "payroll.read": "payroll", "accounts.read": "accounts" };

export function createOverview(d: OverviewDeps) {
  const dates = new OwnDatesService({ identity: d.identity, now: d.now, timezone: d.timezone, team: d.team, notify: d.notify });

  /** A moment as the client's own calendar day. */
  const localDay = (instant: Date, ws: string): string => {
    const l = localParts(instant, d.timezone(ws));
    return `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
  };
  const dayOf = (iso: string, ws: string): string | undefined => (Number.isNaN(Date.parse(iso)) ? undefined : localDay(new Date(iso), ws));

  /** Apps that bring money figures, in the order they were connected. Analytics and inbox apps are left out. */
  const moneyApps = (userId: string, ws: string): BooksConnection[] =>
    d.integrations.list(userId, ws)
      .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt))
      .flatMap((c) => {
        const connector = d.integrations.registry.get(c.connectorKey);
        const brings = [...new Set((connector?.capabilities ?? []).map((cap) => BRINGS[cap]).filter((b): b is Brings => !!b))];
        return connector && brings.length ? [{ id: c.id, app: connector.name, category: connector.category, brings, status: c.status, ...(c.lastSyncAt ? { lastSyncAt: c.lastSyncAt } : {}) }] : [];
      });

  const pendingFigures = (userId: string, ws: string): ApprovalSources["pendingFigures"] => {
    const apps = moneyApps(userId, ws);
    const waiting = d.integrations.recordsOf(ws).filter((r) => r.status === "pending" && (r.kind === "sales" || r.kind === "payroll") && apps.some((a) => a.id === r.connectionId));
    if (!waiting.length) return undefined;
    const from = apps.filter((a) => waiting.some((r) => r.connectionId === a.id));
    const days = waiting.map((r) => r.date).sort();
    const since = from.map((a) => a.lastSyncAt).filter((t): t is string => !!t).sort().at(-1);
    return {
      count: waiting.filter((r) => r.kind === "sales").length, payRuns: waiting.filter((r) => r.kind === "payroll").length,
      apps: [...new Set(from.map((a) => a.app))], from: days[0]!, to: days.at(-1)!, ...(since ? { since } : {}),
    };
  };

  const specialistsReady = (userId: string, ws: string): ApprovalSources["specialists"] => {
    const approvedAt = new Map(d.specialists.approved().filter((r) => r.workspaceId === ws).map((r) => [r.id, r.updatedAt]));
    const earliest = new Date(d.now().getTime() - SPECIALIST_SHOWN_DAYS * DAY_MS).toISOString();
    return d.specialists.forClient(userId, ws)
      .filter((s) => s.canHire)
      .map((s) => ({ id: s.id, title: s.title, priceGbp: s.priceGbp, approvedAt: approvedAt.get(s.id) ?? s.submittedAt }))
      .filter((s) => s.approvedAt >= earliest);
  };

  /**
   * True until the team has been set up from the client's answers. The same rule as the setup card on the
   * Overview, so the card and the count never disagree.
   */
  const setupWaiting = (userId: string, ws: string): boolean => {
    try {
      return d.admin.status(userId, ws).state !== "ready";
    } catch (e) {
      // A business that was never welcomed has no setup to wait for. Anything else is a real fault.
      if (e instanceof SetupError) return false;
      throw e;
    }
  };

  const approvalSources = (userId: string, ws: string): ApprovalSources => {
    const tools = d.agents.overview(userId, ws);
    const accounts = new Map(d.metaClients.list(userId, ws).map((c) => [c.id, c.name]));
    const mayDecide = d.identity.can(userId, ws, "approval.decide");
    const setup = setupWaiting(userId, ws);
    const since = d.identity.workspaceById(ws)?.createdAt;
    const figures = pendingFigures(userId, ws);
    return {
      agentJobs: tools.jobs.filter((j) => j.status === "waiting_for_owner").map((j) => ({ id: j.id, connectionName: j.connectionName, employeeTitle: j.employeeTitle, brief: j.brief, estimate: j.estimate, reason: j.reason, createdAt: j.createdAt })),
      canManageTools: tools.canManage,
      posts: d.metaClients.listPosts(userId, ws).filter((p) => p.status === "awaiting_approval").map((p) => {
        const account = accounts.get(p.connectionId);
        return { id: p.id, kind: p.kind, text: p.text, createdAt: p.createdAt, ...(account ? { account } : {}), ...(p.scheduledFor ? { scheduledFor: p.scheduledFor } : {}) };
      }),
      canDecidePosts: mayDecide,
      // Staff records are personal data: only the people who may open them hear about leave.
      leave: mayDecide && d.identity.can(userId, ws, "people.manage") ? d.people.dated(userId, ws).leave : [],
      reviews: d.reviews.forClient(userId, ws)
        .filter((r) => r.status === "gathering_info" || r.status === "more_info_requested")
        .map((r) => ({ id: r.id, title: r.title, employee: r.employee, energy: r.energy, questions: r.brief.filter((b) => !b.value?.trim() && !b.optional).map((b) => b.label), updatedAt: r.updatedAt })),
      specialists: specialistsReady(userId, ws),
      ...(figures ? { pendingFigures: figures } : {}),
      ...(setup ? { setup: since ? { since } : {} } : {}),
    };
  };

  /** Everything waiting for this person's business, most urgent first. */
  const approvals = (userId: string, ws: string): ApprovalsView => {
    d.identity.require(userId, ws, "task.read");
    const items = buildApprovals(approvalSources(userId, ws), d.now());
    return { items, summary: summarise(items), at: d.now().toISOString() };
  };

  /** Figures from connected apps and from the client's books, for the last 7, 30 or 90 days. */
  const books = (userId: string, ws: string, days: number): BooksView => {
    d.identity.require(userId, ws, "task.read");
    const period = (BOOKS_PERIODS as readonly number[]).includes(days) ? days : 30;
    const check = d.reconciliation.latestFor(ws);
    const held = d.ledger.rawBooks(ws);
    return buildBooks({
      today: localDay(d.now(), ws), days: period, baseCurrency: d.identity.workspaceById(ws)?.baseCurrency ?? "GBP",
      connections: moneyApps(userId, ws), records: d.integrations.recordsOf(ws),
      ...(held ? { books: held } : {}), ...(check ? { check } : {}),
    });
  };

  const planDates = (userId: string, ws: string): CalendarSources["plan"] => {
    const plan = d.energy.planOf(ws);
    const ends = plan.expiresAt ? dayOf(plan.expiresAt, ws) : undefined;
    const renewals = d.payments.mine(userId, ws)
      .filter((o) => o.status === "paid" && o.monthlyMinor > 0 && !!o.paidAt)
      // A cancelled Team package is shown once, as the day it ends, not as a payment that will not be taken.
      .filter((o) => !(plan.endedPaid && o.lines.some((l) => l.key === TEAM_PACKAGE_KEY)))
      .map((o) => ({ orderId: o.id, on: localDay(d.paidThrough(o.paidAt!, d.now()), ws), what: o.lines.filter((l) => l.billing === "monthly").map((l) => l.title).join(", ") || "Your plan", monthlyMinor: o.monthlyMinor }));
    return { ...(ends && !plan.endedPaid ? { trialEndsOn: ends } : {}), ...(ends && plan.endedPaid ? { planEndsOn: ends } : {}), renewals };
  };

  const calendarSources = (userId: string, ws: string, staffIncluded: boolean): CalendarSources => {
    const withDay = <T extends { at: string }>(xs: T[]): (T & { expiresOn: string })[] => xs.flatMap((x) => { const on = dayOf(x.at, ws); return on ? [{ ...x, expiresOn: on }] : []; });
    return {
      today: localDay(d.now(), ws),
      ...(staffIncluded ? { staff: d.people.dated(userId, ws).dates } : {}),
      plan: planDates(userId, ws),
      toolKeys: withDay(d.agents.overview(userId, ws).connections.map((c) => ({ id: c.id, name: c.name, at: c.keyExpiresAt }))),
      socialSignIns: withDay(d.metaClients.list(userId, ws).flatMap((c) => (c.expiresAt ? [{ id: c.id, name: c.name, kind: c.kind, at: c.expiresAt }] : []))),
      appSignIns: withDay(d.integrations.signInExpiries(userId, ws).map((x) => ({ id: x.connectionId, app: x.app, at: x.expiresAt }))),
      own: dates.list(userId, ws).map((x) => { const employeeTitle = dates.employeeTitle(ws, x.employee); return { date: x, ...(employeeTitle ? { employeeTitle } : {}) }; }),
    };
  };

  /** Every real date this business has, soonest first, and what the form to add one needs. */
  const calendar = (userId: string, ws: string): CalendarView => {
    d.identity.require(userId, ws, "task.read");
    const staffIncluded = d.identity.can(userId, ws, "people.manage");
    const sources = calendarSources(userId, ws, staffIncluded);
    return {
      today: sources.today, items: buildCalendar(sources), done: finishedOwn(sources.own.map((o) => o.date), sources.today),
      canEdit: d.identity.can(userId, ws, "approval.decide"), staffIncluded, team: d.team(ws), choices: { repeat: REPEATS, remindDays: REMIND_CHOICES },
    };
  };

  return { approvals, books, calendar, dates };
}

export type Overview = ReturnType<typeof createOverview>;
