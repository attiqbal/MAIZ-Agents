// "What this employee can use" on an employee's desk: what is ready (with what it costs), what is missing and where to
// connect it, and what MAIZ is still switching on. Read from the same list the employee itself is given.
import { api, getToken } from "./api";

interface Summary {
  ready: { name: string; detail: string; cost: string; freshness?: string }[];
  missing: { name: string; detail: string; action: { label: string; href: string } }[];
  waiting: string[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Links come from the server, but only ever to a screen inside the app. */
const inApp = (href: string): string => (/^#[\w/-]{1,40}$/.test(href) ? href : "#apps");

function draw(s: Summary): string {
  const ready = s.ready.map((r) => `<div class="ubar ubar-2"><span>${esc(r.name)}${r.freshness ? ` <span class="small muted">${esc(r.freshness)}</span>` : ""}<span class="small muted res-d">${esc(r.detail)}</span></span><span class="mono">${esc(r.cost)}</span></div>`).join("");
  const missing = s.missing.map((m) => `<div class="need"><b>${esc(m.name)}</b><span class="d">${esc(m.detail)}</span><div class="acts"><a class="btn btn-sm btn-primary" href="${esc(inApp(m.action.href))}">${esc(m.action.label)}</a></div></div>`).join("");
  const waiting = s.waiting.length ? `<p class="small muted">MAIZ is still switching on: ${esc(s.waiting.join(", "))}.</p>` : "";
  return `<div class="panel-h"><h2 id="desk-uses-h">What this employee can use</h2></div>
    ${ready || '<p class="small muted">Nothing yet. Fill in your business profile to start.</p>'}
    ${missing ? `<h3 class="small res-h">Would help, not connected yet</h3><div class="needs">${missing}</div>` : ""}${waiting}`;
}

/** Fills the panel for one employee. Without a login (the demo) the panel stays hidden: it never shows made-up lists. */
export async function showResources(panel: HTMLElement, templateKey: string): Promise<void> {
  panel.hidden = true;
  if (!getToken()) return;
  const r = await api<Summary>(`/resources/employee/${encodeURIComponent(templateKey)}`);
  if (!r.ok || !r.data) return;
  panel.innerHTML = draw(r.data);
  panel.hidden = false;
}
