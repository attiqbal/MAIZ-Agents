import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { Quote } from "../store/cart.js";
import { PaymentUncertainError, WebhookSignatureError, type AddPreview, type CheckoutLine, type PaymentProvider, type ProviderEvent } from "./types.js";

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
  /** The provider's recurring subscription and customer, learned when the first payment completes. */
  subscriptionRef?: string;
  customerRef?: string;
  createdAt: string;
  paidAt?: string;
  /** Employees hired because this order was paid. Set once, so a replayed webhook never hires twice. */
  fulfilledAt?: string;
  employeeIds: string[];
  /** Why it failed or could not be fulfilled, in words for the platform owner. */
  problem?: string;
  /** A discount code that came off this order's monthly part. Already taken off `dueTodayMinor`. */
  discount?: OrderDiscount;
  /** One bill: the order whose subscription these lines were added to. `subscriptionRef` is then that shared subscription. */
  addedTo?: string;
  /** The provider's ids for lines added to a shared subscription, in the order of the lines. */
  itemRefs?: string[];
  /** Where the client finishes paying an addition their bank wants to check, and when that offer runs out. */
  payUrl?: string;
  payBy?: string;
  /** Which employees each line hired, by line key. Absent on older orders, which fall back to the order the lines were hired in. */
  hiredBy?: Record<string, string[]>;
  /** Monthly lines that have been stopped, by line key. */
  stops?: Record<string, LineStop>;
  /** Set when the provider could not be told to stop this order. Tried again until it goes through. */
  stopWanted?: string;
}

/** A monthly line that will not be charged again. What it bought is taken away once `endsAt` has passed. */
export interface LineStop {
  at: string;
  /** The end of the time already paid for. */
  endsAt: string;
  /** Who stopped it: the client, the payment provider, or the plan being cancelled. */
  by: "client" | "provider" | "plan";
  /** When what the line bought was taken away. Set once. */
  releasedAt?: string;
}

export interface StoppedLine { title: string; qty: number; endsAt: string }
export interface ReleasedLine { key: string; title: string; qty: number; employeeIds: string[] }

/** One monthly line the client pays for, as Plan and billing shows it. */
export interface BillLine {
  orderId: string;
  key: string;
  title: string;
  qty: number;
  monthlyMinor: number;
  /** True for the plan itself (the Team package). */
  plan: boolean;
  state: "active" | "stopping";
  renewsAt?: string;
  endsAt?: string;
  canStop: boolean;
}

/** What adding a cart to the monthly bill would do, shown before the client confirms. */
export interface BillPreview {
  addToBill: boolean;
  /** Why the normal checkout is used instead: the client holds a code, or one is still running on the bill. */
  reason?: "code" | "discount";
  addMinor?: number;
  monthlyNowMinor?: number;
  monthlyNewMinor?: number;
  renewsAt?: string;
  /** The exact part-month charge, only when the provider gave one. */
  partMonthMinor?: number;
  /** One-off items in the cart, which keep their own checkout. */
  onceMinor?: number;
}

export interface CheckoutResult {
  order: Order;
  url?: string;
  /** Set when the monthly lines went onto the bill the client already pays. */
  addedToBill?: true;
  /** One-off items left in the cart for their own checkout. */
  remaining?: { key: string; qty: number }[];
}

/** A client's waiting discount, priced for one order. `id` names the redemption so it is used once. */
export interface OrderDiscount {
  id: string;
  code: string;
  amountOffMinor: number;
  months: number | "forever";
}

export interface PaymentDeps {
  provider?: PaymentProvider;
  /** Prices a cart from the live price book, for this client's plan. The client never supplies a price. */
  quote: (lines: readonly unknown[], workspaceId: string) => Quote;
  /** Hires what an order bought. Throws if it cannot. Says which line hired whom, since a line may be skipped (an employee the client already has). */
  fulfil: (order: Order) => Promise<Hired>;
  /** Public address for return links. */
  appUrl: string;
  customerEmail: (userId: string) => string | undefined;
  now: () => Date;
  /** Told when a paid order could not be fulfilled, so a person can fix it. */
  alert?: (subject: string, text: string) => Promise<void>;
  /** The discount code this client is holding, priced for an order with this monthly amount. */
  discountFor?: (workspaceId: string, monthlyMinor: number) => OrderDiscount | undefined;
  /** Told when an order that carried a discount is paid, so the same code is never applied twice. */
  discountUsed?: (workspaceId: string, discountId: string, orderId: string) => void;
  /**
   * Told when a paid monthly order stops: "client" when they cancelled here (they keep the month they paid for),
   * "provider" when the payment provider ended the subscription (the paid time is already over).
   */
  stopped?: (order: Order, by: "client" | "provider", also?: StoppedLine[]) => void;
  /** True for an item a client can only hold once (the Team package, an online-shop employee). An older unpaid checkout holding it is closed when a new one opens. */
  onceOnly?: (key: string) => boolean;
  /** True for the plan itself (the Team package). When it stops, every other monthly line of the client is stopped too. */
  plan?: (key: string) => boolean;
  /** The platform owner's switch: later monthly lines join the subscription the client already pays. Off unless true. */
  oneBill?: () => boolean;
  /** The end of the month paid for, for a payment made at `paidAt`, as seen at `at`. */
  periodEnd?: (paidAt: string, at: Date) => Date;
  /** Takes away what a stopped line bought, once its paid time is over. Returns the employees actually removed. */
  release?: (order: Order, line: CheckoutLine, employeeIds: string[]) => string[];
  /** Told what left a client's team in one pass, so they get one message. */
  released?: (workspaceId: string, lines: ReleasedLine[]) => void;
}

/** What fulfilment hired: everyone in order, and who came from which line (by line key). A bare list is the older shape. */
export type Hired = string[] | { employeeIds: string[]; byLine: Record<string, string[]> };

export const MAX_PENDING_ORDERS = 20;
const BUSY = "Your last change is still going through. Give it a moment.";
const MAX_SEEN_EVENTS = 5000;
const pence = (gbp: number) => Math.round(gbp * 100);
const DAY_MS = 86_400_000;
/** How long an addition to a bill may wait for payment when the provider names no time, and the slack after it. */
const ADD_WAIT_MS = DAY_MS;
const ADD_GRACE_MS = 3_600_000;
/** How often a stop the provider could not take is tried again. */
const STOP_RETRY_MS = 15 * 60_000;
/** How long the moment a preview priced the part month at is kept, so the charge is the figure that was shown. */
const PREVIEW_KEPT_MS = 15 * 60_000;
const monthlyOf = (o: Order): CheckoutLine[] => o.lines.filter((l) => l.billing === "monthly");
const total = (lines: readonly CheckoutLine[]): number => lines.reduce((n, l) => n + l.unitMinor * l.qty, 0);
const cartKey = (lines: readonly CheckoutLine[]): string => lines.map((l) => `${l.key}x${l.qty}`).sort().join(",");

/**
 * Turns a cart into an order and a provider checkout, and fulfils the order when the provider confirms payment.
 * With no provider configured, checkout is refused (no charging is switched on). Orders are stored with the client.
 */
export class PaymentService {
  private orders = new Map<string, Order>();
  private sink?: Sink;
  /** Orders being fulfilled right now, so two webhooks racing cannot hire twice. */
  private fulfilling = new Set<string>();
  /** Workspaces with a checkout running, so a double press cannot charge and hire twice. */
  private checkingOut = new Set<string>();
  /** Orders whose provider call has not come back yet. They have no provider reference to cancel, so nobody may close them. */
  private inFlight = new Set<string>();
  /** Lines (order and line key) being stopped at the provider right now, so a second press does not call it again. */
  private stopping = new Set<string>();
  /** Recently handled provider event ids. Handlers are idempotent anyway; this just short-circuits replays. */
  private seenEvents = new Set<string>();
  /** The moment the last bill preview priced each client's cart at. Never taken from the browser. */
  private previews = new Map<string, { cart: string; prorationDate: number; at: number }>();
  private sweeping = false;

  constructor(private identity: IdentityService, private audit: AuditLog, private d: PaymentDeps) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(o: Order): void { this.orders.set(o.id, o); }
  get enabled(): boolean { return !!this.d.provider; }
  get providerName(): string | undefined { return this.d.provider?.name; }

  async checkout(userId: string, workspaceId: string, rawLines: unknown, opts: { addToBill?: boolean } = {}): Promise<CheckoutResult> {
    this.identity.require(userId, workspaceId, "workspace.manage"); // paying, the card and cancelling are the owner's alone
    // One change at a time per client: a second press while the first is with the provider would charge and hire twice.
    if (this.checkingOut.has(workspaceId)) throw new PaymentError(BUSY);
    this.checkingOut.add(workspaceId);
    try {
      return await this.startCheckout(userId, workspaceId, rawLines, opts);
    } finally {
      this.checkingOut.delete(workspaceId);
    }
  }

  private async startCheckout(userId: string, workspaceId: string, rawLines: unknown, opts: { addToBill?: boolean }): Promise<CheckoutResult> {
    const provider = this.d.provider;
    if (!provider) throw new PaymentError("payments are not switched on yet, so nothing can be bought");
    if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > 100) throw new PaymentError("your cart is empty");
    const q = this.d.quote(rawLines, workspaceId);
    if (q.rejected.length) throw new PaymentError(`some items cannot be bought: ${q.rejected.map((r) => `${r.key || "unknown"} (${r.reason})`).join(", ")}`);
    if (!q.lines.length) throw new PaymentError("your cart is empty");
    const pending = [...this.orders.values()].filter((o) => o.workspaceId === workspaceId && o.status === "pending").length;
    if (pending >= MAX_PENDING_ORDERS) throw new PaymentError("you have too many unpaid orders; finish or wait for them first");

    const lines: CheckoutLine[] = q.lines.map((l) => ({ key: l.key, title: l.title, qty: l.qty, unitMinor: pence(l.unitGbp), billing: l.billing }));
    const monthlyMinor = lines.filter((l) => l.billing === "monthly").reduce((n, l) => n + l.unitMinor * l.qty, 0);
    const onceMinor = lines.filter((l) => l.billing === "once").reduce((n, l) => n + l.unitMinor * l.qty, 0);
    // A once-only item (the Team package, an online-shop employee): two open checkouts must never both be paid for it.
    const onceOnly = new Set(lines.filter((l) => this.d.onceOnly?.(l.key)).map((l) => l.key));
    if (onceOnly.size) await this.releasePending(workspaceId, (o) => o.lines.some((l) => onceOnly.has(l.key)));
    // One bill: only when the client asked for it on a page that told them their saved card is charged. If it cannot
    // be done before any money moves, the normal checkout below is used, so a client can always buy.
    const added = opts.addToBill ? await this.addToBill(userId, workspaceId, lines) : undefined;
    if (added) return added;
    const discount = this.d.discountFor?.(workspaceId, monthlyMinor);
    // One code discounts one subscription: an unpaid checkout that was holding it is closed before a new one opens.
    if (discount) await this.releasePending(workspaceId, (o) => o.discount?.id === discount.id);
    const order: Order = {
      id: newId("order"), workspaceId, userId, lines, monthlyMinor, dueTodayMinor: monthlyMinor + onceMinor - (discount?.amountOffMinor ?? 0), currency: "GBP",
      status: "pending", provider: provider.name, createdAt: this.d.now().toISOString(), employeeIds: [], ...(discount ? { discount } : {}),
    };
    this.save(order);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "order.created", target: `order:${order.id}`, data: { dueTodayMinor: order.dueTodayMinor, monthlyMinor } });
    const base = this.d.appUrl.replace(/\/$/, "");
    const session = await this.whileInFlight(order.id, () => provider.createCheckout({
      orderId: order.id, workspaceId, customerEmail: this.d.customerEmail(userId), currency: "GBP", lines,
      dueTodayMinor: order.dueTodayMinor, monthlyMinor, successUrl: `${base}/app.html?order=${order.id}#team`, cancelUrl: `${base}/app.html?cancelled=1#store`,
      ...(discount ? { discount: { amountOffMinor: discount.amountOffMinor }, discountMonths: discount.months } : {}),
    })).catch((e) => { this.save({ ...order, status: "failed", problem: "the payment provider could not start the payment" }); throw e; });
    this.save({ ...this.orders.get(order.id)!, providerRef: session.providerRef, ...(session.subscriptionRef ? { subscriptionRef: session.subscriptionRef } : {}) });
    if (session.status === "paid") await this.markPaid(order.id);
    else if (session.status === "failed") this.markFailed(order.id, "the payment was declined");
    return { order: this.orders.get(order.id)!, ...(session.url ? { url: session.url } : {}) };
  }

  /** Runs a provider call that can move money, and marks the order as waiting on it until it comes back. */
  private async whileInFlight<T>(orderId: string, call: () => Promise<T>): Promise<T> {
    this.inFlight.add(orderId);
    try {
      return await call();
    } finally {
      this.inFlight.delete(orderId);
    }
  }

  /** Closes any unpaid checkout of this client that holds the same discount or once-only item, so it cannot be paid alongside a newer one. */
  private async releasePending(workspaceId: string, holds: (o: Order) => boolean): Promise<void> {
    const holding = [...this.orders.values()].filter((o) => o.workspaceId === workspaceId && o.status === "pending" && !this.inFlight.has(o.id) && holds(o));
    for (const o of holding) {
      if (o.providerRef) await this.d.provider?.cancelSubscription(o.providerRef);
      this.markFailed(o.id, "replaced by a newer checkout");
    }
  }

  mine(userId: string, workspaceId: string): Order[] {
    this.identity.require(userId, workspaceId, "workspace.manage"); // what was bought and paid is billing, so the owner's alone
    return [...this.orders.values()].filter((o) => o.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Stops future monthly charges. Employees already hired stay for the month that was paid. */
  async cancel(userId: string, workspaceId: string, orderId: string): Promise<Order> {
    this.identity.require(userId, workspaceId, "workspace.manage"); // paying, the card and cancelling are the owner's alone
    const o = this.orders.get(orderId);
    if (!o || o.workspaceId !== workspaceId) throw new PaymentError("order not found");
    if (o.status !== "paid" && o.status !== "pending") throw new PaymentError("this order cannot be cancelled");
    // Lines that share the plan's subscription are taken off it one by one: the subscription itself carries on.
    if (o.status === "paid" && o.addedTo) {
      for (const l of monthlyOf(o)) if (!this.orders.get(o.id)!.stops?.[l.key]) await this.stopLine(userId, workspaceId, o.id, l.key);
      return this.orders.get(o.id)!;
    }
    // An addition still waiting for payment: only its own invoice is closed, never the shared subscription.
    const ref = o.addedTo ? o.providerRef : await this.stopRef(o);
    if (ref && this.d.provider) await this.d.provider.cancelSubscription(ref);
    const next = o.status === "paid" ? this.withStops(o, this.periodOf(o).toISOString(), "client") : { ...o, status: "cancelled" as const };
    this.save(next);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "order.cancelled", target: `order:${o.id}` });
    if (o.status === "paid") await this.afterStop(next, "client");
    return next;
  }

  /**
   * Stops one monthly line at the end of the month already paid for. The employee it bought keeps working until
   * then (see `sweep`). The plan line stops the whole order, which stops every other monthly line too.
   */
  async stopLine(userId: string, workspaceId: string, orderId: string, key: string): Promise<Order> {
    this.identity.require(userId, workspaceId, "employee.hire");
    const o = this.orders.get(orderId);
    if (!o || o.workspaceId !== workspaceId) throw new PaymentError("order not found");
    const line = monthlyOf(o).find((l) => l.key === key);
    if (!line || o.status !== "paid" || o.stops?.[key]) throw new PaymentError("this cannot be stopped: it is not an active monthly line");
    if (this.d.plan?.(key)) return this.cancel(userId, workspaceId, orderId);
    // A second press while the first is still with the provider: the answer is how things stand, and the provider is not asked twice.
    const busyKey = `${orderId}:${key}`;
    if (this.stopping.has(busyKey)) return o;
    this.stopping.add(busyKey);
    try {
      return await this.stopLineNow(userId, workspaceId, o, line);
    } finally {
      this.stopping.delete(busyKey);
    }
  }

  private async stopLineNow(userId: string, workspaceId: string, o: Order, line: CheckoutLine): Promise<Order> {
    const key = line.key;
    const provider = this.d.provider;
    if (!provider) throw new PaymentError("payments are not switched on");
    const others = this.liveLines(workspaceId).filter((x) => !!o.subscriptionRef && x.order.subscriptionRef === o.subscriptionRef && !(x.order.id === o.id && x.line.key === key));
    let endsAt = this.periodOf(o).toISOString();
    // Refused, with an alert, before anything is tried, when the provider's subscription was never learned.
    const ref = others.length ? undefined : await this.stopRef(o);
    try {
      if (!others.length) {
        // The only line left on its subscription: the subscription ends with it.
        if (ref) await provider.cancelSubscription(ref);
      } else {
        if (!provider.removeFromSubscription) throw new Error("the provider cannot take one line off a subscription");
        const itemRef = o.itemRefs?.[monthlyOf(o).indexOf(line)];
        const r = await provider.removeFromSubscription({ subscriptionRef: o.subscriptionRef!, workspaceId, planOrderId: o.addedTo ?? o.id, ...(itemRef ? { itemRef } : {}), match: { title: line.title, unitMinor: line.unitMinor, qty: line.qty } });
        endsAt = r.endsAt ?? endsAt;
      }
    } catch (e) {
      await this.d.alert?.(`A monthly line could not be stopped: ${o.id}`, `A client asked to stop "${line.title}" and the payment provider did not take it (${e instanceof Error ? e.message : "unknown error"}). Nothing was changed. Workspace ${workspaceId}.`).catch(() => undefined);
      throw new PaymentError("We could not stop this just now, so nothing has changed. Please try again in a few minutes.");
    }
    const next = this.withStops(this.orders.get(o.id)!, endsAt, "client", false, [key]);
    this.save(next);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "order.line_stopped", target: `order:${o.id}`, data: { key, endsAt } });
    return next;
  }

  /** The provider calls this. Verified first; a replay changes nothing. */
  async handleWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<"ok" | "ignored"> {
    const provider = this.d.provider;
    if (!provider) throw new PaymentError("payments are not switched on");
    const event = provider.parseWebhook(rawBody, headers); // throws WebhookSignatureError
    if (!event) return "ignored";
    if (event.eventId && this.seenEvents.has(event.eventId)) return "ok";
    const result = await this.apply(event);
    // Only a handled event is remembered, so a delivery that failed halfway is retried by the provider.
    if (event.eventId) {
      this.seenEvents.add(event.eventId);
      if (this.seenEvents.size > MAX_SEEN_EVENTS) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    return result;
  }

  private async apply(event: ProviderEvent): Promise<"ok" | "ignored"> {
    if (event.type === "payment.attention") {
      await this.d.alert?.("A payment needs a look", event.detail ?? "The payment provider flagged a payment.").catch(() => undefined);
      return "ok";
    }
    if (event.type === "invoice.paid") return this.invoicePaid(event);
    if (event.type === "invoice.voided") return this.addEnded(event, (o) => o.providerRef === event.providerRef, "its invoice was cancelled before it was paid");
    // A waiting change ran out: any addition whose lines are neither on the subscription nor still waiting is over.
    if (event.type === "subscription.update_expired") return this.addEnded(event, (o) => !o.itemRefs?.length || !o.itemRefs.every((r) => event.itemRefs?.includes(r)), "it was not paid in time");
    if (event.type === "subscription.cancelled") return this.subscriptionEnded(event);
    const o = this.find(event);
    if (!o) return "ignored";
    const direct = event.type === "payment.succeeded" || event.type === "payment.failed";
    if (direct && !this.matches(o, event)) {
      await this.d.alert?.(`Payment does not match order ${o.id}`, `A signed ${event.type} event did not match the order's session, amount or currency, so it was ignored. Workspace ${o.workspaceId}.`).catch(() => undefined);
      return "ignored";
    }
    if (direct) {
      const learned = {
        ...(event.subscriptionRef && !o.subscriptionRef ? { subscriptionRef: event.subscriptionRef } : {}),
        ...(event.customerRef && !o.customerRef ? { customerRef: event.customerRef } : {}),
      };
      if (Object.keys(learned).length) this.save({ ...this.orders.get(o.id)!, ...learned });
    }
    if (event.type === "payment.succeeded") await this.markPaid(o.id);
    else if (event.type === "payment.failed") this.markFailed(o.id, "the payment failed");
    else if (event.type === "payment.renewal_failed") await this.renewalFailed(o);
    return "ok";
  }

  /**
   * The provider ended a subscription: the paid time is over for every order on it. Paid orders are cancelled and
   * their lines released at once; an addition still waiting for payment can no longer be paid for.
   */
  private async subscriptionEnded(event: ProviderEvent): Promise<"ok" | "ignored"> {
    const first = this.find(event);
    if (!first) return "ignored";
    const now = this.d.now().toISOString();
    const hasPlan = (o: Order) => o.lines.some((l) => this.d.plan?.(l.key));
    const onIt = first.subscriptionRef ? [...this.orders.values()].filter((o) => o.subscriptionRef === first.subscriptionRef && o.workspaceId === first.workspaceId) : [first];
    // The plan first, so everything it stops is named in one message to the client.
    for (const g of [...onIt].sort((a, b) => Number(hasPlan(b)) - Number(hasPlan(a)))) {
      const o = this.orders.get(g.id)!;
      if (o.status === "paid") {
        const stopped = this.withStops(o, now, "provider", true);
        this.save(stopped);
        this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.cancelled", target: `order:${o.id}` });
        await this.afterStop(stopped, "provider");
      } else if (o.status === "cancelled" && o.paidAt && monthlyOf(o).some((l) => !o.stops?.[l.key]?.releasedAt)) {
        this.save(this.withStops(o, now, "provider", true));
      } else if (o.status === "pending" && o.addedTo) {
        this.save({ ...o, status: "cancelled", problem: "the subscription ended before this was paid" });
      }
    }
    await this.sweep();
    return "ok";
  }

  /** A paid invoice on a shared subscription. It counts only for an addition of ours that is still unpaid and matches in every way. */
  private async invoicePaid(e: ProviderEvent): Promise<"ok" | "ignored"> {
    if (!e.subscriptionRef) return "ignored";
    const open = [...this.orders.values()].filter((o) => o.addedTo && o.subscriptionRef === e.subscriptionRef && !o.paidAt && !o.fulfilledAt);
    const shares = (o: Order) => !!o.itemRefs?.length && o.itemRefs.every((r) => e.itemRefs?.includes(r));
    // By the invoice we were given when we asked, or (when that answer never came) by the lines we created for it.
    const o = open.find((x) => x.providerRef === e.providerRef) ?? open.find((x) => !x.providerRef && shares(x));
    const near = o ?? open.find((x) => x.itemRefs?.some((r) => e.itemRefs?.includes(r)));
    const plan = o ? this.orders.get(o.addedTo!) : undefined;
    const fits = !!o && plan?.workspaceId === o.workspaceId && (e.workspaceRef === undefined || e.workspaceRef === o.workspaceId)
      && (!e.currency || e.currency.toUpperCase() === o.currency) && (e.amountMinor === undefined || e.amountMinor >= o.dueTodayMinor);
    if (!o || !fits) {
      if (near) await this.d.alert?.(`Payment does not match order ${near.id}`, `A signed invoice.paid event did not match the addition's invoice, workspace, amount or currency, so it was ignored. Workspace ${near.workspaceId}.`).catch(() => undefined);
      return "ignored";
    }
    this.save({ ...o, providerRef: e.providerRef, ...(e.amountMinor !== undefined ? { dueTodayMinor: e.amountMinor } : {}), ...(e.customerRef && !o.customerRef ? { customerRef: e.customerRef } : {}) });
    await this.markPaid(o.id);
    return "ok";
  }

  /** An addition to a shared subscription that can no longer be paid: the order fails and nothing is added. */
  private addEnded(e: ProviderEvent, over: (o: Order) => boolean, why: string): "ok" | "ignored" {
    const ended = [...this.orders.values()].filter((o) => o.addedTo && o.status === "pending" && !!e.subscriptionRef && o.subscriptionRef === e.subscriptionRef && over(o));
    for (const o of ended) this.markFailed(o.id, why);
    return ended.length ? "ok" : "ignored";
  }

  /** A payment event counts only for the very session we opened, for at least the amount due, in the order's currency. */
  private matches(o: Order, e: ProviderEvent): boolean {
    if (o.providerRef && e.providerRef !== o.providerRef) return false;
    if (e.amountMinor !== undefined && e.type === "payment.succeeded" && e.amountMinor < o.dueTodayMinor) return false;
    if (e.currency && e.currency.toUpperCase() !== o.currency) return false;
    return true;
  }

  /** Opens the provider's own page where the client manages their card, invoices and cancellation. */
  async portalUrl(userId: string, workspaceId: string, returnUrl: string): Promise<string> {
    this.identity.require(userId, workspaceId, "workspace.manage"); // paying, the card and cancelling are the owner's alone
    const provider = this.d.provider;
    if (!provider?.createPortalSession) throw new PaymentError("billing management is not available yet");
    const o = this.mine(userId, workspaceId).find((x) => x.customerRef);
    if (!o?.customerRef) throw new PaymentError("there is nothing to manage yet: no payment has been made");
    return provider.createPortalSession(o.customerRef, returnUrl);
  }

  private find(e: { orderId?: string; subscriptionRef?: string }): Order | undefined {
    if (e.orderId) return this.orders.get(e.orderId);
    if (!e.subscriptionRef) return undefined;
    return [...this.orders.values()].find((o) => o.subscriptionRef === e.subscriptionRef);
  }

  private async renewalFailed(o: Order): Promise<void> {
    this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.renewal_failed", target: `order:${o.id}` });
    await this.d.alert?.(`Renewal payment failed: ${o.id}`, `A monthly payment failed for workspace ${o.workspaceId}. The provider will retry and email the customer; the subscription ends if it keeps failing.`).catch(() => undefined);
  }

  /** Platform-level view for reconciliation: every order. */
  all(): Order[] { return [...this.orders.values()]; }

  private async markPaid(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    // An order that was closed before any money arrived is never fulfilled, whatever the provider says later: a person decides.
    if (o && (o.status === "cancelled" || o.status === "failed") && !o.paidAt) {
      this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: o.status === "cancelled" ? "order.paid_after_cancel" : "order.paid_after_failed", target: `order:${o.id}` });
      await this.d.alert?.(`Paid a ${o.status} order: ${o.id}`, `A payment arrived for a ${o.status} order, so nothing was hired. Refund it in Stripe or restore the order. Workspace ${o.workspaceId}.`).catch(() => undefined);
      return;
    }
    if (!o || o.fulfilledAt || this.fulfilling.has(orderId) || o.status === "cancelled") return;
    this.fulfilling.add(orderId);
    try {
      const paid: Order = { ...o, status: "paid", paidAt: o.paidAt ?? this.d.now().toISOString() };
      this.save(paid);
      this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.paid", target: `order:${o.id}`, data: { dueTodayMinor: o.dueTodayMinor, ...(o.discount ? { discountCode: o.discount.code, discountMinor: o.discount.amountOffMinor } : {}) } });
      if (o.discount) this.d.discountUsed?.(o.workspaceId, o.discount.id, o.id);
      try {
        const hired = await this.d.fulfil(paid);
        const { employeeIds, byLine } = Array.isArray(hired) ? { employeeIds: hired, byLine: undefined } : hired;
        // Onto the order as it is now: the call that started an addition may have saved its invoice meanwhile.
        this.save({ ...paid, ...this.orders.get(orderId), status: "paid", employeeIds, ...(byLine ? { hiredBy: byLine } : {}), fulfilledAt: this.d.now().toISOString() });
      } catch (e) {
        const problem = e instanceof Error ? e.message : "fulfilment failed";
        this.save({ ...paid, ...this.orders.get(orderId), problem });
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

  // ---- one bill: a later monthly line joins the subscription the client already pays (docs/ONE-BILL.md) ----

  /** The client's paid plan order whose subscription a new monthly line can join, or why the normal checkout is used. */
  private billTarget(workspaceId: string, lines: readonly CheckoutLine[]): { plan?: Order; reason?: "code" | "discount" } {
    const monthly = lines.filter((l) => l.billing === "monthly");
    if (!this.d.oneBill?.() || !this.d.provider?.addToSubscription || !monthly.length || monthly.some((l) => this.d.plan?.(l.key))) return {};
    const plan = [...this.orders.values()]
      .filter((o) => o.workspaceId === workspaceId && o.status === "paid" && !!o.subscriptionRef && !!o.fulfilledAt && !o.addedTo && o.provider === this.d.provider?.name && o.lines.some((l) => this.d.plan?.(l.key) && !o.stops?.[l.key]))
      .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))[0];
    if (!plan) return {};
    // A code the client is holding is used at a normal checkout, exactly as before, so it is applied once and in full.
    if (this.d.discountFor?.(workspaceId, total(monthly))) return { reason: "code" };
    // A code still running on the bill would also touch the part-month charge in a way we cannot check. Keep them apart.
    if (this.discountRunning(plan)) return { reason: "discount" };
    return { plan };
  }

  private discountRunning(o: Order): boolean {
    if (!o.discount) return false;
    if (o.discount.months === "forever") return true;
    const start = new Date(o.paidAt ?? o.createdAt);
    // Two days of slack past the last discounted month, so an invoice raised right at the edge is never caught.
    const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + o.discount.months, start.getUTCDate() + 2);
    return this.d.now().getTime() < end;
  }

  /** What adding this cart to the monthly bill would do. Nothing is charged or stored at the provider. */
  async previewBill(userId: string, workspaceId: string, rawLines: unknown): Promise<BillPreview> {
    this.identity.require(userId, workspaceId, "employee.hire");
    const q = Array.isArray(rawLines) && rawLines.length > 0 && rawLines.length <= 100 ? this.d.quote(rawLines, workspaceId) : undefined;
    if (!q || q.rejected.length || !q.lines.length) return { addToBill: false };
    const lines: CheckoutLine[] = q.lines.map((l) => ({ key: l.key, title: l.title, qty: l.qty, unitMinor: pence(l.unitGbp), billing: l.billing }));
    const { plan, reason } = this.billTarget(workspaceId, lines);
    const provider = this.d.provider;
    if (!plan || !provider) return { addToBill: false, ...(reason ? { reason } : {}) };
    const monthly = lines.filter((l) => l.billing === "monthly");
    let seen: AddPreview = {};
    try {
      seen = (await provider.previewAddToSubscription?.({ workspaceId, planOrderId: plan.id, subscriptionRef: plan.subscriptionRef!, currency: "GBP", lines: monthly })) ?? {};
    } catch {
      // No figure is better than a wrong one: the cart then says the provider works the amount out.
      seen = {};
    }
    if (seen.prorationDate) this.previews.set(workspaceId, { cart: cartKey(monthly), prorationDate: seen.prorationDate, at: this.d.now().getTime() });
    else this.previews.delete(workspaceId);
    const monthlyNowMinor = this.liveLines(workspaceId).filter((x) => x.order.subscriptionRef === plan.subscriptionRef).reduce((n, x) => n + x.line.unitMinor * x.line.qty, 0);
    return {
      addToBill: true, addMinor: total(monthly), monthlyNowMinor, monthlyNewMinor: monthlyNowMinor + total(monthly),
      renewsAt: seen.renewsAt ?? this.periodOf(plan).toISOString(), ...(seen.amountMinor !== undefined ? { partMonthMinor: seen.amountMinor } : {}),
      onceMinor: total(lines.filter((l) => l.billing === "once")),
    };
  }

  /**
   * Adds the cart's monthly lines to the client's existing subscription. Returns undefined when that could not be
   * done and no money moved, so the caller opens a normal checkout. One-off lines are left for their own checkout.
   */
  private async addToBill(userId: string, workspaceId: string, lines: CheckoutLine[]): Promise<CheckoutResult | undefined> {
    const { plan } = this.billTarget(workspaceId, lines);
    const provider = this.d.provider;
    if (!plan || !provider?.addToSubscription) return undefined;
    const monthly = lines.filter((l) => l.billing === "monthly");
    const subscriptionRef = plan.subscriptionRef!;
    // Only one change can wait on a subscription: an older addition nobody paid is closed first.
    try { await this.releaseAdds(workspaceId, subscriptionRef); } catch { return undefined; }
    const now = this.d.now();
    const order: Order = {
      id: newId("order"), workspaceId, userId, lines: monthly, monthlyMinor: total(monthly), dueTodayMinor: 0, currency: "GBP", status: "pending", provider: provider.name,
      subscriptionRef, addedTo: plan.id, ...(plan.customerRef ? { customerRef: plan.customerRef } : {}), createdAt: now.toISOString(), payBy: new Date(now.getTime() + ADD_WAIT_MS).toISOString(), employeeIds: [],
    };
    this.save(order);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "order.created", target: `order:${order.id}`, data: { monthlyMinor: order.monthlyMinor, addedTo: plan.id } });
    const seen = this.previews.get(workspaceId);
    const prorationDate = seen && seen.cart === cartKey(monthly) && now.getTime() - seen.at <= PREVIEW_KEPT_MS ? seen.prorationDate : undefined;
    this.previews.delete(workspaceId);
    let r;
    try {
      r = await this.whileInFlight(order.id, () => provider.addToSubscription!({
        orderId: order.id, workspaceId, planOrderId: plan.id, subscriptionRef, currency: "GBP", lines: monthly, ...(prorationDate ? { prorationDate } : {}),
        prepared: (itemRefs) => this.save({ ...this.orders.get(order.id)!, itemRefs }),
      }));
    } catch (e) {
      if (e instanceof PaymentUncertainError) return this.addUnclear(order.id, e);
      this.markFailed(order.id, "it could not be added to the monthly bill, so a normal checkout was opened instead");
      return undefined;
    }
    this.save({ ...this.orders.get(order.id)!, providerRef: r.providerRef, itemRefs: r.itemRefs, dueTodayMinor: r.amountMinor ?? 0, ...(r.url ? { payUrl: r.url } : {}), ...(r.payBy ? { payBy: r.payBy } : {}) });
    if (r.status === "paid") {
      await this.markPaid(order.id);
      if (!r.amountMinor) await this.d.alert?.(`Added to a bill with nothing charged today: ${order.id}`, `The payment provider added lines to a subscription and charged nothing today. Check the subscription in the provider's dashboard. Workspace ${workspaceId}.`).catch(() => undefined);
    }
    const remaining = lines.filter((l) => l.billing === "once").map((l) => ({ key: l.key, qty: l.qty }));
    return { order: this.orders.get(order.id)!, ...(r.status !== "paid" && r.url ? { url: r.url } : {}), addedToBill: true, remaining };
  }

  /** The provider gave no clear answer: money may have moved, so no second way to pay is opened. The paid-invoice event settles it. */
  private async addUnclear(orderId: string, e: PaymentUncertainError): Promise<never> {
    const o = this.orders.get(orderId)!;
    this.save({ ...o, ...(e.providerRef ? { providerRef: e.providerRef } : {}), problem: "the payment provider gave no clear answer; waiting for its confirmation" });
    this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.unclear", target: `order:${o.id}` });
    await this.d.alert?.(`No clear answer from the payment provider: ${o.id}`, `Adding lines to a monthly bill ended without a clear answer, so the order is waiting and no other checkout was opened. If the invoice was paid, the order completes by itself. Otherwise it closes within a day. Check the subscription in the provider's dashboard. Workspace ${o.workspaceId}.`).catch(() => undefined);
    throw new PaymentError("We could not confirm this with the payment company. Please do not try again yet: look at Plan and billing in a few minutes. MAIZ has been told.");
  }

  /** Closes additions to this subscription that are still waiting for payment, so a newer one can take their place. */
  private async releaseAdds(workspaceId: string, subscriptionRef: string): Promise<void> {
    // One still with the provider has nothing to cancel yet and may be paid any moment: it is left alone.
    const waiting = [...this.orders.values()].filter((o) => o.workspaceId === workspaceId && o.status === "pending" && !!o.addedTo && o.subscriptionRef === subscriptionRef && !this.inFlight.has(o.id));
    for (const o of waiting) {
      if (o.providerRef) await this.d.provider?.cancelSubscription(o.providerRef);
      this.markFailed(o.id, "replaced by a newer order");
    }
  }

  // ---- stopping monthly lines, and taking away what they bought once the paid month is over ----

  /** Every monthly line of this client that is paid for and has not been stopped. */
  private liveLines(workspaceId: string): { order: Order; line: CheckoutLine }[] {
    return [...this.orders.values()].filter((o) => o.workspaceId === workspaceId && o.status === "paid")
      .flatMap((o) => monthlyOf(o).filter((l) => !o.stops?.[l.key]).map((line) => ({ order: o, line })));
  }

  /** The end of the month this order is paid up to. A line added to a shared bill follows the month of the order that opened it. */
  private periodOf(o: Order): Date {
    const root = (o.addedTo ? this.orders.get(o.addedTo) : undefined) ?? o;
    const now = this.d.now();
    return this.d.periodEnd?.(root.paidAt ?? root.createdAt, now) ?? new Date(now.getTime() + 31 * DAY_MS);
  }

  /**
   * The order with its monthly lines (all, or just `keys`) marked as stopped. Lines stopped earlier keep their end,
   * unless `pull` brings it forward (the provider says the paid time is over now). All lines stopped: the order is cancelled.
   */
  private withStops(o: Order, endsAt: string, by: LineStop["by"], pull = false, keys?: string[]): Order {
    const at = this.d.now().toISOString();
    const stops: Record<string, LineStop> = { ...o.stops };
    for (const l of monthlyOf(o)) {
      const had = stops[l.key];
      if (!had && (!keys || keys.includes(l.key))) stops[l.key] = { at, endsAt, by };
      else if (had && pull && !had.releasedAt && had.endsAt > endsAt) stops[l.key] = { ...had, endsAt };
    }
    const all = monthlyOf(o).every((l) => stops[l.key]);
    return { ...o, ...(Object.keys(stops).length ? { stops } : {}), ...(all ? { status: "cancelled" as const } : {}) };
  }

  /** Tells the platform an order stopped. When it carried the plan, every other monthly order of the client is stopped first. */
  private async afterStop(o: Order, by: "client" | "provider"): Promise<void> {
    const also = o.lines.some((l) => this.d.plan?.(l.key)) ? await this.stopExtras(o, by) : [];
    this.d.stopped?.(o, by, also);
  }

  /** The plan stopped: every other paid monthly order of the client stops at the end of its own paid month. */
  private async stopExtras(plan: Order, by: "client" | "provider"): Promise<StoppedLine[]> {
    const also: StoppedLine[] = [];
    const planEnd = by === "client" ? this.periodOf(plan).toISOString() : this.d.now().toISOString();
    // An addition nobody paid yet is closed. If the provider cannot be reached, it runs out by itself within a day.
    if (plan.subscriptionRef) await this.releaseAdds(plan.workspaceId, plan.subscriptionRef).catch(() => undefined);
    for (const x of [...this.orders.values()]) {
      const open = monthlyOf(x).filter((l) => !x.stops?.[l.key]);
      if (x.workspaceId !== plan.workspaceId || x.id === plan.id || x.status !== "paid" || !open.length) continue;
      // A line on the plan's own subscription ends with it: the provider needs no second call.
      const shared = !!x.subscriptionRef && x.subscriptionRef === plan.subscriptionRef;
      const next = shared ? this.withStops(x, planEnd, "plan") : await this.stopOwn(x);
      if (!next) continue;
      if (shared) {
        this.save(next);
        this.audit.record({ workspaceId: x.workspaceId, actor: `payment:${x.provider}`, action: "order.cancelled", target: `order:${x.id}`, data: { because: "plan" } });
      }
      for (const l of open) also.push({ title: l.title, qty: l.qty, endsAt: next.stops![l.key]!.endsAt });
    }
    return also;
  }

  /** Stops an order that has its own subscription, at the end of its own paid month. Undefined when the provider could not be told. */
  private async stopOwn(x: Order): Promise<Order | undefined> {
    let ref: string | undefined;
    try {
      ref = await this.stopRef(x, !x.stopWanted);
    } catch {
      // No subscription to stop from here. Left marked as wanted, so the client hears it is not stopped; the alert went out once.
      this.save({ ...x, stopWanted: this.d.now().toISOString() });
      return undefined;
    }
    try {
      if (ref && this.d.provider) await this.d.provider.cancelSubscription(ref);
    } catch (e) {
      this.save({ ...x, stopWanted: this.d.now().toISOString() });
      if (!x.stopWanted) await this.d.alert?.(`An extra could not be stopped: ${x.id}`, `The Team package was cancelled, but the payment provider did not take the stop for this monthly order (${e instanceof Error ? e.message : "unknown error"}). MAIZ tries again every few minutes. If this keeps coming, cancel the subscription in the provider's dashboard. Workspace ${x.workspaceId}.`).catch(() => undefined);
      return undefined;
    }
    const { stopWanted: _tried, ...rest } = x;
    const next = this.withStops(rest, this.periodOf(x).toISOString(), "plan");
    this.save(next);
    this.audit.record({ workspaceId: x.workspaceId, actor: `payment:${x.provider}`, action: "order.cancelled", target: `order:${x.id}`, data: { because: "plan" } });
    return next;
  }

  /**
   * What to tell the provider to stop for a paid order: its subscription. A checkout session (`cs_`) is no
   * subscription: once paid, "expiring" it does nothing while the provider keeps billing, so it is refused and a
   * person is told. Unpaid orders still close their session.
   */
  private async stopRef(o: Order, tell = true): Promise<string | undefined> {
    if (o.subscriptionRef || o.status !== "paid" || !o.providerRef?.startsWith("cs_")) return o.subscriptionRef ?? o.providerRef;
    if (tell) await this.d.alert?.(`A monthly order cannot be stopped from here: ${o.id}`, `A stop was needed for a paid monthly order, but the payment provider's subscription for it was never learned (only the checkout session ${o.providerRef}). Nothing was stopped, so it may still be billed. Cancel the subscription in the provider's dashboard. Workspace ${o.workspaceId}.`).catch(() => undefined);
    throw new PaymentError("We could not stop this from here, so nothing has changed. MAIZ has been told and will sort it out with you.");
  }

  /**
   * The employees a line of this order hired. Newer orders record it per line. Older ones were hired line by line,
   * in order, skipping the plan, so the position tells.
   */
  private employeesOf(o: Order, key: string): string[] {
    if (o.hiredBy) return o.hiredBy[key] ?? [];
    let from = 0;
    for (const l of o.lines) {
      if (this.d.plan?.(l.key)) continue;
      if (l.key === key) return o.employeeIds.slice(from, from + l.qty);
      from += l.qty;
    }
    return [];
  }

  /**
   * Housekeeping, safe to run as often as you like: closes additions nobody paid in time, retries stops the provider
   * did not take, and takes away what stopped lines bought once their paid month is over. Each line is released once.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.d.now();
      const left = new Map<string, ReleasedLine[]>();
      for (const seen of [...this.orders.values()]) {
        if (seen.status === "pending" && seen.addedTo && seen.payBy && new Date(seen.payBy).getTime() + ADD_GRACE_MS < now.getTime()) await this.addTimedOut(seen);
        if (seen.status === "paid" && seen.stopWanted && now.getTime() - new Date(seen.stopWanted).getTime() >= STOP_RETRY_MS) await this.stopOwn(seen);
        let o = this.orders.get(seen.id)!;
        // An order cancelled before stops were recorded: its paid month ends on the next monthly anniversary.
        // A cancelled order that only held the plan has nothing to take away: its end is the energy plan's own.
        if (o.status === "cancelled" && o.fulfilledAt && monthlyOf(o).some((l) => !this.d.plan?.(l.key)) && monthlyOf(o).some((l) => !o.stops?.[l.key])) this.save(o = this.withStops(o, this.periodOf(o).toISOString(), "client"));
        for (const line of monthlyOf(o)) {
          const stop = o.stops?.[line.key];
          if (!stop || stop.releasedAt || new Date(stop.endsAt).getTime() > now.getTime()) continue;
          const employeeIds = this.d.release?.(o, line, this.employeesOf(o, line.key)) ?? [];
          this.save(o = { ...o, stops: { ...o.stops, [line.key]: { ...stop, releasedAt: now.toISOString() } } });
          this.audit.record({ workspaceId: o.workspaceId, actor: `payment:${o.provider}`, action: "order.line_released", target: `order:${o.id}`, data: { key: line.key, employeeIds } });
          if (employeeIds.length) left.set(o.workspaceId, [...(left.get(o.workspaceId) ?? []), { key: line.key, title: line.title, qty: line.qty, employeeIds }]);
        }
      }
      for (const [workspaceId, lines] of left) this.d.released?.(workspaceId, lines);
    } finally {
      this.sweeping = false;
    }
  }

  private async addTimedOut(o: Order): Promise<void> {
    this.markFailed(o.id, "it was not paid in time");
    await this.d.alert?.(`An addition to a bill was not paid in time: ${o.id}`, `The order was closed and nothing was added. Check in the provider's dashboard that the subscription does not carry its lines. Workspace ${o.workspaceId}.`).catch(() => undefined);
  }

  /** Every monthly line the client pays for, with what it costs and when it renews or ends. */
  lines(userId: string, workspaceId: string): { lines: BillLine[]; monthlyMinor: number } {
    this.identity.require(userId, workspaceId, "task.read");
    const mayStop = this.identity.can(userId, workspaceId, "employee.hire");
    const live = this.liveLines(workspaceId);
    const rows = [...this.orders.values()].filter((o) => o.workspaceId === workspaceId && !!o.paidAt && (o.status === "paid" || o.status === "cancelled"))
      .sort((a, b) => (a.paidAt ?? "").localeCompare(b.paidAt ?? ""))
      .flatMap((o) => monthlyOf(o).map((l) => ({ o, l, stop: o.stops?.[l.key] })))
      .filter((x) => (x.stop ? !x.stop.releasedAt : x.o.status === "paid"));
    const lines = rows.map(({ o, l, stop }): BillLine => {
      const plan = !!this.d.plan?.(l.key);
      // A line alone on its subscription stops with it; one of several needs the provider to take a single line off.
      const alone = !live.some((x) => !!o.subscriptionRef && x.order.subscriptionRef === o.subscriptionRef && !(x.order.id === o.id && x.line.key === l.key));
      return {
        orderId: o.id, key: l.key, title: l.title, qty: l.qty, monthlyMinor: l.unitMinor * l.qty, plan, state: stop ? "stopping" : "active",
        ...(stop ? { endsAt: stop.endsAt } : { renewsAt: this.periodOf(o).toISOString() }),
        canStop: !stop && !plan && mayStop && (alone || !!this.d.provider?.removeFromSubscription),
      };
    });
    return { lines, monthlyMinor: lines.filter((l) => l.state === "active").reduce((n, l) => n + l.monthlyMinor, 0) };
  }
}

export { WebhookSignatureError };
