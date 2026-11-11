import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { Quote } from "../store/cart.js";
import { WebhookSignatureError, type CheckoutLine, type PaymentProvider } from "./types.js";

export class PaymentError extends Error {}

export type OrderStatus = "pending" | "paid" | "failed" | "cancelled";

export interface Order {
  id: string;
  workspaceId: string;
  userId: string;
  lines: CheckoutLine[];
  monthlyMinor: number;
  dueTodayMinor: number;
  currency: "GBP";
  status: OrderStatus;
  provider: string;
  providerRef?: string;
  createdAt: string;
  paidAt?: string;
  /** Employees hired because this order was paid. Set once, so a replayed webhook never hires twice. */
  fulfilledAt?: string;
  employeeIds: string[];
  /** Why it failed or could not be fulfilled, in words for the platform owner. */
  problem?: string;
}

export interface PaymentDeps {
  provider?: PaymentProvider;
  /** Prices a cart from the live price book. The client never supplies a price. */
  quote: (lines: readonly unknown[]) => Quote;
  /** Hires what an order bought. Throws if it cannot. */
  fulfil: (order: Order) => Promise<string[]>;
  /** Public address for return links. */
  appUrl: string;
  customerEmail: (userId: string) => string | undefined;
  now: () => Date;
  /** Told when a paid order could not be fulfilled, so a person can fix it. */
  alert?: (subject: string, text: string) => Promise<void>;
}

export const MAX_PENDING_ORDERS = 20;
const pence = (gbp: number) => Math.round(gbp * 100);

/**
 * Turns a cart into an order and a provider checkout, and fulfils the order when the provider confirms payment.
 * With no provider configured, checkout is refused (no charging is switched on). Orders are stored with the client.
 */
export class PaymentService {
  private orders = new Map<string, Order>();
  private sink?: Sink;
  /** Orders being fulfilled right now, so two webhooks racing cannot hire twice. */
  private fulfilling = new Set<string>();

  constructor(private identity: IdentityService, private audit: AuditLog, private d: PaymentDeps) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(o: Order): void { this.orders.set(o.id, o); }
  get enabled(): boolean { return !!this.d.provider; }
  get providerName(): string | undefined { return this.d.provider?.name; }

  async checkout(userId: string, workspaceId: string, rawLines: unknown): Promise<{ order: Order; url?: string }> {
    this.identity.require(userId, workspaceId, "employee.hire");
    const provider = this.d.provider;
    if (!provider) throw new PaymentError("payments are not switched on yet, so nothing can be bought");
    if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > 100) throw new PaymentError("your cart is empty");
    const q = this.d.quote(rawLines);
    if (q.rejected.length) throw new PaymentError(`some items cannot be bought: ${q.rejected.map((r) => `${r.key || "unknown"} (${r.reason})`).join(", ")}`);
    if (!q.lines.length) throw new PaymentError("your cart is empty");
    const pending = [...this.orders.values()].filter((o) => o.workspaceId === workspaceId && o.status === "pending").length;
    if (pending >= MAX_PENDING_ORDERS) throw new PaymentError("you have too many unpaid orders; finish or wait for them first");

    const lines: CheckoutLine[] = q.lines.map((l) => ({ key: l.key, title: l.title, qty: l.qty, unitMinor: pence(l.unitGbp), billing: l.billing }));
    const monthlyMinor = lines.filter((l) => l.billing === "monthly").reduce((n, l) => n + l.unitMinor * l.qty, 0);
    const onceMinor = lines.filter((l) => l.billing === "once").reduce((n, l) => n + l.unitMinor * l.qty, 0);
    const order: Order = {
      id: newId("order"), workspaceId, userId, lines, monthlyMinor, dueTodayMinor: monthlyMinor + onceMinor, currency: "GBP",
      status: "pending", provider: provider.name, createdAt: this.d.now().toISOString(), employeeIds: [],
    };
    this.save(order);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "order.created", target: `order:${order.id}`, data: { dueTodayMinor: order.dueTodayMinor, monthlyMinor } });
    const base = this.d.appUrl.replace(/\/$/, "");
    const session = await provider.createCheckout({
      orderId: order.id, workspaceId, customerEmail: this.d.customerEmail(userId), currency: "GBP", lines,
      dueTodayMinor: order.dueTodayMinor, monthlyMinor, successUrl: `${base}/app.html?order=${order.id}#team`, cancelUrl: `${base}/pricing.html?cancelled=1`,
    }).catch((e) => { this.save({ ...order, status: "failed", problem: "the payment provider could not start the payment" }); throw e; });
    this.save({ ...this.orders.get(order.id)!, providerRef: session.providerRef });
    if (session.status === "paid") await this.markPaid(order.id);
    else if (session.status === "failed") this.markFailed(order.id, "the payment was declined");
    return { order: this.orders.get(order.id)!, ...(session.url ? { url: session.url } : {}) };
  }

  mine(userId: string, workspaceId: string): Order[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.orders.values()].filter((o) => o.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Stops future monthly charges. Employees already hired stay for the month that was paid. */
  async cancel(userId: string, workspaceId: string, orderId: string): Promise<Order> {
    this.identity.require(userId, workspaceId, "employee.hire");
    const o = this.orders.get(orderId);
    if (!o || o.workspaceId !== workspaceId) throw new PaymentError("order not found");
    if (o.status !== "paid" && o.status !== "pending") throw new PaymentError("this order cannot be cancelled");
    if (o.providerRef && this.d.provider) await this.d.provider.cancelSubscription(o.providerRef);
    const next = { ...o, status: "cancelled" as const };
    this.save(next);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "order.cancelled", target: `order:${o.id}` });
    return next;
  }

  /** The provider calls this. Verified first; a replay changes nothing. */
  async handleWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<"ok" | "ignored"> {
    const provider = this.d.provider;
    if (!provider) throw new PaymentError("payments are not switched on");
    const event = provider.parseWebhook(rawBody, headers); // throws WebhookSignatureError
    if (!event) return "ignored";
    const o = this.orders.get(event.orderId);
    if (!o) return "ignored";
    if (event.type === "payment.succeeded") await this.markPaid(o.id);
    else if (event.type === "payment.failed") this.markFailed(o.id, "the payment failed");
    else if (o.status === "paid") this.save({ ...o, status: "cancelled" });
    return "ok";
  }

  /** Platform-level view for reconciliation: every order. */
  all(): Order[] { return [...this.orders.values()]; }

  private async markPaid(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (!o || o.fulfilledAt || this.fulfilling.has(orderId) || o.status === "cancelled") return;
    this.fulfilling.add(orderId);
    try {
      const paid: Order = { ...o, status: "paid", paidAt: o.paidAt ?? this.d.now().toISOString() };
      this.save(paid);
      this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.paid", target: `order:${o.id}`, data: { dueTodayMinor: o.dueTodayMinor } });
      try {
        const employeeIds = await this.d.fulfil(paid);
        this.save({ ...paid, employeeIds, fulfilledAt: this.d.now().toISOString() });
      } catch (e) {
        const problem = e instanceof Error ? e.message : "fulfilment failed";
        this.save({ ...paid, problem });
        await this.d.alert?.(`Paid order needs you: ${o.id}`, `A paid order could not be fulfilled (${problem}). Workspace ${o.workspaceId}.`).catch(() => undefined);
      }
    } finally {
      this.fulfilling.delete(orderId);
    }
  }

  private markFailed(orderId: string, problem: string): void {
    const o = this.orders.get(orderId);
    if (!o || o.status !== "pending") return;
    this.save({ ...o, status: "failed", problem });
    this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.failed", target: `order:${o.id}`, data: { problem } });
  }

  private save(o: Order): void {
    this.orders.set(o.id, o);
    this.sink?.record(o.workspaceId, "order", o.id, o);
  }
}

export { WebhookSignatureError };
