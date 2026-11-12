import "./styles.css";
import { initNav } from "./common";
import { getJobDescription, jdHtml } from "./jd";
import { CUSTOM_SPECIALIST, DEPARTMENTS } from "../../src/modules/workforce/blueprints";
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

// Add-on roles: one compact card per role that is not in the package, filterable by department.
// Package roles are already on the cards above, so they are left out here.
const bp = document.getElementById("org-blueprint");
const bpFilter = document.getElementById("bp-filter");
if (bp) {
  const card = (dept: string, key: string, title: string, purpose: string) => {
    const item = getItem(key);
    const price = item ? (item.billing === "monthly" ? `£${item.priceGbp} / month` : `£${item.priceGbp} once`) : "Priced for you";
    const action = item
      ? `<button class="btn btn-primary btn-sm" type="button" data-add="${esc(key)}">Add to cart</button>`
      : `<a class="btn btn-ghost btn-sm" href="/app.html#store">Ask for it</a>`;
    return `<article class="addon"><span class="addon-dept">${esc(dept)}</span><h3>${esc(title)}</h3><p>${esc(purpose)}</p><div class="addon-foot"><span class="store-price" data-price-key="${esc(key)}">${price}</span>${action}</div></article>`;
  };
  bp.innerHTML = DEPARTMENTS.map((d) => {
    const roles = d.roles.filter((r) => !isCoreRole(r.key));
    if (!roles.length) return "";
    return `<div class="addon-group" data-dept="${esc(d.key)}">${roles.map((r) => card(d.name, r.key, r.title, r.purpose)).join("")}</div>`;
  }).join("") +
    `<div class="addon-group" data-dept="custom"><article class="addon addon-custom"><span class="addon-dept">Not listed?</span><h3>${esc(CUSTOM_SPECIALIST.title)}</h3><p>Describe the job. Your Admin manager designs it, MAIZ checks it and sets the price, then you decide.</p><div class="addon-foot"><a class="btn btn-ghost btn-sm" href="/app.html#store">Describe a role</a></div></article></div>`;
  if (bpFilter) {
    const depts = DEPARTMENTS.filter((d) => d.roles.some((r) => !isCoreRole(r.key)));
    bpFilter.innerHTML = [`<button type="button" class="chip" data-f="all" aria-pressed="true">All</button>`, ...depts.map((d) => `<button type="button" class="chip" data-f="${esc(d.key)}" aria-pressed="false">${esc(d.name)}</button>`)].join("");
    bpFilter.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-f]");
      if (!b) return;
      const f = b.dataset.f ?? "all";
      bpFilter.querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      bp.querySelectorAll<HTMLElement>(".addon-group").forEach((g) => { g.hidden = f !== "all" && g.dataset.dept !== f && g.dataset.dept !== "custom"; });
    });
  }
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
