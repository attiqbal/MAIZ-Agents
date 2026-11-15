import type { ActivityArea, ActivityDay, Capability } from "./types.js";

/**
 * The customer-facing areas an app can report on, and what each figure is called. Connectors fill `figures`
 * with plain numbers; this table is the only place that knows the names, so the Zapier/Make link, the
 * employees' instructions and the Apps screen all agree. A figure not listed here is dropped, which also means
 * nothing a customer typed (a ticket subject, an email) can ever reach an employee.
 */
export type FigureKind = "count" | "money" | "rating" | "percent";
export interface FigureDef { key: string; label: string; kind: FigureKind; /** "level" figures are a snapshot (open deals now), not a total for the day. */ level?: boolean }
export interface AreaDef { area: ActivityArea; title: string; capability: Capability; employees: readonly string[]; figures: readonly FigureDef[] }

export const AREAS: Record<ActivityArea, AreaDef> = {
  crm: {
    area: "crm", title: "Leads and deals", capability: "crm.read", employees: ["marketing-manager", "business-consultant"],
    figures: [
      { key: "newContacts", label: "new contacts", kind: "count" },
      { key: "dealsWon", label: "deals won", kind: "count" },
      { key: "dealsLost", label: "deals lost", kind: "count" },
      { key: "wonValue", label: "value won", kind: "money" },
      { key: "openDeals", label: "open deals", kind: "count", level: true },
      { key: "pipelineValue", label: "open pipeline value", kind: "money", level: true },
    ],
  },
  support: {
    area: "support", title: "Customer support", capability: "support.read", employees: ["business-consultant", "marketing-manager"],
    figures: [
      { key: "opened", label: "tickets opened", kind: "count" },
      { key: "solved", label: "tickets solved", kind: "count" },
      { key: "waiting", label: "tickets waiting for a reply", kind: "count", level: true },
      { key: "open", label: "tickets open", kind: "count", level: true },
    ],
  },
  inbox: {
    area: "inbox", title: "Email inbox", capability: "inbox.read", employees: ["business-consultant"],
    figures: [
      { key: "received", label: "emails received", kind: "count" },
      { key: "unread", label: "unread emails", kind: "count", level: true },
    ],
  },
  bookings: {
    area: "bookings", title: "Bookings and appointments", capability: "bookings.read", employees: ["business-consultant", "marketing-manager"],
    figures: [
      { key: "booked", label: "bookings made", kind: "count" },
      { key: "cancelled", label: "bookings cancelled", kind: "count" },
      { key: "upcoming", label: "upcoming bookings", kind: "count", level: true },
    ],
  },
  audience: {
    area: "audience", title: "Email list and campaigns", capability: "audience.read", employees: ["marketing-manager", "business-consultant"],
    figures: [
      { key: "subscribers", label: "subscribers", kind: "count", level: true },
      { key: "newSubscribers", label: "new subscribers", kind: "count" },
      { key: "campaignsSent", label: "campaigns sent", kind: "count" },
      { key: "openRate", label: "average open rate", kind: "percent" },
      { key: "clickRate", label: "average click rate", kind: "percent" },
    ],
  },
  tasks: {
    area: "tasks", title: "Tasks and projects", capability: "tasks.read", employees: ["business-consultant", "supply-chain-manager"],
    figures: [
      { key: "open", label: "open tasks", kind: "count", level: true },
      { key: "overdue", label: "overdue tasks", kind: "count", level: true },
      { key: "completed", label: "tasks completed", kind: "count" },
    ],
  },
  reviews: {
    area: "reviews", title: "Customer reviews", capability: "reviews.read", employees: ["marketing-manager", "business-consultant"],
    figures: [
      { key: "newReviews", label: "new reviews", kind: "count" },
      { key: "averageRating", label: "average rating (out of 5)", kind: "rating" },
      { key: "totalReviews", label: "reviews in total", kind: "count", level: true },
    ],
  },
};

export const isArea = (v: unknown): v is ActivityArea => typeof v === "string" && Object.prototype.hasOwnProperty.call(AREAS, v);

const MAX_FIGURE = 1e12;

/** Keeps only the figures the area knows, as finite non-negative numbers. Ratings and percents keep two decimals. */
export function cleanFigures(area: ActivityArea, raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const f of AREAS[area].figures) {
    const v = (raw as Record<string, unknown>)[f.key];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n) || n < 0 || n > MAX_FIGURE) continue;
    out[f.key] = f.kind === "rating" || f.kind === "percent" ? Math.round(n * 100) / 100 : Math.round(n);
  }
  return out;
}

/** Text for one figure, e.g. "12 new contacts", "3,500.00 GBP value won". */
export function describeFigure(f: FigureDef, value: number, currency: string): string {
  const v = f.kind === "money" ? `${(value / 100).toFixed(2)} ${currency}` : f.kind === "percent" ? `${value}%` : f.kind === "rating" ? value.toFixed(1) : String(value);
  return `${v} ${f.label}`;
}

/**
 * A plain-words line for one area from its recent days: totals for flow figures over the last 30 days, the newest
 * value for snapshot figures. Used for the employees' instructions and the Apps screen.
 */
export function summariseArea(app: string, days: readonly ActivityDay[], today: string): string | undefined {
  if (!days.length) return undefined;
  const area = AREAS[days[0]!.area];
  const since = new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10);
  const recent = days.filter((d) => d.date >= since).sort((a, b) => a.date.localeCompare(b.date));
  const newest = days.slice().sort((a, b) => b.date.localeCompare(a.date))[0]!;
  const parts: string[] = [];
  for (const f of area.figures) {
    if (f.level) {
      const v = newest.figures[f.key];
      if (v !== undefined) parts.push(describeFigure(f, v, newest.currency));
    } else if (f.kind === "count" || f.kind === "money") {
      const vals = recent.map((d) => d.figures[f.key]).filter((x): x is number => x !== undefined);
      if (vals.length) parts.push(describeFigure(f, vals.reduce((a, b) => a + b, 0), newest.currency));
    } else {
      // Rates and ratings are averages: take the newest day's figure.
      const v = recent.map((d) => d.figures[f.key]).filter((x): x is number => x !== undefined).at(-1);
      if (v !== undefined) parts.push(describeFigure(f, v, newest.currency));
    }
  }
  return parts.length ? `${area.title} in ${app}, last 30 days to ${newest.date}: ${parts.join(", ")}` : undefined;
}
