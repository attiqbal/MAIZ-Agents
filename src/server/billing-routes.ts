import { PaymentError } from "../modules/payments/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });
const ID = /^[\w:-]{1,64}$/;

/**
 * Plan and billing for the signed-in client (docs/ONE-BILL.md): every monthly line they pay for, stopping one extra
 * at the end of the month already paid for, and what adding a cart to their monthly bill would do before they confirm.
 * Membership and the right to buy are checked in the payment service; ids from the browser are only ever looked up
 * inside the caller's own workspace.
 */
export async function billingRoute(req: Req, userId: string, p: Platform, workspaceId: string | undefined, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (path !== "/api/billing/lines" && path !== "/api/billing/lines/stop" && path !== "/api/billing/preview") return undefined;
  if (!workspaceId) return json(404, { error: "no organisation yet" });
  if (method === "GET" && path === "/api/billing/lines") {
    // Anything whose paid month has just ended leaves before the list is drawn, so the page never shows it as still there.
    await p.payments.sweep();
    return json(200, { enabled: p.payments.enabled, ...p.payments.lines(userId, workspaceId) });
  }
  if (method === "POST" && path === "/api/billing/lines/stop") {
    const b = body();
    if (typeof b.orderId !== "string" || !ID.test(b.orderId) || typeof b.key !== "string" || !ID.test(b.key)) throw new PaymentError("say which monthly line to stop");
    await p.payments.stopLine(userId, workspaceId, b.orderId, b.key);
    return json(200, { enabled: p.payments.enabled, ...p.payments.lines(userId, workspaceId) });
  }
  if (method === "POST" && path === "/api/billing/preview") {
    const lines = body().lines;
    if (!Array.isArray(lines) || lines.length > 100) throw new PaymentError("lines must be a list of up to 100 items");
    return json(200, await p.payments.previewBill(userId, workspaceId, lines));
  }
  return json(404, { error: "not found" });
}
