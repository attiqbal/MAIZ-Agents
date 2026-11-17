import { BOOKS_PERIODS, OverviewError } from "../modules/overview/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });
const BASE = "/api/overview";
const ID = "[\\w-]{1,64}";
const ONE_DATE = new RegExp(`^${BASE}/calendar/dates/(${ID})(?:/(done|remove))?$`);
const DEFAULT_DAYS = 30;

/** The period the Books screen asked for: one of the three it offers, or nothing when it is anything else. */
function periodOf(raw: string | null): number | undefined {
  if (raw === null || raw === "") return DEFAULT_DAYS;
  const days = Number(raw);
  return (BOOKS_PERIODS as readonly number[]).includes(days) ? days : undefined;
}

function failure(e: unknown): Res {
  if (e instanceof OverviewError) return json(e.notFound ? 404 : 400, { error: e.message });
  throw e;
}

/**
 * The client's Approvals, Books and cash and Compliance calendar screens (docs/OVERVIEW-DATA.md). Everything is read
 * as the signed-in person and for their own business only: the business comes from the session, never from the
 * request. Reading needs `task.read`; changing the calendar's own dates needs `approval.decide` (owner and admins).
 * Deciding an approval is not done here: each item carries the existing endpoint for its kind, with its own checks.
 */
export function overviewRoute(req: Req, userId: string, p: Platform, ws: string, body: () => Record<string, unknown>): Res | undefined {
  const { method, path } = req;
  if (!path.startsWith(`${BASE}/`)) return undefined;
  try {
    if (method === "GET" && path === `${BASE}/approvals`) return json(200, p.overview.approvals(userId, ws));
    if (method === "GET" && path === `${BASE}/books`) {
      const days = periodOf(req.query.get("days"));
      if (days === undefined) return json(400, { error: "Choose 7, 30 or 90 days." });
      return json(200, p.overview.books(userId, ws, days));
    }
    if (method === "GET" && path === `${BASE}/calendar`) return json(200, p.overview.calendar(userId, ws));
    if (method === "POST" && path === `${BASE}/calendar/dates`) return json(201, { date: p.overview.dates.add(userId, ws, body()) });
    const one = method === "POST" ? ONE_DATE.exec(path) : null;
    if (one) return changeDate(p, userId, ws, one[1]!, one[2], body());
    // An id too long or oddly shaped to be one of ours gets the same answer as one that does not exist.
    if (method === "POST" && path.startsWith(`${BASE}/calendar/dates/`)) return json(404, { error: "That date is not on your calendar." });
    return json(404, { error: "not found" });
  } catch (e) {
    return failure(e);
  }
}

function changeDate(p: Platform, userId: string, ws: string, id: string, action: string | undefined, b: Record<string, unknown>): Res {
  if (action === "remove") {
    p.overview.dates.remove(userId, ws, id);
    return json(200, { removed: true });
  }
  if (action === "done") {
    // Checked before the date is looked up only for its type: who may change it is decided in the service.
    if (typeof b.done !== "boolean") {
      p.identity.require(userId, ws, "approval.decide");
      return json(400, { error: "Say whether it is done or not." });
    }
    return json(200, { date: p.overview.dates.setDone(userId, ws, id, b.done) });
  }
  return json(200, { date: p.overview.dates.update(userId, ws, id, b) });
}
