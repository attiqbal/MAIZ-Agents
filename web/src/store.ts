// The store picker and cart on the employees page. Prices come from the backend's
// pure cart module, so the page and /api/cart/quote always agree.
import { CATALOGUE, MAX_QTY, getItem, quote, type CartLine, type CatalogueItem } from "../../src/modules/store/cart";
import { OVERAGE_RULE } from "../../src/modules/workforce/task-roles";
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
  const jd = getJobDescription(item.key);
  const kind = item.kind === "task" ? "One-off task" : item.kind === "specialist" ? "Custom specialist, trained for you" : "Ready-made employee";
  $("store-item").innerHTML = `<div class="store-head"><div><h3>${esc(item.title)}</h3><p class="jd-meta">${kind}</p></div><p class="store-price">${priceLabel(item)}</p></div>
    <p class="desc">${esc(item.summary)}</p>
    <div class="store-add"><label class="label" for="store-qty">Quantity</label><input class="input" id="store-qty" type="number" min="1" max="${MAX_QTY}" value="1" inputmode="numeric"><button class="btn btn-primary" id="store-add" type="button">Add to cart</button></div>
    ${jd ? `<details class="jd"><summary>Full job description</summary>${jdHtml(jd)}</details>` : ""}`;
  $("store-add").addEventListener("click", () => {
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number($<HTMLInputElement>("store-qty").value) || 1)));
    cart = quote([...cart, { key: item.key, qty }]).lines.map(({ key, qty: q }) => ({ key, qty: q }));
    save(cart);
    renderCart();
    $("cart-note").textContent = `${item.title} added to your cart.`;
  });
}

function renderCart(): void {
  const q = quote(cart);
  $("cart-lines").innerHTML = q.lines.length
    ? `<ul class="cart-list">${q.lines.map((l) => `<li><div><b>${esc(l.title)}</b><span>${l.qty} × ${gbp(l.unitGbp)} ${l.billing === "monthly" ? "a month" : "once"}</span></div><div class="cart-act"><span class="mono">${gbp(l.totalGbp)}</span><button class="btn btn-sm btn-ghost" type="button" data-remove="${esc(l.key)}" aria-label="Remove ${esc(l.title)}">Remove</button></div></li>`).join("")}</ul>`
    : `<p class="muted">Nothing here yet. Pick something on the left.</p>`;
  $("cart-totals").innerHTML = `<div><dt>Monthly</dt><dd>${gbp(q.monthlyGbp)} / month</dd></div><div><dt>One-off tasks</dt><dd>${gbp(q.onceGbp)}</dd></div><div class="cart-due"><dt>Due today</dt><dd>${gbp(q.dueTodayGbp)}</dd></div>`;
  $<HTMLButtonElement>("cart-checkout").disabled = q.lines.length === 0;
}

export function initStore(): void {
  const groups = [...new Set(CATALOGUE.map((i) => i.group))];
  $("store-pick").innerHTML = `<option value="">Choose an employee, specialist or task…</option>` +
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
    $("cart-note").textContent = "Payments open soon. Your cart is saved on this device, and nothing has been charged.";
  });
  $("task-rule").innerHTML = `<h3>How one-off tasks are billed</h3><ul>${OVERAGE_RULE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="jd-note">Prices are list prices in GBP and may change before launch.</p>`;
  cart = load();
  renderCart();
}
