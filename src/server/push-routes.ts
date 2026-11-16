import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });

/**
 * Push notifications for the signed-in person: the key their browser subscribes with, subscribing, unsubscribing and
 * a test message. A client's subscription belongs to their workspace (so the whole team's bell reaches it); the
 * platform owner's has no workspace and carries decisions waiting.
 */
export async function pushRoute(req: Req, userId: string, p: Platform, workspaceId: string | undefined, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (path !== "/api/push" && !path.startsWith("/api/push/")) return undefined;
  if (!workspaceId && !p.isPlatformOwner(userId)) return json(404, { error: "no organisation yet" });
  if (method === "GET" && path === "/api/push") return json(200, { publicKey: p.push.publicKey(), subscribed: p.push.count(userId) });
  if (method === "POST" && path === "/api/push/subscribe") {
    p.push.subscribe(userId, workspaceId, body().subscription);
    return json(201, { subscribed: p.push.count(userId) });
  }
  if (method === "POST" && path === "/api/push/unsubscribe") {
    const removed = p.push.unsubscribe(userId, body().endpoint);
    return json(200, { removed, subscribed: p.push.count(userId) });
  }
  if (method === "POST" && path === "/api/push/test") {
    const sent = await p.push.sendToUser(userId, { title: "Notifications are on", body: "This is how MAIZ Agents will tell you when work is ready.", link: workspaceId ? "/app.html" : "/owner-decisions.html", tag: "test" });
    return json(200, { sent });
  }
  return json(404, { error: "not found" });
}
