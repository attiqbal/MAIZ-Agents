// One AI employee's dashboard (#desk/<employee>): the same seven blocks for every employee.
// Header, what it needs from you, four key numbers, its main working view, work now and done,
// what is coming up, and what it can see with three one-tap requests.
import { DESK, type DeskEmployee, type DeskRow } from "./desk-data";
import { peopleSnapshot } from "./people";
import { toast } from "./common";
import { deptFor } from "./dept";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const tag = (tone: string, text: string) => `<span class="status ${tone}"><span class="dot"></span>${esc(text)}</span>`;
const SEV_TONE = { critical: "crit", high: "warn", medium: "info", low: "" } as const;

/** The HR manager's numbers and main panel come from the HR desk itself, so the two never disagree. */
export function withHr(e: DeskEmployee): DeskEmployee {
  if (e.key !== "hr-manager") return e;
  const v = peopleSnapshot();
  if (!v) return e;
  const s = v.summary;
  const urgent = s.actions.filter((a) => a.severity === "critical" || a.severity === "high");
  const rows: DeskRow[] = s.actions.slice(0, 6).map((a) => ({ label: a.staffName, value: a.title, tone: (SEV_TONE[a.severity] || undefined) as DeskRow["tone"] }));
  return {
    ...e,
    status: urgent.length ? "warn" : "good",
    statusText: urgent.length ? "Waiting on you" : "Working",
    needs: urgent.slice(0, 3).map((a) => ({ title: `${a.staffName}: ${a.title}`, detail: a.detail, action: "Open staff records", href: "#people" })),
    kpis: [
      { label: "Staff", value: String(s.headcount), note: `${s.starting} starting, ${s.leaving} leaving`, source: "You told us" },
      { label: "Records complete", value: `${s.recordsComplete}%`, note: "Required documents in date", source: "You told us", ...(s.recordsComplete < 80 ? { tone: "warn" as const } : {}) },
      { label: "Expiring in 60 days", value: String(s.expiringSoon), note: s.expired ? `${s.expired} already expired` : "Nothing expired", source: "You told us", ...(s.expired ? { tone: "warn" as const } : {}) },
      { label: "Off today", value: String(s.offToday), note: v.offToday.map((o) => o.name.split(" ")[0]).join(", ") || "Everyone is in", source: "You told us" },
    ],
    main: { ...e.main, rows: rows.length ? rows : [{ label: "Everyone", value: "Records complete and in date", tone: "good" }] },
  };
}

function render(key: string): void {
  const base = DESK.find((d) => d.key === key) ?? DESK[0]!;
  const e = withHr(base);
  const dept = deptFor(`desk/${e.key}`);
  $("desk-title").textContent = dept ? `${dept.name} overview` : e.name;
  $("desk-sub").textContent = dept ? `What needs you, the key numbers, and what your ${e.name} is working on.` : e.purpose;
  $("desk-pick").innerHTML = DESK.map((d) => `<a class="chip" href="#desk/${d.key}"${d.key === e.key ? ' aria-current="page"' : ""}>${esc(d.name)}</a>`).join("");
  const statusTone = e.status === "idle" ? "" : e.status;
  const needs = e.needs.length
    ? e.needs.map((n) => `<div class="need hi"><span class="k"><span class="av av-sm ${e.cls}" aria-hidden="true">${e.abbr}</span>${esc(e.name)}</span><b>${esc(n.title)}</b><span class="d">${esc(n.detail)}</span><div class="acts">${n.href ? `<a class="btn btn-sm btn-primary" href="${esc(n.href)}">${esc(n.action)}</a>` : `<button type="button" class="btn btn-sm btn-primary" data-toast="${esc(n.toast ?? "Done")}">${esc(n.action)}</button>`}</div></div>`).join("")
    : `<p class="all-clear">Nothing needs you from ${esc(e.name)} right now.</p>`;
  const kpis = e.kpis.map((k) => `<div class="tile-kpi"><span class="l">${esc(k.label)}</span><span class="v">${esc(k.value)}</span><span class="dl ${k.tone ?? ""}">${esc(k.note)}</span><span class="desk-src">${esc(k.source)}</span></div>`).join("");
  const rows = e.main.rows.map((r) => `<div class="ubar ubar-2"><span>${esc(r.label)}${r.note ? ` <span class="small muted">${esc(r.note)}</span>` : ""}</span>${r.tone ? tag(r.tone, r.value) : `<span class="mono">${esc(r.value)}</span>`}</div>`).join("");
  const list = (xs: { title: string; note: string; pct?: number }[], empty: string) => xs.length
    ? `<ul class="hr-mini">${xs.map((x) => `<li><b>${esc(x.title)}</b> <span class="small muted">${esc(x.note)}</span>${x.pct !== undefined ? `<div class="energy" role="img" aria-label="${x.pct}% done"><i style="width:${x.pct}%"></i></div>` : ""}</li>`).join("")}</ul>`
    : `<p class="small muted">${esc(empty)}</p>`;
  $("desk-body").innerHTML = `
    <section class="panel desk-head" aria-label="${esc(e.name)} at a glance">
      <div class="who"><span class="av ${e.cls}" aria-hidden="true">${e.abbr}</span><div><b>${esc(e.name)}</b><span class="small muted">${esc(e.plan)}</span></div></div>
      ${tag(statusTone, e.statusText)}
      <div class="desk-energy"><div class="e-lab"><span>Share of this week's team energy</span><span class="mono">${e.energyPct}%</span></div><div class="energy"><i style="width:${Math.min(100, e.energyPct)}%"></i></div></div>
    </section>
    <section class="panel" aria-labelledby="desk-needs-h"><div class="panel-h"><h2 id="desk-needs-h">Needs you</h2></div><div class="needs">${needs}</div></section>
    ${kpis ? `<div class="kpis kpis-4" aria-label="Key numbers">${kpis}</div>` : ""}
    <div class="grid2">
      <section class="panel" aria-labelledby="desk-main-h"><div class="panel-h"><h2 id="desk-main-h">${esc(e.main.title)}</h2>${e.main.link ? `<a class="r link" href="${esc(e.main.link.href)}">${esc(e.main.link.label)}</a>` : ""}</div>${rows}${e.main.note ? `<p class="small muted">${esc(e.main.note)}</p>` : ""}</section>
      <div class="desk-side">
        <section class="panel" aria-labelledby="desk-now-h"><div class="panel-h"><h2 id="desk-now-h">Working on now</h2></div>${list(e.working, "Nothing running. Ask for something below.")}</section>
        <section class="panel" aria-labelledby="desk-done-h"><div class="panel-h"><h2 id="desk-done-h">Done this week</h2></div>${list(e.done, "Nothing finished yet this week.")}</section>
      </div>
    </div>
    <div class="grid2">
      <section class="panel" aria-labelledby="desk-next-h"><div class="panel-h"><h2 id="desk-next-h">Coming up</h2></div><ul class="brief">${e.coming.map((c) => `<li><b>${esc(c.when)}</b> · ${esc(c.title)}</li>`).join("")}</ul></section>
      <section class="panel" aria-labelledby="desk-ask-h"><div class="panel-h"><h2 id="desk-ask-h">What I can see, and ask me</h2></div>
        <p class="small muted">Reads: ${esc(e.sees.join(", "))}. Nothing leaves your business without your approval.</p>
        <div class="chips">${e.ask.map((q) => `<button type="button" class="chip" data-ask="${esc(`${e.askAs}: ${q}`)}">${esc(q)}</button>`).join("")}</div></section>
    </div>`;
}

let current = "";
export function showDesk(key: string): void {
  current = key;
  render(key);
}

export function initDesk(): void {
  document.addEventListener("hr:updated", () => { if (current) render(current); });
  // One tap puts the request in the ask bar, addressed to this employee, ready to send or edit.
  $("desk-body").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-ask]");
    if (!b) return;
    const input = document.getElementById("ask-in") as HTMLInputElement | null;
    if (!input) return;
    input.value = b.dataset.ask ?? "";
    input.focus();
    toast("Request ready in the ask bar. Press Enter to send.");
  });
}
