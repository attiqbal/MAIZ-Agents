import "./styles.css";
import { initNav } from "./common";
import { getJobDescription, jdHtml } from "./jd";
import { CUSTOM_SPECIALIST, DEPARTMENTS } from "../../src/modules/workforce/blueprints";

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
  const roleHtml = (key: string, title: string, ready: boolean) => {
    const jd = getJobDescription(key);
    const tag = ready ? `<span class="bp-tag bp-ready">In the store</span>` : `<span class="bp-tag">Custom specialist</span>`;
    return `<details class="jd bp-role"><summary><span>${esc(title)}</span>${tag}</summary>${jd ? jdHtml(jd) : ""}</details>`;
  };
  bp.innerHTML =
    DEPARTMENTS.map((d) => `<article class="card bp-dept"><h3>${esc(d.name)}</h3><p class="desc">${esc(d.mission)}</p><div class="bp-roles">${d.roles.map((r) => roleHtml(r.key, r.title, Boolean(r.jd))).join("")}</div></article>`).join("") +
    `<article class="card card-hi bp-dept bp-custom"><h3>${esc(CUSTOM_SPECIALIST.title)}</h3><p class="desc">${esc(CUSTOM_SPECIALIST.summary)}</p><ol>${CUSTOM_SPECIALIST.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></article>`;
}
