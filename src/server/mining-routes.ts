import { DatasetNotFound, MiningError, viewOf } from "../modules/data-mining/index.js";
import { miningChatRoute } from "./mining-chat.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });
const DATASET = /^\/api\/mining\/datasets\/([\w-]{1,64})(?:\/(share|remove|watch))?$/;

/**
 * The Data mining agent's page: what can be gathered and what it uses in energy, the client's saved datasets, running
 * a new one (the cost is shown first and must be confirmed), sharing one with other employees and removing one.
 * Everything is the signed-in person's own workspace; permissions are checked in the service (reading needs
 * `task.read`; running, sharing and removing need `task.create`).
 */
export async function miningRoute(req: Req, userId: string, p: Platform, workspaceId: string | undefined, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (path !== "/api/mining" && !path.startsWith("/api/mining/")) return undefined;
  if (!workspaceId) return json(404, { error: "no organisation yet" });
  if (method === "GET" && path === "/api/mining") return json(200, p.mining.overview(userId, workspaceId));
  if (method === "POST" && path === "/api/mining/run") {
    try {
      const dataset = await p.mining.run(userId, workspaceId, body());
      return json(201, { dataset: viewOf(dataset), team: p.energy.teamEnergyOf(workspaceId) ?? null });
    } catch (e) {
      // Not confirmed yet: 409 with the quote, so the screen can show the cost and ask (the same signal paid services use).
      if (e instanceof MiningError && e.quote) return json(409, { error: e.message, quote: e.quote });
      throw e;
    }
  }
  // A search offered in a conversation: "Confirm and start" and "Not now".
  if (path.startsWith("/api/mining/chat/")) return miningChatRoute(req, userId, p, workspaceId);
  const one = DATASET.exec(path);
  if (!one) return json(404, { error: "not found" });
  const [, id, action] = one;
  try {
    if (method === "GET" && !action) return json(200, { dataset: viewOf(p.mining.get(userId, workspaceId, id!)) });
    if (method === "POST" && action === "share") return json(200, { dataset: viewOf(p.mining.share(userId, workspaceId, id!, body().employees)) });
    if (method === "POST" && action === "remove") {
      p.mining.remove(userId, workspaceId, id!);
      return json(200, { removed: true, datasets: p.mining.list(userId, workspaceId) });
    }
    // The weekly check: switching it on is refused with what a week uses at most until that figure is confirmed.
    if (method === "POST" && action === "watch") return json(200, { dataset: viewOf(p.mining.watch(userId, workspaceId, id!, body())) });
  } catch (e) {
    if (e instanceof DatasetNotFound) return json(404, { error: e.message });
    if (e instanceof MiningError && e.quote) return json(409, { error: e.message, quote: e.quote });
    throw e;
  }
  return json(404, { error: "not found" });
}
