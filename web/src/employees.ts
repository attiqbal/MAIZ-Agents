import "./styles.css";
import { initNav } from "./common";
import { getJobDescription, jdHtml } from "./jd";
import { CUSTOM_SPECIALIST, DEPARTMENTS } from "../../src/modules/workforce/blueprints";
import { OVERAGE_RULE, TASK_ROLES } from "../../src/modules/workforce/task-roles";

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

// Task-based hires, grouped by category, each with its price, allowance and job description.
const tasks = document.getElementById("task-roles");
if (tasks) {
  const categories = [...new Set(TASK_ROLES.map((r) => r.category))];
  tasks.innerHTML =
    categories.map((c) => `<h3 class="task-cat">${esc(c)}</h3><div class="task-grid">${TASK_ROLES.filter((r) => r.category === c).map((r) => {
      const jd = getJobDescription(r.key);
      return `<article class="card task-card"><h4>${esc(r.title)}</h4><p class="desc">${esc(r.purpose)}</p><p class="task-price"><b>£${r.fixedGbp}</b> fixed<span>${r.includedEnergy.toLocaleString("en-GB")} energy included · ${esc(r.turnaround)}</span></p>${jd ? `<details class="jd"><summary>Scope and job description</summary>${jdHtml(jd, 5)}</details>` : ""}</article>`;
    }).join("")}</div>`).join("") +
    `<div class="card card-flat task-rule"><h3>If a task needs more energy</h3><ul>${OVERAGE_RULE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="jd-note">Prices are list prices in GBP and may change before launch.</p></div>`;
}
