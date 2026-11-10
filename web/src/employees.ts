import "./styles.css";
import { initNav } from "./common";
import { getJobDescription, jdHtml } from "./jd";
import { CUSTOM_SPECIALIST, DEPARTMENTS } from "../../src/modules/workforce/blueprints";
import { BILLING_INFO, getItem, isCoreRole } from "../../src/modules/store/cart";

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

// Org blueprint: every department and role. Opening a role shows its job description.
const bp = document.getElementById("org-blueprint");
if (bp) {
  // Every role is either core (included), recurring (monthly) or a one-off task. Non-core roles go to the cart.
  const roleHtml = (key: string, title: string) => {
    const jd = getJobDescription(key);
    const item = getItem(key);
    const tag = isCoreRole(key) ? `<span class="bp-tag bp-ready">Core · included</span>` : item ? `<span class="bill-tag bill-${item.billing}">${BILLING_INFO[item.billing].label}</span>` : "";
    const buy = item
      ? `<div class="bp-buy"><span class="store-price">${item.billing === "monthly" ? `£${item.priceGbp} / month` : `£${item.priceGbp} once`}</span><button class="btn btn-primary btn-sm" type="button" data-add="${esc(key)}">Add to cart</button><span class="jd-note">${esc(BILLING_INFO[item.billing].note)}</span></div>`
      : `<p class="jd-note">Included in every package. Nothing to add.</p>`;
    return `<details class="jd bp-role"><summary><span>${esc(title)}</span>${tag}</summary>${buy}${jd ? jdHtml(jd) : ""}</details>`;
  };
  bp.innerHTML =
    DEPARTMENTS.map((d) => `<article class="card bp-dept"><h3>${esc(d.name)}</h3><p class="desc">${esc(d.mission)}</p><div class="bp-roles">${d.roles.map((r) => roleHtml(r.key, r.title)).join("")}</div></article>`).join("") +
    `<article class="card card-hi bp-dept bp-custom"><h3>${esc(CUSTOM_SPECIALIST.title)}</h3><p class="desc">${esc(CUSTOM_SPECIALIST.summary)}</p><ol>${CUSTOM_SPECIALIST.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></article>`;
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
