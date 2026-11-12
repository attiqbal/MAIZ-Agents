// Department tabs in the control centre. Each department has one header (its employee, status and
// energy) and its own tab strip: an Overview (the employee's dashboard) plus the department's working
// screens, such as Finance's books or HR's staff records. The rail highlights the department for
// every tab inside it.
import { DESK } from "./desk-data";
import { withHr } from "./desk";

interface DeptTab { label: string; hash: string }
export interface Dept { key: string; name: string; employee: string; tabs: DeptTab[] }

export const DEPTS: Dept[] = [
  { key: "admin", name: "Admin", employee: "admin-manager", tabs: [{ label: "Overview", hash: "desk/admin-manager" }, { label: "Setup", hash: "setup" }] },
  { key: "finance", name: "Finance", employee: "finance-manager", tabs: [{ label: "Overview", hash: "desk/finance-manager" }, { label: "Books and cash", hash: "finance" }] },
  { key: "marketing", name: "Marketing", employee: "marketing-manager", tabs: [{ label: "Overview", hash: "desk/marketing-manager" }] },
  { key: "consultant", name: "Business consultant", employee: "business-consultant", tabs: [{ label: "Overview", hash: "desk/business-consultant" }] },
  { key: "hr", name: "HR", employee: "hr-manager", tabs: [{ label: "Overview", hash: "desk/hr-manager" }, { label: "Staff records", hash: "people" }] },
  { key: "compliance", name: "Compliance", employee: "compliance-manager", tabs: [{ label: "Overview", hash: "desk/compliance-manager" }, { label: "Deadline calendar", hash: "compliance" }] },
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The department a route belongs to, or undefined for screens outside any department. */
export function deptFor(hash: string): Dept | undefined {
  return DEPTS.find((d) => d.tabs.some((t) => t.hash === hash));
}

/** Show the department header and tabs for this route, or hide them. Returns the department shown. */
let lastHash = "";
let listening = false;
export function renderDeptBar(hash: string): Dept | undefined {
  lastHash = hash;
  if (!listening) {
    listening = true;
    // HR's status comes from the live HR desk, so redraw when it changes.
    document.addEventListener("hr:updated", () => { if (deptFor(lastHash)?.key === "hr") renderDeptBar(lastHash); });
  }
  const bar = document.getElementById("dept-bar");
  if (!bar) return undefined;
  const d = deptFor(hash);
  document.getElementById("main")?.classList.toggle("in-dept", Boolean(d));
  bar.toggleAttribute("hidden", !d);
  if (!d) { bar.innerHTML = ""; return undefined; }
  const base = DESK.find((x) => x.key === d.employee);
  if (!base) return d;
  const e = withHr(base);
  const tone = e.status === "idle" ? "" : e.status;
  const tabs = d.tabs.length > 1
    ? `<nav class="dept-tabs" aria-label="${esc(d.name)} department">${d.tabs.map((t) => `<a href="#${t.hash}"${t.hash === hash ? ' aria-current="page"' : ""}>${esc(t.label)}</a>`).join("")}</nav>`
    : "";
  bar.innerHTML = `
    <div class="dept-head">
      <span class="av av-xl ${e.cls}" aria-hidden="true">${e.abbr}</span>
      <div class="dept-id">
        <span class="dept-eyebrow">Department</span>
        <p class="dept-name">${esc(d.name)}</p>
        <p class="dept-run">Run by your ${esc(e.name)}. ${esc(e.purpose)}</p>
      </div>
      <div class="dept-meta">
        <span class="status ${tone}"><span class="dot"></span>${esc(e.statusText)}</span>
        <div class="dept-energy"><div class="e-lab"><span>This week's team energy</span><span class="mono">${e.energyPct}%</span></div><div class="energy" role="img" aria-label="${e.energyPct}% of this week's team energy"><i style="width:${Math.min(100, e.energyPct)}%"></i></div></div>
      </div>
    </div>${tabs}`;
  return d;
}
