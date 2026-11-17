import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events.js";
import { AuditLog } from "../src/modules/audit/index.js";
import { IdentityService, PermissionError } from "../src/modules/identity/index.js";
import { buildApprovals, summarise, type ApprovalSources } from "../src/modules/overview/approvals.js";
import { buildBooks, type BooksInput } from "../src/modules/overview/books.js";
import { buildCalendar, currentOccurrence, dueReminders, type CalendarSources, type OwnDate } from "../src/modules/overview/calendar.js";
import { MAX_OWN_DATES, OverviewError, OwnDatesService } from "../src/modules/overview/own-dates.js";
import { staffDates } from "../src/modules/people/dated.js";
import type { StaffMember } from "../src/modules/people/index.js";
import type { StoredRecord } from "../src/modules/integrations/service.js";
import type { SalesDay } from "../src/modules/integrations/types.js";

const NOW = new Date("2026-11-16T09:00:00Z");
const TODAY = "2026-11-16";

// ------------------------------------------------------------------------------------------------ approvals

const nothing: ApprovalSources = { agentJobs: [], canManageTools: true, posts: [], canDecidePosts: true, leave: [], reviews: [], specialists: [] };

describe("approvals: one list of everything waiting for the client", () => {
  it("is empty when nothing is waiting", () => {
    expect(buildApprovals(nothing, NOW)).toEqual([]);
    expect(summarise([])).toEqual({ total: 0, decideHere: 0, elsewhere: 0 });
  });

  it("turns a waiting job from the client's own tool into an item with working approve and refuse", () => {
    const [item] = buildApprovals({ ...nothing, agentJobs: [{ id: "job-1", connectionName: "Website chatbot", employeeTitle: "Marketing manager", brief: "Write three posts about the autumn menu", estimate: 120, reason: "over_job_limit", createdAt: "2026-11-15T10:00:00Z" }] }, NOW);
    expect(item).toMatchObject({
      id: "agent_job:job-1", kind: "agent_job", source: "Your own AI tools", who: "Website chatbot", title: "Job for your Marketing manager",
      detail: "Write three posts about the autumn menu", energy: 120, at: "2026-11-15T10:00:00Z", dueAt: "2026-11-22T10:00:00.000Z",
    });
    expect(item!.cost).toBe("May use about 120 energy");
    expect(item!.why).toMatch(/more energy than the limit/);
    expect(item!.actions).toEqual([
      { key: "approve", label: "Let it run", path: "/agents/jobs/job-1/approve", body: {} },
      { key: "refuse", label: "Refuse", path: "/agents/jobs/job-1/refuse", body: {} },
    ]);
  });

  it("shows a job but offers no buttons to someone who may not decide it, and says why", () => {
    const [item] = buildApprovals({ ...nothing, canManageTools: false, agentJobs: [{ id: "j", connectionName: "Bot", employeeTitle: "HR manager", brief: "x", estimate: 5, reason: "needs_approval", createdAt: "2026-11-16T08:00:00Z" }] }, NOW);
    expect(item!.actions).toEqual([]);
    expect(item!.blocked).toBe("Only the owner of this business can decide this.");
  });

  it("gives a social post the right words for posting now or later", () => {
    const items = buildApprovals({ ...nothing, posts: [
      { id: "p1", kind: "instagram", account: "Kestrel Coffee", text: "Autumn blend is here", createdAt: "2026-11-16T08:00:00Z" },
      { id: "p2", kind: "facebook", text: "Later", createdAt: "2026-11-16T07:00:00Z", scheduledFor: "2026-11-20T18:00:00.000Z" },
    ] }, NOW);
    const now = items.find((i) => i.id === "social_post:p1")!;
    const later = items.find((i) => i.id === "social_post:p2")!;
    expect(now).toMatchObject({ source: "Social accounts", title: "Post to Instagram: Kestrel Coffee", detail: "Autumn blend is here", cost: "Uses no energy" });
    expect(now.actions.map((a) => [a.label, a.path])).toEqual([["Approve and post now", "/meta/posts/p1/approve"], ["Do not post", "/meta/posts/p1/reject"]]);
    expect(later.title).toBe("Post to Facebook");
    expect(later.actions[0]!.label).toBe("Approve and schedule");
    expect(later.dueAt).toBe("2026-11-20T18:00:00.000Z");
    expect(buildApprovals({ ...nothing, canDecidePosts: false, posts: [{ id: "p1", kind: "facebook", text: "x", createdAt: "2026-11-16T08:00:00Z" }] }, NOW)[0]!.actions).toEqual([]);
  });

  it("lists a leave request with approve and decline that carry the answer", () => {
    const [item] = buildApprovals({ ...nothing, leave: [{ staffId: "s1", staffName: "Priya Shah", leaveId: "l1", kind: "holiday", from: "2026-12-22", to: "2026-12-23", days: 2 }] }, NOW);
    expect(item).toMatchObject({ kind: "leave_request", source: "Staff records", who: "Priya Shah", title: "Holiday request: 2 days", detail: "22 Dec 2026 to 23 Dec 2026", dueAt: "2026-12-22T00:00:00.000Z" });
    expect(item!.at).toBeUndefined();
    expect(item!.actions).toEqual([
      { key: "approve", label: "Approve", path: "/people/s1/leave/l1/decide", body: { approve: true } },
      { key: "refuse", label: "Decline", path: "/people/s1/leave/l1/decide", body: { approve: false } },
    ]);
  });

  it("links to the screen that holds the form when something is decided elsewhere", () => {
    const items = buildApprovals({
      ...nothing,
      reviews: [{ id: "r1", title: "Brand kit", employee: "Brand and content creator", energy: 900, questions: ["Colours you like", "Who buys from you"], updatedAt: "2026-11-16T08:30:00Z" }],
      specialists: [{ id: "sp1", title: "Wholesale coordinator", priceGbp: 35, approvedAt: "2026-11-14T08:00:00Z" }],
      pendingFigures: { count: 3, apps: ["Stripe", "Square"], from: "2026-11-13", to: "2026-11-15", since: "2026-11-16T06:00:00Z" },
      setup: { since: "2026-11-10T09:00:00Z" },
    }, NOW);
    const by = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(by.review_answers).toMatchObject({ who: "Your Brand and content creator", title: "Answers needed: Brand kit", detail: "2 questions: Colours you like; Who buys from you", cost: "The work will use about 900 energy once it starts", link: { label: "Answer on Tasks", href: "#work" }, actions: [] });
    expect(by.specialist_hire).toMatchObject({ who: "MAIZ quality review", title: "Ready to hire: Wholesale coordinator", cost: "£35 a month if you hire", monthlyGbp: 35, link: { label: "Decide on Team", href: "#team" } });
    expect(by.books_pending).toMatchObject({ who: "Stripe and Square", title: "3 days of figures are waiting to go into your books", detail: "13 Nov 2026 to 15 Nov 2026", link: { label: "Open Apps and connections", href: "#apps" } });
    expect(by.setup).toMatchObject({ who: "Your Admin manager", title: "Your team is waiting to meet you", link: { label: "Start your first day", href: "#firstday" } });
    expect(summarise(items)).toEqual({ total: 4, decideHere: 0, elsewhere: 4 });
  });

  it("puts what runs out soonest first, then the newest", () => {
    const items = buildApprovals({
      ...nothing,
      agentJobs: [
        { id: "old", connectionName: "Bot", employeeTitle: "HR manager", brief: "old one", estimate: 5, reason: "needs_approval", createdAt: "2026-11-10T08:00:00Z" },
        { id: "new", connectionName: "Bot", employeeTitle: "HR manager", brief: "new one", estimate: 5, reason: "needs_approval", createdAt: "2026-11-16T08:00:00Z" },
      ],
      posts: [{ id: "post", kind: "facebook", text: "x", createdAt: "2026-11-15T08:00:00Z" }],
      leave: [{ staffId: "s", staffName: "A", leaveId: "soon", kind: "holiday", from: "2026-11-17", to: "2026-11-17", days: 1 }, { staffId: "s", staffName: "A", leaveId: "far", kind: "sick", from: "2027-02-01", to: "2027-02-02", days: 2 }],
    }, NOW);
    // "old" closes by itself tomorrow (7 days after it arrived) and the leave starts tomorrow: both are urgent, soonest first.
    expect(items.map((i) => i.id)).toEqual(["leave_request:s:soon", "agent_job:old", "agent_job:new", "social_post:post", "leave_request:s:far"]);
    expect(items.at(-1)!.title).toBe("Sick leave: 2 days");
  });

  it("shortens very long text from outside and counts what can be decided here", () => {
    const items = buildApprovals({ ...nothing, agentJobs: [{ id: "j", connectionName: "Bot", employeeTitle: "HR manager", brief: "x".repeat(2000), estimate: 5, reason: "needs_approval", createdAt: "2026-11-16T08:00:00Z" }], setup: {} }, NOW);
    expect(items[0]!.detail!.length).toBeLessThanOrEqual(400);
    expect(summarise(items)).toEqual({ total: 2, decideHere: 1, elsewhere: 1 });
  });
});

// ------------------------------------------------------------------------------------------------ books

const day = (date: string, over: Partial<SalesDay> = {}): SalesDay => ({ date, currency: "GBP", gross: 10_000, tax: 1_000, tips: 0, fees: 150, refunds: 0, transactions: 4, ...over });
const sale = (connectionId: string, d: SalesDay, status: StoredRecord["status"] = "pending"): StoredRecord => ({ id: `${connectionId}:sales:${d.date}`, workspaceId: "w1", connectionId, kind: "sales", date: d.date, data: d, status });
const stripe = { id: "c-stripe", app: "Stripe", category: "payments", brings: ["sales" as const], status: "connected" as const, lastSyncAt: "2026-11-16T07:00:00Z" };
const square = { id: "c-square", app: "Square", category: "till", brings: ["sales" as const], status: "connected" as const };
const base: BooksInput = { today: TODAY, days: 30, baseCurrency: "GBP", connections: [], records: [] };

describe("books and cash: only figures a connected app or the books really hold", () => {
  it("says nothing is connected, and shows no figures, for a new client", () => {
    const v = buildBooks(base);
    expect(v.apps).toEqual([]);
    expect(v.sales).toEqual({ sources: [], days: [], totals: [] });
    expect(v.payroll).toEqual([]);
    expect(v.accounts).toEqual([]);
    expect(v.ledger).toEqual({ opened: false, currency: "GBP", entries: 0, fromApps: 0, lines: [], waiting: 0 });
    expect(v.check).toBeUndefined();
    expect(v.period).toEqual({ from: "2026-10-18", to: "2026-11-16", days: 30 });
  });

  it("adds up each app's own figures for the period and names the app on every row", () => {
    const v = buildBooks({
      ...base,
      connections: [stripe, square],
      records: [
        sale("c-stripe", day("2026-11-15")), sale("c-stripe", day("2026-11-14", { gross: 5_000, refunds: 700, fees: 90, transactions: 2 }), "posted"),
        sale("c-square", day("2026-11-15", { gross: 2_000, tips: 300, fees: 35, transactions: 1 })),
        sale("c-stripe", day("2026-10-17")), // one day before the period: left out
      ],
    });
    expect(v.sales.sources).toEqual([
      { connectionId: "c-stripe", app: "Stripe", currency: "GBP", moneyIn: 15_000, tax: 2_000, tips: 0, refunds: 700, fees: 240, transactions: 6, daysWithFigures: 2, firstDate: "2026-11-14", lastDate: "2026-11-15", waiting: 1 },
      { connectionId: "c-square", app: "Square", currency: "GBP", moneyIn: 2_000, tax: 1_000, tips: 300, refunds: 0, fees: 35, transactions: 1, daysWithFigures: 1, firstDate: "2026-11-15", lastDate: "2026-11-15", waiting: 1 },
    ]);
    expect(v.sales.days).toEqual([
      { date: "2026-11-15", currency: "GBP", moneyIn: 12_000, refunds: 0, fees: 185, tips: 300, transactions: 5, apps: ["Stripe", "Square"] },
      { date: "2026-11-14", currency: "GBP", moneyIn: 5_000, refunds: 700, fees: 90, tips: 0, transactions: 2, apps: ["Stripe"] },
    ]);
    expect(v.sales.totals).toEqual([{ currency: "GBP", moneyIn: 17_000, tax: 3_000, tips: 300, refunds: 700, fees: 275, transactions: 7 }]);
    expect(v.apps.map((a) => [a.app, a.lastUpdatedAt])).toEqual([["Stripe", "2026-11-16T07:00:00Z"], ["Square", undefined]]);
  });

  it("keeps currencies apart and leaves out apps the client disconnected", () => {
    const v = buildBooks({
      ...base,
      connections: [stripe, { ...square, status: "disconnected" }],
      records: [sale("c-stripe", day("2026-11-15")), sale("c-stripe", day("2026-11-14", { currency: "EUR", gross: 900 })), sale("c-square", day("2026-11-15"))],
    });
    // Money in two currencies is never added together: each gets its own row and its own total.
    expect(v.sales.totals.map((t) => t.currency).sort()).toEqual(["EUR", "GBP"]);
    expect(v.sales.sources.map((x) => [x.app, x.currency, x.moneyIn])).toEqual([["Stripe", "GBP", 10_000], ["Stripe", "EUR", 900]]);
    expect(v.apps.map((a) => a.app)).toEqual(["Stripe"]);
    expect(v.sales.days.every((d) => d.apps.join() === "Stripe")).toBe(true);
  });

  it("shows pay runs and an accounting app's own months, with profit only when the accounting app reported it", () => {
    const v = buildBooks({
      ...base,
      connections: [{ id: "c-pay", app: "BrightPay", category: "payroll", brings: ["payroll"], status: "connected" }, { id: "c-xero", app: "Xero", category: "accounting", brings: ["accounts"], status: "connected" }, { id: "c-hook", app: "Zapier, Make or any app (webhook)", category: "bridge", brings: ["sales", "payroll", "accounts"], status: "connected" }],
      records: [
        { id: "c-pay:payroll:2026-10-30", workspaceId: "w1", connectionId: "c-pay", kind: "payroll", date: "2026-10-30", status: "posted", data: { payDate: "2026-10-30", currency: "GBP", gross: 400_000, incomeTax: 40_000, employeeInsurance: 20_000, employerInsurance: 30_000, employeePension: 10_000, employerPension: 12_000, otherDeductions: 0, net: 330_000, headcount: 4 } },
        { id: "c-xero:accounts:2026-10", workspaceId: "w1", connectionId: "c-xero", kind: "accounts", date: "2026-10", status: "reference", data: { month: "2026-10", currency: "GBP", income: 900_000, costOfSales: 300_000, expenses: 250_000, netProfit: 350_000 } },
        { id: "c-hook:accounts:2026-10", workspaceId: "w1", connectionId: "c-hook", kind: "accounts", date: "2026-10", status: "reference", data: { month: "2026-10", currency: "GBP", income: 100, costOfSales: 20, expenses: 30, netProfit: 50 } },
        { id: "c-xero:accounts:2026-05", workspaceId: "w1", connectionId: "c-xero", kind: "accounts", date: "2026-05", status: "reference", data: { month: "2026-05", currency: "GBP", income: 1, costOfSales: 1, expenses: 1, netProfit: -1 } },
      ],
    });
    expect(v.payroll).toEqual([{ app: "BrightPay", payDate: "2026-10-30", currency: "GBP", gross: 400_000, net: 330_000, employerCosts: 42_000, headcount: 4, inBooks: true }]);
    expect(v.accounts).toEqual([
      { app: "Xero", month: "2026-10", currency: "GBP", income: 900_000, costOfSales: 300_000, expenses: 250_000, reportedProfit: 350_000 },
      { app: "Zapier, Make or any app (webhook)", month: "2026-10", currency: "GBP", income: 100, costOfSales: 20, expenses: 30 },
    ]);
  });

  it("reports what is recorded in the books by account, and never a bank balance, a profit or a payout", () => {
    const v = buildBooks({
      ...base,
      connections: [stripe],
      records: [sale("c-stripe", day("2026-11-15"), "posted"), sale("c-stripe", day("2026-11-16"))],
      books: {
        accounts: [{ code: "1000", name: "Bank", type: "asset" }, { code: "4000", name: "Sales", type: "income" }, { code: "6500", name: "Card and payment fees", type: "expense" }, { code: "2100", name: "Sales tax payable", type: "liability" }, { code: "6000", name: "Rent", type: "expense" }],
        entries: [
          { id: "e1", workspaceId: "w1", date: "2026-11-15", memo: "Stripe sales", source: "app:c-stripe:sales:2026-11-15", lines: [{ account: "1000", debit: 9_850, credit: 0 }, { account: "6500", debit: 150, credit: 0 }, { account: "4000", debit: 0, credit: 9_000 }, { account: "2100", debit: 0, credit: 1_000 }] },
          { id: "e2", workspaceId: "w1", date: "2026-11-01", memo: "Rent", lines: [{ account: "6000", debit: 80_000, credit: 0 }, { account: "1000", debit: 0, credit: 80_000 }] },
          { id: "e0", workspaceId: "w1", date: "2026-09-01", memo: "Old", lines: [{ account: "6000", debit: 1, credit: 0 }, { account: "1000", debit: 0, credit: 1 }] },
        ] as never,
      },
      check: { id: "r", workspaceId: "w1", date: "2026-11-15", ranAt: "2026-11-16T00:01:00Z", entries: 3, ok: false, findings: [{ check: "x", severity: "error", message: "m" }, { check: "y", severity: "warn", message: "n" }] },
    });
    expect(v.ledger).toEqual({
      opened: true, currency: "GBP", entries: 2, fromApps: 1, lastEntryDate: "2026-11-15", waiting: 1,
      lines: [{ code: "4000", name: "Sales", type: "income", amount: 9_000 }, { code: "6000", name: "Rent", type: "expense", amount: 80_000 }, { code: "6500", name: "Card and payment fees", type: "expense", amount: 150 }],
    });
    expect(v.check).toEqual({ date: "2026-11-15", ranAt: "2026-11-16T00:01:00Z", entriesChecked: 3, ok: false, problems: 1, warnings: 1 });
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/bank|balance|runway|payout|netProfit|cashNow/i);
  });

  it("uses the period the client picked", () => {
    const records = [sale("c-stripe", day("2026-11-10")), sale("c-stripe", day("2026-11-01")), sale("c-stripe", day("2026-09-01"))];
    expect(buildBooks({ ...base, days: 7, connections: [stripe], records }).sales.days.map((d) => d.date)).toEqual(["2026-11-10"]);
    expect(buildBooks({ ...base, days: 90, connections: [stripe], records }).sales.days.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-01", "2026-09-01"]);
  });
});

// ------------------------------------------------------------------------------------------------ calendar

const own = (over: Partial<OwnDate> = {}): OwnDate => ({ id: "d1", workspaceId: "w1", title: "VAT return", date: "2027-01-31", repeat: "none", remindDays: 7, reminded: [], createdBy: "u", createdAt: "2026-11-16T09:00:00.000Z", updatedAt: "2026-11-16T09:00:00.000Z", ...over });
const noSources: CalendarSources = { today: TODAY, plan: { renewals: [] }, toolKeys: [], socialSignIns: [], appSignIns: [], own: [] };

describe("calendar: when a date of the client's own falls next", () => {
  it("keeps a one-off date where it is, even after it has passed", () => {
    expect(currentOccurrence(own({ date: "2026-11-01" }), TODAY)).toEqual({ on: "2026-11-01", done: false });
    expect(currentOccurrence(own({ date: "2026-11-01", doneThrough: "2026-11-01" }), TODAY)).toEqual({ on: "2026-11-01", done: true });
  });

  it("rolls a repeating date forward from the day it was added, not from years ago", () => {
    expect(currentOccurrence(own({ date: "2024-02-07", repeat: "quarterly" }), TODAY)).toEqual({ on: "2027-02-07", done: false });
    expect(currentOccurrence(own({ date: "2026-01-31", repeat: "monthly" }), TODAY)).toEqual({ on: "2026-11-30", done: false });
    expect(currentOccurrence(own({ date: "2024-02-29", repeat: "yearly" }), TODAY)).toEqual({ on: "2027-02-28", done: false });
  });

  it("stays on a missed repeat until it is ticked, then moves to the next one", () => {
    const d = own({ date: "2026-10-20", repeat: "monthly", createdAt: "2026-10-01T09:00:00.000Z" });
    expect(currentOccurrence(d, TODAY)).toEqual({ on: "2026-10-20", done: false });
    expect(currentOccurrence({ ...d, doneThrough: "2026-10-20" }, TODAY)).toEqual({ on: "2026-11-20", done: false });
    expect(currentOccurrence({ ...d, doneThrough: "2026-11-20" }, TODAY)).toEqual({ on: "2026-12-20", done: false });
  });
});

describe("calendar: real dates only, each with where it came from", () => {
  it("shows only the plan date for a brand new client", () => {
    const items = buildCalendar({ ...noSources, plan: { trialEndsOn: "2026-11-23", renewals: [] } });
    expect(items).toEqual([{ id: "plan:trial", kind: "plan", date: "2026-11-23", title: "Your free trial ends", note: "Choose your plan before then to keep your team working. Your work is kept either way.", source: "Your plan", href: "#store", daysLeft: 7, state: "soon" }]);
  });

  it("gathers staff, plan, key and sign-in dates in date order and marks what has passed", () => {
    const items = buildCalendar({
      today: TODAY,
      staff: [
        { id: "staff:s1:doc:food_hygiene", staffName: "Priya Shah", title: "Food hygiene certificate (level 2) runs out", date: "2026-12-01", legal: false },
        { id: "staff:s1:doc:right_to_work", staffName: "Priya Shah", title: "Right-to-work check ran out", date: "2026-11-01", legal: true },
      ],
      plan: { renewals: [{ orderId: "o1", on: "2026-12-10", what: "Team package", monthlyMinor: 15_000 }, { orderId: "o2", on: "2026-12-12", what: "HR manager" }] },
      toolKeys: [{ id: "k1", name: "Website chatbot", expiresOn: "2027-11-16" }],
      socialSignIns: [{ id: "m1", name: "Kestrel Coffee", kind: "facebook", expiresOn: "2027-01-10" }],
      appSignIns: [{ id: "i1", app: "Square", expiresOn: "2026-12-14" }],
      own: [],
    });
    expect(items.map((i) => [i.date, i.kind, i.state])).toEqual([
      ["2026-11-01", "staff", "overdue"], ["2026-12-01", "staff", "soon"], ["2026-12-10", "plan", "soon"], ["2026-12-12", "plan", "soon"], ["2026-12-14", "connection", "soon"], ["2027-01-10", "connection", "later"], ["2027-11-16", "connection", "later"],
    ]);
    expect(items[0]).toMatchObject({ title: "Priya Shah: Right-to-work check ran out", source: "Staff records", href: "#people", daysLeft: -15 });
    expect(items[2]).toMatchObject({ title: "Monthly payment: Team package", note: "£150.00 is taken by card on or near this date.", source: "Your plan", href: "#settings" });
    expect(items[3]!.note).toBe("Taken by card on or near this date.");
    expect(items[4]).toMatchObject({ title: "Your Square sign-in runs out", source: "Apps and connections", href: "#apps" });
    expect(items[5]).toMatchObject({ title: "Your Facebook sign-in for Kestrel Coffee needs renewing", source: "Social accounts", href: "/connect-social.html" });
    expect(items[6]).toMatchObject({ title: "The key for \"Website chatbot\" stops working", source: "Your own AI tools", href: "#apps" });
  });

  it("says when a paid plan is ending instead of a trial", () => {
    expect(buildCalendar({ ...noSources, plan: { planEndsOn: "2026-12-05", renewals: [] } })[0]).toMatchObject({ id: "plan:ends", title: "Your Team package ends", href: "#store" });
  });

  it("includes the client's own dates with who looks after them, and hides ones ticked as done", () => {
    const items = buildCalendar({
      ...noSources,
      own: [
        { date: own({ id: "a", title: "Insurance renewal", date: "2026-12-01", note: "Policy 4471", employee: "compliance-manager" }), employeeTitle: "Compliance manager" },
        { date: own({ id: "b", title: "Old one-off", date: "2026-10-01", doneThrough: "2026-10-01" }) },
        { date: own({ id: "c", title: "Pay the VAT", date: "2026-02-07", repeat: "quarterly" }) },
        { date: own({ id: "d", title: "Missed", date: "2026-11-10" }) },
      ],
    });
    expect(items.map((i) => [i.id, i.date, i.state])).toEqual([["own:d", "2026-11-10", "overdue"], ["own:a", "2026-12-01", "soon"], ["own:c", "2027-02-07", "later"]]);
    expect(items[1]).toMatchObject({ kind: "yours", source: "Added by you", note: "Policy 4471", owner: { key: "compliance-manager", title: "Compliance manager" }, own: { id: "a", firstDate: "2026-12-01", repeat: "none", remindDays: 7 } });
    expect(items[2]!.own).toMatchObject({ repeat: "quarterly", firstDate: "2026-02-07" });
  });

  it("leaves staff dates out for someone who may not open staff records", () => {
    expect(buildCalendar({ ...noSources, staff: undefined })).toEqual([]);
  });
});

describe("calendar: what the staff records know that has a date", () => {
  const member = (over: Partial<StaffMember> = {}): StaffMember => ({
    id: "s1", workspaceId: "w1", name: "Priya Shah", jobTitle: "Barista", startDate: "2026-03-02", contract: "part_time", hoursPerWeek: 24, daysPerWeek: 3, pension: "enrolled", rtwRoute: "share_code",
    rtwExpiresOn: "2027-03-01", documents: { right_to_work: { status: "checked", checkedOn: "2026-03-01", updatedAt: "x" }, food_hygiene: { status: "checked", checkedOn: "2024-01-10", updatedAt: "x" }, ni_number: { status: "checked", checkedOn: "2026-03-01", updatedAt: "x" } },
    checklist: {}, leave: [], reviews: [{ id: "rv1", kind: "annual", dueOn: "2026-12-05" }, { id: "rv2", kind: "one_to_one", dueOn: "2026-06-01", doneOn: "2026-06-01" }], probationEndsOn: "2026-11-30",
    profile: { skills: [{ name: "First aid", expiresOn: "2027-05-01" }] } as never, createdAt: "x", updatedAt: "x", ...over,
  });

  it("lists document end dates, reviews not yet held, skills that run out and a leaving date", () => {
    const out = staffDates(member({ endDate: "2027-01-15" }), "hospitality", TODAY);
    expect(out.map((d) => [d.id, d.date, d.title])).toEqual([
      ["staff:s1:doc:right_to_work", "2027-03-01", "Right-to-work check runs out"],
      ["staff:s1:doc:food_hygiene", "2027-01-10", "Food hygiene certificate (level 2) runs out"],
      ["staff:s1:review:rv1", "2026-12-05", "Yearly review due"],
      ["staff:s1:review:probation", "2026-11-30", "Probation review due"],
      ["staff:s1:skill:First aid", "2027-05-01", "First aid runs out"],
      ["staff:s1:leaving", "2027-01-15", "Last day at work"],
    ]);
    expect(out.every((d) => d.staffName === "Priya Shah")).toBe(true);
    expect(out[0]!.legal).toBe(true);
  });

  it("says a document ran out when its date has passed, and lists nothing for someone who has left", () => {
    const expired = staffDates(member({ jobTitle: "Shop assistant", rtwExpiresOn: "2026-11-01", reviews: [], probationEndsOn: undefined, profile: undefined }), "other", TODAY);
    expect(expired).toEqual([{ id: "staff:s1:doc:right_to_work", staffName: "Priya Shah", title: "Right-to-work check ran out", date: "2026-11-01", legal: true }]);
    expect(staffDates(member({ endDate: "2026-10-01" }), "hospitality", TODAY)).toEqual([]);
  });
});

describe("calendar: reminders for the client's own dates", () => {
  it("is due once inside the lead time and once on the day, and never twice", () => {
    const d = own({ date: "2026-11-20", remindDays: 7 });
    expect(dueReminders(d, "2026-11-12")).toEqual([]);
    expect(dueReminders(d, "2026-11-13")).toEqual([{ key: "2026-11-20:before", stage: "before", on: "2026-11-20", daysLeft: 7 }]);
    expect(dueReminders({ ...d, reminded: ["2026-11-20:before"] }, "2026-11-18")).toEqual([]);
    expect(dueReminders({ ...d, reminded: ["2026-11-20:before"] }, "2026-11-20")).toEqual([{ key: "2026-11-20:day", stage: "day", on: "2026-11-20", daysLeft: 0 }]);
    expect(dueReminders({ ...d, reminded: ["2026-11-20:before", "2026-11-20:day"] }, "2026-11-20")).toEqual([]);
  });

  it("does not remind about a date that is done, has passed, or asked for no early reminder", () => {
    expect(dueReminders(own({ date: "2026-11-20", doneThrough: "2026-11-20" }), "2026-11-19")).toEqual([]);
    expect(dueReminders(own({ date: "2026-11-10" }), TODAY)).toEqual([]);
    expect(dueReminders(own({ date: "2026-11-20", remindDays: 0 }), "2026-11-19")).toEqual([]);
    expect(dueReminders(own({ date: "2026-11-20", remindDays: 0 }), "2026-11-20").map((r) => r.stage)).toEqual(["day"]);
  });
});

// ------------------------------------------------------------------------------------------------ the client's own dates

async function dates(startAt = "2026-11-16T09:00:00Z") {
  const clock = { d: new Date(startAt) };
  const identity = new IdentityService(new AuditLog(), new EventBus());
  const ws = (await identity.createWorkspace("owner", { name: "Kestrel Coffee" })).id;
  identity.addMember("owner", ws, "admin", "admin");
  identity.addMember("owner", ws, "member", "member");
  const other = (await identity.createWorkspace("stranger", { name: "Other" })).id;
  const sent: { ws: string; title: string; body: string }[] = [];
  const saved: { id: string; data: any }[] = [];
  const svc = new OwnDatesService({
    identity, now: () => clock.d, timezone: () => "Europe/London",
    team: () => [{ key: "compliance-manager", title: "Compliance manager" }, { key: "finance-manager", title: "Finance manager" }],
    notify: (w, n) => { sent.push({ ws: w, ...n }); },
  });
  svc.useSink({ record: (_ws: string, kind: string, id: string, data: unknown) => { if (kind === "cal_date") saved.push({ id, data }); } } as never);
  return { svc, ws, other, clock, sent, saved, identity };
}

describe("the client's own dates", () => {
  it("adds a date with a title, repeat, note, reminder and who looks after it", async () => {
    const { svc, ws, saved } = await dates();
    const d = svc.add("owner", ws, { title: "  Renew  the\npremises licence ", date: "2027-03-01", repeat: "yearly", note: "Council ref 88", employee: "compliance-manager", remindDays: 14 });
    expect(d).toMatchObject({ workspaceId: ws, title: "Renew the premises licence", date: "2027-03-01", repeat: "yearly", note: "Council ref 88", employee: "compliance-manager", remindDays: 14, reminded: [], createdBy: "owner" });
    expect(svc.list("member", ws)).toEqual([d]);
    expect(saved.at(-1)).toEqual({ id: d.id, data: d });
    expect(svc.add("admin", ws, { title: "Pay rent", date: "2026-12-01" })).toMatchObject({ repeat: "none", remindDays: 7 });
  });

  it("refuses what is not a real date, a known repeat or one of the team", async () => {
    const { svc, ws } = await dates();
    const bad = (b: unknown, re: RegExp) => expect(() => svc.add("owner", ws, b)).toThrow(re);
    bad({ title: "", date: "2027-01-01" }, /what the date is for/);
    bad({ title: "x".repeat(121), date: "2027-01-01" }, /shorter/);
    bad({ title: "A", date: "2027-02-30" }, /real date/);
    bad({ title: "A", date: "31/01/2027" }, /real date/);
    bad({ title: "A", date: "1999-12-31" }, /between/);
    bad({ title: "A", date: "2027-01-01", repeat: "weekly" }, /repeat/);
    bad({ title: "A", date: "2027-01-01", employee: "admin-manager" }, /on your team/);
    bad({ title: "A", date: "2027-01-01", remindDays: 5 }, /reminder/);
    bad({ title: "A", date: "2027-01-01", note: "n".repeat(501) }, /note/);
    bad("nope", /not valid/);
    expect(() => svc.add("owner", ws, { title: "A", date: "2027-01-01" })).not.toThrow();
  });

  it("lets only the owner and admins change the calendar, and nobody from another business", async () => {
    const { svc, ws, other } = await dates();
    const d = svc.add("owner", ws, { title: "Insurance", date: "2027-01-01" });
    expect(() => svc.add("member", ws, { title: "x", date: "2027-01-01" })).toThrow(PermissionError);
    expect(() => svc.update("member", ws, d.id, { title: "x" })).toThrow(PermissionError);
    expect(() => svc.remove("member", ws, d.id)).toThrow(PermissionError);
    expect(() => svc.list("stranger", ws)).toThrow(PermissionError);
    // The same id from another business looks exactly like one that does not exist.
    expect(() => svc.update("stranger", other, d.id, { title: "mine now" })).toThrow(/not on your calendar/);
    expect(() => svc.remove("stranger", other, d.id)).toThrow(/not on your calendar/);
    expect(svc.list("owner", ws)[0]!.title).toBe("Insurance");
  });

  it("changes, ticks off and removes a date", async () => {
    const { svc, ws, saved } = await dates();
    const d = svc.add("owner", ws, { title: "VAT return", date: "2026-11-20", repeat: "quarterly", employee: "finance-manager" });
    const changed = svc.update("admin", ws, d.id, { title: "VAT return and payment", employee: "", note: "Online" });
    expect(changed).toMatchObject({ title: "VAT return and payment", date: "2026-11-20", repeat: "quarterly", note: "Online" });
    expect(changed.employee).toBeUndefined();
    expect(svc.setDone("owner", ws, d.id, true).doneThrough).toBe("2026-11-20");
    expect(currentOccurrence(svc.list("owner", ws)[0]!, TODAY).on).toBe("2027-02-20");
    expect(svc.setDone("owner", ws, d.id, false).doneThrough).toBeUndefined();
    // Moving the date starts it afresh: an old tick or reminder belongs to the old date.
    svc.setDone("owner", ws, d.id, true);
    expect(svc.update("owner", ws, d.id, { date: "2026-12-01" })).toMatchObject({ date: "2026-12-01", reminded: [] });
    expect(svc.list("owner", ws)[0]!.doneThrough).toBeUndefined();
    svc.remove("owner", ws, d.id);
    expect(svc.list("owner", ws)).toEqual([]);
    expect(saved.at(-1)).toEqual({ id: d.id, data: { removed: true } });
    expect(() => svc.remove("owner", ws, d.id)).toThrow(OverviewError);
  });

  it("stops at a sensible number of dates", async () => {
    const { svc, ws } = await dates();
    for (let i = 0; i < MAX_OWN_DATES; i++) svc.add("owner", ws, { title: `Date ${i}`, date: "2027-01-01" });
    expect(() => svc.add("owner", ws, { title: "One more", date: "2027-01-01" })).toThrow(/remove some/);
  });

  it("rings the bell before the date and on the day, by day in the client's own time, once each", async () => {
    const { svc, ws, clock, sent } = await dates("2026-11-16T09:00:00Z");
    svc.add("owner", ws, { title: "Renew the insurance", date: "2026-11-25", employee: "compliance-manager", remindDays: 7 });
    svc.tick();
    expect(sent).toEqual([]); // nine days away
    clock.d = new Date("2026-11-18T03:00:00Z");
    svc.tick();
    expect(sent).toEqual([]); // inside the week, but it is three in the morning there
    clock.d = new Date("2026-11-18T08:05:00Z");
    svc.tick(); svc.tick();
    expect(sent).toEqual([{ ws, title: "In 7 days: Renew the insurance", body: "It is due on 25 Nov 2026. Your Compliance manager knows about it. Open your calendar to see it or tick it off." }]);
    clock.d = new Date("2026-11-24T10:00:00Z");
    svc.tick();
    expect(sent).toHaveLength(1);
    clock.d = new Date("2026-11-25T08:00:00Z");
    svc.tick(); svc.tick();
    expect(sent.map((s) => s.title)).toEqual(["In 7 days: Renew the insurance", "Today: Renew the insurance"]);
  });

  it("does not remind again after a restart, and carries on with the next repeat", async () => {
    const first = await dates("2026-11-19T10:00:00Z");
    const d = first.svc.add("owner", first.ws, { title: "Pay the rent", date: "2026-11-20", repeat: "monthly", remindDays: 1 });
    first.svc.tick();
    expect(first.sent.map((s) => s.title)).toEqual(["Tomorrow: Pay the rent"]);
    const stored = first.saved.at(-1)!.data as OwnDate;
    expect(stored.reminded).toEqual(["2026-11-20:before"]);

    const again = await dates("2026-11-19T11:00:00Z");
    again.svc.restore({ ...stored, workspaceId: again.ws });
    again.svc.restore({ removed: true });
    again.svc.tick();
    expect(again.sent).toEqual([]);
    again.svc.setDone("owner", again.ws, d.id, true);
    again.clock.d = new Date("2026-12-19T10:00:00Z");
    again.svc.tick();
    expect(again.sent.map((s) => s.title)).toEqual(["Tomorrow: Pay the rent"]);
  });

  it("tells the employee who looks after a date, and the Compliance manager about all of them, without the notes", async () => {
    const { svc, ws } = await dates();
    expect(svc.contextFor(ws, "finance-manager")).toBeUndefined();
    svc.add("owner", ws, { title: "VAT return", date: "2027-01-31", repeat: "quarterly", employee: "finance-manager", note: "secret note" });
    svc.add("owner", ws, { title: "Premises licence", date: "2027-03-01" });
    const fin = svc.contextFor(ws, "finance-manager")!;
    expect(fin).toMatch(/2027-01-31: VAT return \(repeats every 3 months\)/);
    expect(fin).not.toMatch(/Premises licence|secret note/);
    expect(svc.contextFor(ws, "compliance-manager")).toMatch(/VAT return[\s\S]*Premises licence/);
    expect(svc.contextFor(ws, "marketing-manager")).toBeUndefined();
  });
});
