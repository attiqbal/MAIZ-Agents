// The Approvals screen: one list of everything that is really waiting for this client, whichever part of the
// product it came from. A pure function over plain data, so every rule is tested without a server.
// Each item either carries the calls that decide it (the existing endpoint for that kind of thing) or a link to
// the screen that holds its form. Nothing here is an example: an empty list means nothing is waiting.
import { humanDate } from "../people/rules.js";

export type ApprovalKind = "agent_job" | "social_post" | "leave_request" | "review_answers" | "specialist_hire" | "books_pending" | "setup";

/** One button. `path` is an existing endpoint without the "/api" prefix; `body` is sent as JSON with a POST. */
export interface ApprovalAction { key: "approve" | "refuse"; label: string; path: string; body: Record<string, unknown> }

export interface ApprovalItem {
  /** "<kind>:<reference>", stable while the thing is waiting. */
  id: string;
  kind: ApprovalKind;
  /** The part of the product it came from, in the words the menu uses. */
  source: string;
  /** Who is asking. */
  who: string;
  title: string;
  detail?: string;
  /** What it costs, in words. Left out when it costs nothing we can state. */
  cost?: string;
  why?: string;
  energy?: number;
  monthlyGbp?: number;
  /** When it started waiting. */
  at?: string;
  /** When it stops waiting by itself, or when the thing it is about happens. */
  dueAt?: string;
  actions: ApprovalAction[];
  /** Decided on another screen: where. */
  link?: { label: string; href: string };
  /** Why this person sees it but cannot decide it. */
  blocked?: string;
}

export interface ApprovalSources {
  agentJobs: readonly { id: string; connectionName: string; employeeTitle: string; brief: string; estimate: number; reason: string | null; createdAt: string }[];
  canManageTools: boolean;
  posts: readonly { id: string; kind: "facebook" | "instagram"; account?: string; text: string; createdAt: string; scheduledFor?: string }[];
  canDecidePosts: boolean;
  leave: readonly { staffId: string; staffName: string; leaveId: string; kind: "holiday" | "sick" | "other"; from: string; to: string; days: number }[];
  reviews: readonly { id: string; title: string; employee: string; energy: number; questions: readonly string[]; updatedAt: string }[];
  specialists: readonly { id: string; title: string; priceGbp: number; approvedAt: string }[];
  pendingFigures?: { count: number; payRuns?: number; apps: readonly string[]; from: string; to: string; since?: string };
  setup?: { since?: string };
}

/** A job from the client's own tool closes by itself after this many days (the agents module's own rule). */
export const JOB_WAITS_DAYS = 7;
/** Anything due within this many hours goes to the top of the list. */
export const URGENT_HOURS = 72;
export const DETAIL_MAX = 400;

const DAY_MS = 86_400_000;
const OWNER_ONLY = "Only the owner of this business can decide this.";
const OWNER_OR_ADMIN = "Only the owner or an admin can decide this.";

const clip = (t: string, n = DETAIL_MAX): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const listOf = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const JOB_WHY: Record<string, string> = {
  needs_approval: "You asked to approve every job from this tool before it runs.",
  over_job_limit: "It may use more energy than the limit you set for one job from this tool.",
};

function jobItems(s: ApprovalSources): ApprovalItem[] {
  return s.agentJobs.map((j) => {
    const due = Date.parse(j.createdAt) + JOB_WAITS_DAYS * DAY_MS;
    const why = JOB_WHY[j.reason ?? ""];
    return {
      id: `agent_job:${j.id}`, kind: "agent_job" as const, source: "Your own AI tools", who: j.connectionName, title: `Job for your ${j.employeeTitle}`,
      detail: clip(j.brief), cost: `May use about ${j.estimate} energy`, ...(why ? { why } : {}), energy: j.estimate, at: j.createdAt,
      ...(Number.isFinite(due) ? { dueAt: new Date(due).toISOString() } : {}),
      actions: s.canManageTools
        ? [{ key: "approve" as const, label: "Let it run", path: `/agents/jobs/${j.id}/approve`, body: {} }, { key: "refuse" as const, label: "Refuse", path: `/agents/jobs/${j.id}/refuse`, body: {} }]
        : [],
      ...(s.canManageTools ? {} : { blocked: OWNER_ONLY }),
    };
  });
}

function postItems(s: ApprovalSources): ApprovalItem[] {
  return s.posts.map((p) => {
    const where = p.kind === "instagram" ? "Instagram" : "Facebook";
    return {
      id: `social_post:${p.id}`, kind: "social_post" as const, source: "Social accounts", who: "Someone on your team",
      title: p.account ? `Post to ${where}: ${p.account}` : `Post to ${where}`, detail: clip(p.text), cost: "Uses no energy", at: p.createdAt,
      ...(p.scheduledFor ? { dueAt: p.scheduledFor, why: "It goes out at the time that was picked, once you approve it." } : {}),
      actions: s.canDecidePosts
        ? [{ key: "approve" as const, label: p.scheduledFor ? "Approve and schedule" : "Approve and post now", path: `/meta/posts/${p.id}/approve`, body: {} }, { key: "refuse" as const, label: "Do not post", path: `/meta/posts/${p.id}/reject`, body: {} }]
        : [],
      ...(s.canDecidePosts ? {} : { blocked: OWNER_OR_ADMIN }),
    };
  });
}

const LEAVE_NAME: Record<string, string> = { holiday: "Holiday request", sick: "Sick leave", other: "Leave request" };

function leaveItems(s: ApprovalSources): ApprovalItem[] {
  return s.leave.map((l) => ({
    id: `leave_request:${l.staffId}:${l.leaveId}`, kind: "leave_request" as const, source: "Staff records", who: l.staffName,
    title: `${LEAVE_NAME[l.kind] ?? LEAVE_NAME.other}: ${plural(l.days, "day", "days")}`, detail: `${humanDate(l.from)} to ${humanDate(l.to)}`, dueAt: `${l.from}T00:00:00.000Z`,
    actions: [
      { key: "approve" as const, label: "Approve", path: `/people/${l.staffId}/leave/${l.leaveId}/decide`, body: { approve: true } },
      { key: "refuse" as const, label: "Decline", path: `/people/${l.staffId}/leave/${l.leaveId}/decide`, body: { approve: false } },
    ],
  }));
}

function elsewhereItems(s: ApprovalSources): ApprovalItem[] {
  const out: ApprovalItem[] = [];
  for (const r of s.reviews) {
    out.push({
      id: `review_answers:${r.id}`, kind: "review_answers", source: "Tasks", who: `Your ${r.employee}`, title: `Answers needed: ${r.title}`,
      ...(r.questions.length ? { detail: clip(`${plural(r.questions.length, "question", "questions")}: ${r.questions.join("; ")}`) } : {}),
      cost: `The work will use about ${r.energy} energy once it starts`, energy: r.energy, at: r.updatedAt, actions: [], link: { label: "Answer on Tasks", href: "#work" },
    });
  }
  for (const sp of s.specialists) {
    out.push({
      id: `specialist_hire:${sp.id}`, kind: "specialist_hire", source: "Team", who: "MAIZ quality review", title: `Ready to hire: ${sp.title}`,
      detail: "This employee was designed for you and has passed our review. Nothing is charged unless you hire.", cost: `£${sp.priceGbp} a month if you hire`, monthlyGbp: sp.priceGbp,
      at: sp.approvedAt, actions: [], link: { label: "Decide on Team", href: "#team" },
    });
  }
  return out;
}

function figuresItem(f: NonNullable<ApprovalSources["pendingFigures"]>): ApprovalItem {
  const parts = [...(f.count ? [`${plural(f.count, "day", "days")} of figures`] : []), ...(f.payRuns ? [plural(f.payRuns, "pay run", "pay runs")] : [])];
  const several = f.count + (f.payRuns ?? 0) !== 1;
  return {
    id: "books_pending:all", kind: "books_pending", source: "Apps and connections", who: listOf(f.apps) || "Your connected apps",
    title: `${listOf(parts)} ${several ? "are" : "is"} waiting to go into your books`, detail: f.from === f.to ? humanDate(f.from) : `${humanDate(f.from)} to ${humanDate(f.to)}`,
    why: "Figures from your apps go into your books only when you say so.", ...(f.since ? { at: f.since } : {}), actions: [], link: { label: "Open Apps and connections", href: "#apps" },
  };
}

function setupItem(since?: string): ApprovalItem {
  return {
    id: "setup:first_day", kind: "setup", source: "Getting started", who: "Your Admin manager", title: "Your team is waiting to meet you",
    detail: "Answer a few questions about your business so every employee knows what to do.", ...(since ? { at: since } : {}), actions: [], link: { label: "Start your first day", href: "#firstday" },
  };
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** What runs out soonest first, then the newest; things with no start time last. */
function ordered(items: ApprovalItem[], now: Date): ApprovalItem[] {
  const limit = now.getTime() + URGENT_HOURS * 3_600_000;
  const urgent = (i: ApprovalItem): boolean => time(i.dueAt) <= limit;
  const byDue = (a: ApprovalItem, b: ApprovalItem): number => time(a.dueAt) - time(b.dueAt);
  const first = items.filter(urgent).sort(byDue);
  const rest = items.filter((i) => !urgent(i));
  const dated = rest.filter((i) => i.at).sort((a, b) => time(b.at) - time(a.at));
  const undated = rest.filter((i) => !i.at).sort((a, b) => (Number.isNaN(byDue(a, b)) ? 0 : byDue(a, b)));
  return [...first, ...dated, ...undated];
}

export function buildApprovals(s: ApprovalSources, now: Date): ApprovalItem[] {
  const items = [
    ...jobItems(s), ...postItems(s), ...leaveItems(s), ...elsewhereItems(s),
    ...(s.pendingFigures && s.pendingFigures.count + (s.pendingFigures.payRuns ?? 0) > 0 ? [figuresItem(s.pendingFigures)] : []),
    ...(s.setup ? [setupItem(s.setup.since)] : []),
  ];
  return ordered(items, now);
}

export interface ApprovalSummary { total: number; decideHere: number; elsewhere: number }

/** The numbers the sidebar badge and the "Needs you" tile show. They count the same list the screen draws. */
export function summarise(items: readonly ApprovalItem[]): ApprovalSummary {
  const decideHere = items.filter((i) => i.actions.length > 0).length;
  return { total: items.length, decideHere, elsewhere: items.length - decideHere };
}
