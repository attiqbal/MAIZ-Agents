// The store picker and cart on the employees page. Prices come from the backend's
// pure cart module, so the page and /api/cart/quote always agree.
import { BILLING_INFO, CATALOGUE, KIND_LABEL, MAX_QTY, getItem, quote, type Billing, type CartLine, type CatalogueItem } from "../../src/modules/store/cart";
import { OVERAGE_RULE } from "../../src/modules/workforce/task-roles";
import { HOW_A_PASS_WORKS } from "../../src/modules/workforce/consultants";
import { getJobDescription, jdHtml } from "./jd";

const KEY = "maiz.cart";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gbp = (n: number) => `£${n.toLocaleString("en-GB")}`;
const priceLabel = (i: CatalogueItem) => (i.billing === "monthly" ? `${gbp(i.priceGbp)} / month` : `${gbp(i.priceGbp)} once`);

function load(): CartLine[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? quote(v).lines.map(({ key, qty }) => ({ key, qty })) : []; } catch { return []; }
}
function save(lines: CartLine[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage unavailable: cart lasts for this visit */ }
}

let cart: CartLine[] = [];

function renderItem(): void {
  const item = getItem($<HTMLSelectElement>("store-pick").value);
  if (!item) { $("store-item").innerHTML = ""; return; }
  const jd = getJobDescription(item.key.split(":")[0]!);
  const b = BILLING_INFO[item.billing];
  $("store-item").innerHTML = `<div class="store-head"><div><h3>${esc(item.title)}</h3><p class="jd-meta">${KIND_LABEL[item.kind]}</p></div><p class="store-price">${priceLabel(item)}</p></div>
    <p><span class="bill-tag bill-${item.billing}">${b.label}</span></p>
    <p class="desc">${esc(item.summary)}</p>
    <p class="jd-note">${esc(b.note)}</p>
    <div class="store-add"><label class="label" for="store-qty">Quantity</label><input class="input" id="store-qty" type="number" min="1" max="${MAX_QTY}" value="1" inputmode="numeric"><button class="btn btn-primary" id="store-add" type="button">Add to cart</button></div>
    ${jd ? `<details class="jd"><summary>Full job description</summary>${jdHtml(jd)}</details>` : ""}`;
  $("store-add").addEventListener("click", () => {
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number($<HTMLInputElement>("store-qty").value) || 1)));
    addToCart(item.key, qty);
  });
}

function lineHtml(l: ReturnType<typeof quote>["lines"][number]): string {
  return `<li><div><b>${esc(l.title)}</b><span>${l.qty} × ${gbp(l.unitGbp)} ${BILLING_INFO[l.billing].short}</span></div><div class="cart-act"><span class="mono">${gbp(l.totalGbp)}</span><button class="btn btn-sm btn-ghost" type="button" data-remove="${esc(l.key)}" aria-label="Remove ${esc(l.title)}">Remove</button></div></li>`;
}

function section(billing: Billing, lines: ReturnType<typeof quote>["lines"], total: number): string {
  if (!lines.length) return "";
  const b = BILLING_INFO[billing];
  const sum = billing === "monthly" ? `${gbp(total)} every month` : `${gbp(total)} once`;
  return `<section class="cart-sec"><h4><span class="bill-tag bill-${billing}">${b.label}</span><span class="mono">${sum}</span></h4><ul class="cart-list">${lines.map(lineHtml).join("")}</ul><p class="jd-note">${esc(b.note)}</p></section>`;
}

function renderCart(): void {
  const q = quote(cart);
  $("cart-lines").innerHTML = q.lines.length
    ? section("monthly", q.lines.filter((l) => l.billing === "monthly"), q.monthlyGbp) + section("once", q.lines.filter((l) => l.billing === "once"), q.onceGbp)
    : `<p class="muted">Nothing here yet. Pick something on the left, or add a role from the org blueprint below.</p>`;
  $("cart-totals").innerHTML = `<div><dt>Recurring, every month</dt><dd>${gbp(q.monthlyGbp)}</dd></div><div><dt>One-off, consultant passes</dt><dd>${gbp(q.onceGbp)}</dd></div><div class="cart-due"><dt>Due today</dt><dd>${gbp(q.dueTodayGbp)}</dd></div>${q.monthlyGbp ? `<div><dt>From next month</dt><dd>${gbp(q.monthlyGbp)} / month</dd></div>` : ""}`;
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

export function initStore(): void {
  const groups = [...new Set(CATALOGUE.map((i) => i.group))];
  $("store-pick").innerHTML = `<option value="">Choose an employee, specialist or consultant…</option>` +
    groups.map((g) => `<optgroup label="${esc(g)}">${CATALOGUE.filter((i) => i.group === g).map((i) => `<option value="${esc(i.key)}">${esc(i.title)} · ${priceLabel(i)}</option>`).join("")}</optgroup>`).join("");
  $("store-pick").addEventListener("change", renderItem);
  $("cart-lines").addEventListener("click", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
    if (!key) return;
    cart = cart.filter((l) => l.key !== key);
    save(cart);
    renderCart();
    $("cart-note").textContent = "Removed from your cart.";
  });
  // Payments are not connected yet: say so plainly instead of pretending to charge.
  $("cart-checkout").addEventListener("click", () => {
    $("cart-note").textContent = "Payments open soon. Your cart is saved on this device, and nothing has been charged. Monthly items will renew each month until you cancel; consultant passes are paid once.";
  });
  $("task-rule").innerHTML = `<h3>How a consultant pass works</h3><ul>${HOW_A_PASS_WORKS.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><h3>If a pass needs more energy</h3><ul>${OVERAGE_RULE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="jd-note">Prices are list prices in GBP and may change before launch.</p>`;
  cart = load();
  renderCart();
}
