import "./styles.css";
import { initNav } from "./common";
import { getJobDescription, jdHtml } from "./jd";
import { specialistHires } from "../../src/modules/workforce/blueprints";
import { getItem, isCoreRole } from "../../src/modules/store/cart";

initNav();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Each employee card gets its full job description, from the same data the employee works to.
document.querySelectorAll<HTMLElement>("[data-jd]").forEach((card) => {
  const jd = getJobDescription(card.dataset.jd ?? "");
  if (!jd) return;
  const d = document.createElement("details");
  d.className = "jd";
  d.innerHTML = `<summary>Full job description</summary>${jdHtml(jd)}`;
  card.append(d);
});

// Specialist hires: 12 cards, one per department. Each merges several narrower jobs, listed on
// the card so the owner sees everything it covers. Package employees are on the cards above.
const bp = document.getElementById("org-blueprint");
if (bp) {
  bp.innerHTML = specialistHires().map(({ role }) => {
    const item = getItem(role.key);
    const price = item ? `£${item.priceGbp} / month` : "Priced for you";
    const action = item
      ? `<button class="btn btn-primary btn-sm" type="button" data-add="${esc(role.key)}" aria-label="Add ${esc(role.title)} to cart">Add to cart</button>`
      : `<a class="btn btn-ghost btn-sm" href="/app.html#store">Ask for it</a>`;
    const covers = (role.covers ?? []).map(esc).join(", ");
    return `<article class="addon"><h3>${esc(role.title)}</h3><p>${esc(role.purpose)}</p><p class="addon-covers"><span>Covers</span> ${covers}</p><div class="addon-foot"><span class="store-price" data-price-key="${esc(role.key)}">${price}</span>${action}</div></article>`;
  }).join("");
}

bp?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-add]");
  if (!btn?.dataset.add) return;
  const key = btn.dataset.add;
  void import("./store").then((m) => {
    if (m.addToCart(key)) btn.textContent = "Added to cart";
  });
});

// Store: one picker for everything that can be added, and a cart that splits monthly from one-off.
import("./store").then((m) => m.initStore());
