import { PermissionError } from "../modules/identity/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });
const EMPLOYEE = /^\/api\/resources\/employee\/([a-z0-9-]{2,40})$/;

/**
 * What an employee can use (docs/RESOURCES.md). Read only.
 * - `GET /api/resources/employee/<template key>`: the signed-in client's list for one of their own employees: what it
 *   can use now with the cost, what is missing with where to connect it, and what MAIZ is still switching on.
 * - `GET /api/owner/resources`: the platform owner's table of what the employees used this month and what it cost.
 * The registry reads only the signed-in person's own workspace, and an employee who is not on that team looks like one
 * that does not exist.
 */
export function resourcesRoute(req: Req, userId: string, p: Platform, workspaceId: string | undefined): Res | undefined {
  const { method, path } = req;
  if (method !== "GET") return undefined;
  if (path === "/api/owner/resources") {
    try { return json(200, p.resourceUsage(userId)); } catch (e) {
      if (e instanceof PermissionError) return json(403, { error: "only the MAIZ platform owner can see this" });
      throw e;
    }
  }
  const one = EMPLOYEE.exec(path);
  if (!one) return undefined;
  if (!workspaceId) return json(404, { error: "no organisation yet" });
  try {
    return json(200, p.resourcesFor(userId, workspaceId, one[1]!));
  } catch (e) {
    if (e instanceof PermissionError) return json(403, { error: "you don't have permission to do that" });
    if (e instanceof Error && e.message === "employee not found") return json(404, { error: "that employee was not found" });
    throw e;
  }
}
