// The store picker and cart on the employees page. Prices come from /api/store, which reflects the
// platform owner's Prices page; with no API the launch defaults from the backend's cart module are used.
// Either way the page prices with the same quote() function as /api/cart/quote.
import { api, getToken } from "./api";
import { BILLING_INFO, CATALOGUE, KIND_LABEL, MAX_QTY, ONE_PER_BUSINESS, TEAM_PACKAGE_KEY, quote as quoteWith, type Billing, type CartLine, type CatalogueItem, type Quote } from "../../src/modules/store/cart";
import { OVERAGE_RULE } from "../../src/modules/workforce/task-roles";
import { HOW_A_PASS_WORKS } from "../../src/modules/workforce/consultants";
import { getJobDescription, jdHtml } from "./jd";

const KEY = "maiz.cart";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const priceLabel = (i: CatalogueItem) => (i.billing === "monthly" ? `${gbp(i.priceGbp)} / month` : `${gbp(i.priceGbp)} once`);

function load(): CartLine[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? quote(v).lines.map(({ key, qty }) => ({ key, qty })) : []; } catch { return []; }
}
function save(lines: CartLine[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage unavailable: cart lasts for this visit */ }
  // The price for this client is asked again for the new cart.
  mine = undefined;
  void priceForMe();
  askBill();
}

let cart: CartLine[] = [];
/** What can be bought, at today's prices. */
let catalogue: readonly CatalogueItem[] = CATALOGUE;
const getItem = (key: string) => catalogue.find((i) => i.key === key);
const quote = (lines: readonly unknown[]) => quoteWith(lines, catalogue);

/** The server's price for this client's cart: with the Team package when their plan starts, and their discount code taken off. */
interface MyQuote extends Quote { hasTeamPackage?: boolean; discount?: { code: string; amountOffGbp: number; months: number | "forever" } }
let mine: MyQuote | undefined;
let asked = 0;
/** Asks the server to price the cart for the signed-in client. The cart shows the list price until it answers. */
async function priceForMe(): Promise<void> {
  if (!getToken()) return;
  const turn = ++asked;
  const r = await api<MyQuote>("/cart/quote", { body: { lines: cart } });
  if (turn !== asked) return; // the cart changed while we were asking
  mine = r.ok && r.data && Array.isArray(r.data.lines) ? r.data : undefined;
  // Anything this client cannot buy (the Team package they already have) leaves the saved cart, so it cannot block checkout.
  const refused = new Set((mine?.rejected ?? []).map((x) => x.key));
  if (cart.some((l) => refused.has(l.key))) {
    // Said politely, because it is not an error: the employee is already on the team.
    const had = cart.filter((l) => refused.has(l.key) && ONE_PER_BUSINESS.has(l.key)).map((l) => getItem(l.key)?.title).filter(Boolean);
    if (had.length) $("cart-note").textContent = `You already have ${had.join(" and ")} on your team, so it is not in your cart.`;
    cart = cart.filter((l) => !refused.has(l.key));
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch { /* storage unavailable */ }
  }
  renderCart();
  renderPlan();
  renderPicker();
}
/**
 * One monthly bill: when the owner has switched it on and the client already pays the Team package, a cart of monthly
 * extras is added to that bill. The client is told what is charged today and what the new monthly total is, and must
 * confirm, before anything is sent with `addToBill`. With no answer here, checkout is the ordinary one.
 */
interface BillView { addToBill: boolean; reason?: "code" | "discount"; addMinor?: number; monthlyNowMinor?: number; monthlyNewMinor?: number; renewsAt?: string; partMonthMinor?: number; onceMinor?: number }
let bill: BillView | undefined;
let confirming = false;
let billTurn = 0;
let billTimer: number | undefined;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

function askBill(): void {
  bill = undefined;
  confirming = false;
  window.clearTimeout(billTimer);
  const lines = cart;
  const turn = ++billTurn;
  if (!getToken() || !lines.some((l) => getItem(l.key)?.billing === "monthly")) { renderBill(); return; }
  billTimer = window.setTimeout(async () => {
    const r = await api<BillView>("/billing/preview", { body: { lines } });
    if (turn !== billTurn) return;
    bill = r.ok && r.data ? r.data : undefined;
    renderBill();
    renderCart();
  }, 400);
  renderBill();
}

function renderBill(): void {
  let el = document.getElementById("cart-bill");
  if (!el) {
    el = document.createElement("div");
    el.id = "cart-bill";
    el.className = "cart-bill";
    el.setAttribute("role", "status");
    $("cart-checkout").insertAdjacentElement("beforebegin", el);
  }
  const b = bill;
  const btn = $<HTMLButtonElement>("cart-checkout");
  if (b?.addToBill && b.monthlyNewMinor !== undefined) {
    const part = b.partMonthMinor !== undefined ? `Your saved card is charged today only for the days left in this billing month: <b>${gbp(b.partMonthMinor / 100)}</b>.` : "Your saved card is charged today only for the days left in this billing month. Stripe works out the exact amount and shows it on your invoice.";
    el.innerHTML = `<p><b>This is added to your monthly bill. No new subscription is started.</b></p><p>${part}</p><p>Your monthly total goes from <b>${gbp(b.monthlyNowMinor! / 100)}</b> to <b>${gbp(b.monthlyNewMinor / 100)}</b>${b.renewsAt ? `, from ${esc(day(b.renewsAt))}` : ""}.</p>${b.onceMinor ? `<p>Consultant passes are paid for separately at a normal checkout afterwards.</p>` : ""}${confirming ? `<p><b>Press the button again to charge your saved card now.</b></p>` : ""}`;
    btn.textContent = confirming ? "Yes, charge my saved card" : "Add to my monthly bill";
    return;
  }
  el.innerHTML = b?.reason === "code" ? `<p class="small">You are holding a discount code, so these are paid for at a normal checkout, where your code is used.</p>`
    : b?.reason === "discount" ? `<p class="small">Your discount code is still running on your monthly bill, so these are paid for in their own checkout.</p>` : "";
  btn.textContent = "Checkout";
}
const discountFor = (months: number | "forever"): string => (months === "forever" ? "every month" : months === 1 ? "first month" : `first ${months} months`);

/** On the free trial, the first thing to offer is the plan itself. Hidden once the client has it or it is in the cart. */
function renderPlan(): void {
  const el = document.getElementById("store-plan");
  if (!el) return;
  const pack = getItem(TEAM_PACKAGE_KEY);
  const show = !!pack && mine?.hasTeamPackage === false && !cart.some((l) => l.key === TEAM_PACKAGE_KEY);
  el.hidden = !show;
  if (!show || !pack) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="store-plan-t"><h2>Keep your team after the trial</h2><p>${esc(pack.summary)} Cancel in one click whenever you like.</p></div><div class="store-plan-a"><p class="store-price">${priceLabel(pack)}</p><button class="btn btn-primary" type="button" id="store-plan-add">Add the Team package</button></div>`;
  document.getElementById("store-plan-add")?.addEventListener("click", () => { addToCart(TEAM_PACKAGE_KEY); $("cart-checkout").focus(); });
}

function renderItem(): void {
  const item = getItem($<HTMLSelectElement>("store-pick").value);
  if (!item) { $("store-item").innerHTML = ""; return; }
  const jd = getJobDescription(item.key.split(":")[0]!);
  const b = BILLING_INFO[item.billing];
  $("store-item").innerHTML = `<div class="store-head"><div><h3>${esc(item.title)}</h3><p class="jd-meta">${KIND_LABEL[item.kind]}</p></div><p class="store-price">${priceLabel(item)}</p></div>
    <p><span class="bill-tag bill-${item.billing}">${b.label}</span></p>
    <p class="desc">${esc(item.summary)}</p>
    <p class="jd-note">${esc(b.note)}</p>
    <div class="store-add">${item.kind === "package" || ONE_PER_BUSINESS.has(item.key) ? "" : `<label class="label" for="store-qty">Quantity</label><input class="input" id="store-qty" type="number" min="1" max="${MAX_QTY}" value="1" inputmode="numeric">`}<button class="btn btn-primary" id="store-add" type="button">Add to cart</button></div>
    ${jd ? `<details class="jd"><summary>Full job description</summary>${jdHtml(jd)}</details>` : ""}`;
  $("store-add").addEventListener("click", () => {
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number(document.querySelector<HTMLInputElement>("#store-qty")?.value) || 1)));
    addToCart(item.key, qty);
  });
}

function lineHtml(l: ReturnType<typeof quote>["lines"][number]): string {
  // The Team package the server added (a first monthly order starts the plan) is not the client's to remove.
  const added = !cart.some((c) => c.key === l.key);
  const act = added ? "" : `<button class="btn btn-sm btn-ghost" type="button" data-remove="${esc(l.key)}" aria-label="Remove ${esc(l.title)}">Remove</button>`;
  const note = added ? `<span>Starts your plan: your first monthly order includes your whole team.</span>` : `<span>${l.qty} × ${gbp(l.unitGbp)} ${BILLING_INFO[l.billing].short}</span>`;
  return `<li><div><b>${esc(l.title)}</b>${note}</div><div class="cart-act"><span class="mono">${gbp(l.totalGbp)}</span>${act}</div></li>`;
}

function section(billing: Billing, lines: ReturnType<typeof quote>["lines"], total: number): string {
  if (!lines.length) return "";
  const b = BILLING_INFO[billing];
  const sum = billing === "monthly" ? `${gbp(total)} every month` : `${gbp(total)} once`;
  return `<section class="cart-sec"><h4><span class="bill-tag bill-${billing}">${b.label}</span><span class="mono">${sum}</span></h4><ul class="cart-list">${lines.map(lineHtml).join("")}</ul><p class="jd-note">${esc(b.note)}</p></section>`;
}

function renderCart(): void {
  const q: MyQuote = mine ?? quote(cart);
  const d = q.discount;
  $("cart-lines").innerHTML = q.lines.length
    ? section("monthly", q.lines.filter((l) => l.billing === "monthly"), q.monthlyGbp) + section("once", q.lines.filter((l) => l.billing === "once"), q.onceGbp)
    : `<p class="muted">Nothing here yet. Pick something on the left, or add a role from the org blueprint below.</p>`;
  $("cart-totals").innerHTML = `<div><dt>Recurring, every month</dt><dd>${gbp(q.monthlyGbp)}</dd></div><div><dt>One-off, consultant passes</dt><dd>${gbp(q.onceGbp)}</dd></div>${d ? `<div class="cart-off"><dt>Your code ${esc(d.code)}, ${discountFor(d.months)}</dt><dd>−${gbp(d.amountOffGbp)}</dd></div>` : ""}<div class="cart-due"><dt>Due today</dt><dd>${bill?.addToBill ? (bill.partMonthMinor !== undefined ? `${gbp(bill.partMonthMinor / 100)} for the days left` : "Worked out by Stripe") : gbp(q.dueTodayGbp)}</dd></div>${q.monthlyGbp ? `<div><dt>${d && d.months !== 1 ? "Later months" : "From next month"}</dt><dd>${d && d.months === "forever" ? gbp(Math.max(0, q.monthlyGbp - d.amountOffGbp)) : gbp(q.monthlyGbp)} / month${d && typeof d.months === "number" && d.months > 1 ? `, less ${gbp(d.amountOffGbp)} while your code runs` : ""}</dd></div>` : ""}`;
  $<HTMLButtonElement>("cart-checkout").disabled = q.lines.length === 0;
}

/** Adds one of an item to the cart. Used by the picker and by the org blueprint buttons. */
export function addToCart(key: string, qty = 1): string | undefined {
  const item = getItem(key);
  if (!item) return undefined;
  cart = quote([...cart, { key, qty }]).lines.map(({ key: k, qty: n }) => ({ key: k, qty: n }));
  save(cart);
  renderCart();
  $("cart-note").textContent = `${item.title} added to your cart (${BILLING_INFO[item.billing].label.toLowerCase()}).`;
  return item.title;
}

function renderPicker(): void {
  const picked = $<HTMLSelectElement>("store-pick").value;
  // A client who already has the Team package is not offered it again.
  const offered = catalogue.filter((i) => !(i.key === TEAM_PACKAGE_KEY && mine?.hasTeamPackage === true));
  const groups = [...new Set(offered.map((i) => i.group))];
  $("store-pick").innerHTML = `<option value="">Choose an employee, specialist or consultant…</option>` +
    groups.map((g) => `<optgroup label="${esc(g)}">${offered.filter((i) => i.group === g).map((i) => `<option value="${esc(i.key)}">${esc(i.title)} · ${priceLabel(i)}</option>`).join("")}</optgroup>`).join("");
  if (picked && offered.some((i) => i.key === picked)) $<HTMLSelectElement>("store-pick").value = picked;
  else if (picked) renderItem();
}

/** onPaid runs after a paid checkout, so the control centre can refresh the team. */
export function initStore(opts: { onPaid?: () => void } = {}): void {
  renderPicker();
  $("store-pick").addEventListener("change", renderItem);
  $("cart-lines").addEventListener("click", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
    if (!key) return;
    cart = cart.filter((l) => l.key !== key);
    save(cart);
    renderCart();
    $("cart-note").textContent = "Removed from your cart.";
  });
  // With no payment provider switched on, say so plainly instead of pretending to charge.
  const PLACEHOLDER = "Payments are not switched on here yet. Your cart is saved on this device, and nothing has been charged.";
  const SIGN_IN = "Log in or start your free trial to check out. Your cart is saved on this device, and nothing has been charged.";
  // Back from the payment page without paying: say so plainly. The cart is still here.
  if (new URLSearchParams(location.search).has("cancelled")) {
    $("cart-note").textContent = "Payment cancelled. Nothing was charged, and your cart is still here.";
    history.replaceState(null, "", location.pathname + location.hash);
  }
  $("cart-checkout").addEventListener("click", async () => {
    if (!getToken()) { $("cart-note").textContent = SIGN_IN; return; }
    const btn = $<HTMLButtonElement>("cart-checkout");
    // Adding to the monthly bill charges a saved card without a payment page, so it asks once more first.
    if (bill?.addToBill && !confirming) { confirming = true; renderBill(); btn.focus(); return; }
    const toBill = !!bill?.addToBill && confirming;
    btn.disabled = true;
    btn.textContent = toBill ? "Adding it to your bill…" : "Opening the payment page…";
    const r = await api<{ order?: { status: string }; url?: string; error?: string; addedToBill?: boolean; remaining?: CartLine[] }>("/checkout", { body: { lines: cart, ...(toBill ? { addToBill: true } : {}) } });
    btn.disabled = cart.length === 0;
    confirming = false;
    renderBill();
    if (r.status === 400 && /not switched on/.test(r.data?.error ?? "")) { $("cart-note").textContent = PLACEHOLDER; return; }
    if (!r.ok) { $("cart-note").textContent = r.data?.error ?? "Could not start the payment. Nothing was charged."; return; }
    // The monthly lines went onto the bill. Passes that were in the cart stay there for their own checkout.
    if (r.data?.addedToBill) {
      cart = (r.data.remaining ?? []).map(({ key, qty }) => ({ key, qty }));
      save(cart);
      renderCart();
      if (r.data.url) { location.assign(r.data.url); return; }
      $("cart-note").textContent = `Done. It is on your monthly bill and your new employees are on your team.${cart.length ? " Your consultant passes are still in your cart: check out to pay for them." : ""}`;
      opts.onPaid?.();
      return;
    }
    if (r.data?.url) { location.assign(r.data.url); return; }
    if (r.data?.order?.status === "paid") { cart = []; save(cart); renderCart(); $("cart-note").textContent = "Done. Your new employees are on your team."; opts.onPaid?.(); return; }
    $("cart-note").textContent = "The payment did not go through. Nothing was charged.";
  });
  $("task-rule").innerHTML = `<h3>How a consultant pass works</h3><ul>${HOW_A_PASS_WORKS.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><h3>If a pass needs more energy</h3><ul>${OVERAGE_RULE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="jd-note">Prices are in GBP. Payment is taken securely by Stripe; MAIZ never sees your card.</p>`;
  cart = load();
  renderCart();
  // Today's prices, as set by MAIZ. Kept on the defaults when the API is not reachable.
  void api<{ catalogue?: CatalogueItem[] }>("/store").then((r) => {
    if (!r.ok || !Array.isArray(r.data?.catalogue) || !r.data!.catalogue.length) return;
    catalogue = r.data!.catalogue;
    // Prices printed elsewhere on the page (the org blueprint) follow too.
    document.querySelectorAll<HTMLElement>("[data-price-key]").forEach((el) => {
      const item = getItem(el.dataset.priceKey!);
      if (item) el.textContent = priceLabel(item);
    });
    renderPicker();
    renderItem();
    cart = load();
    renderCart();
    renderPlan();
    askBill();
  });
  void priceForMe();
  askBill();
}
