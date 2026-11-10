// Dashboards in the control center: overview tiles, employee status, task board, energy and spend,
// and the compliance calendar. The figures are one example business (Kestrel Coffee) kept in this file,
// so every screen tells the same story. Screens show an "Example data" tag when a real owner is signed in.
import { toast } from "./common";
import { initSignOff, proposalCount } from "./signoff-ui";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const gbp = (n: number) => `£${n.toFixed(2)}`;

interface Employee {
  key: string; name: string; short: string; abbr: string; cls: string; color: string;
  skill: "Standard" | "Pro" | "Free"; allowance: number; used: number; week: number[];
  status: "good" | "warn" | "idle"; statusText: string; doing: string; done: number; firstTime: number; price: number;
}

const DAILY = 100;
const EMPLOYEES: Employee[] = [
  { key: "fm", name: "Finance manager", short: "Finance", abbr: "FM", cls: "av-fm", color: "#2d7be0", skill: "Standard", allowance: DAILY, used: 28, week: [40, 55, 30, 62, 20, 15, 28], status: "warn", statusText: "Waiting on you", doing: "October profit and loss, needs your VAT answer", done: 9, firstTime: 89, price: 12.3 },
  { key: "mm", name: "Marketing manager", short: "Marketing", abbr: "MM", cls: "av-mm", color: "#8a5cf5", skill: "Standard", allowance: DAILY, used: 79, week: [70, 90, 96, 85, 40, 30, 79], status: "good", statusText: "Working", doing: "Drafting the November email to subscribers", done: 11, firstTime: 82, price: 12.3 },
  { key: "bc", name: "Business consultant", short: "Consultant", abbr: "BC", cls: "av-bc", color: "#e05aa8", skill: "Standard", allowance: DAILY, used: 45, week: [50, 60, 45, 70, 25, 20, 45], status: "idle", statusText: "Idle", doing: "Finished the supplier cost check. Next: weekly review on Monday", done: 6, firstTime: 83, price: 12.3 },
  { key: "hr", name: "HR manager", short: "HR", abbr: "HR", cls: "av-hr", color: "#2bb59a", skill: "Standard", allowance: DAILY, used: 12, week: [18, 22, 35, 14, 0, 0, 12], status: "good", statusText: "Working", doing: "Drafting your people basics checklist", done: 4, firstTime: 100, price: 12.3 },
  { key: "cm", name: "Compliance manager", short: "Compliance", abbr: "CM", cls: "av-cm", color: "#d9a23a", skill: "Pro", allowance: DAILY, used: 36, week: [30, 44, 52, 38, 10, 8, 36], status: "good", statusText: "Working", doing: "Building your compliance register", done: 5, firstTime: 80, price: 21.4 },
];
const TEAM_DISCOUNT = 0.15;
const usedToday = EMPLOYEES.reduce((n, e) => n + e.used, 0);
const allowanceToday = EMPLOYEES.reduce((n, e) => n + e.allowance, 0);
const monthly = EMPLOYEES.reduce((n, e) => n + e.price, 0) * (1 - TEAM_DISCOUNT);

type Column = "Planned" | "In progress" | "Waiting on you" | "Done this week";
interface Task { title: string; who: string; col: Column; note: string; pct?: number }
const COLUMNS: Column[] = ["Planned", "In progress", "Waiting on you", "Done this week"];
const TASKS: Task[] = [
  { title: "Weekly cash report", who: "fm", col: "Planned", note: "Mon 9:00 · 10 energy reserved" },
  { title: "Competitor price watch", who: "mm", col: "Planned", note: "Mon 10:00 · 8 energy reserved" },
  { title: "Monthly cost review", who: "bc", col: "Planned", note: "1st of the month · 30 energy reserved" },
  { title: "November subscriber email", who: "mm", col: "In progress", note: "6 energy so far", pct: 60 },
  { title: "People basics checklist", who: "hr", col: "In progress", note: "12 energy so far", pct: 45 },
  { title: "Compliance register", who: "cm", col: "In progress", note: "36 energy so far", pct: 70 },
  { title: "October profit and loss", who: "fm", col: "Waiting on you", note: "Needs your VAT answer" },
  { title: "3 autumn blend posts", who: "mm", col: "Waiting on you", note: "Needs your approval" },
  { title: "Supplier cost check", who: "bc", col: "Done this week", note: "Accepted · 30 energy" },
  { title: "Receipts matched (14)", who: "fm", col: "Done this week", note: "Accepted · 7 energy" },
  { title: "Halloween post", who: "mm", col: "Done this week", note: "Redone once · energy returned" },
  { title: "Holiday policy draft", who: "hr", col: "Done this week", note: "Accepted · 9 energy" },
];
const emp = (key: string) => EMPLOYEES.find((e) => e.key === key)!;
const count = (col: Column) => TASKS.filter((t) => t.col === col).length;

type Kind = "Tax" | "Payroll" | "Company" | "Licence";
interface Deadline { inDays: number; title: string; kind: Kind; who: string; state: "action" | "ready" | "track"; note: string; source: string }
const DEADLINES: Deadline[] = [
  { inDays: 5, title: "Pay PAYE and National Insurance", kind: "Payroll", who: "fm", state: "action", note: "£1,180 to pay. Finance has the figures ready for you to pay from your bank.", source: "HMRC" },
  { inDays: 12, title: "Renew employers' liability insurance", kind: "Licence", who: "cm", state: "action", note: "Your insurer's renewal quote is in your inbox. You need to accept it.", source: "Your policy" },
  { inDays: 27, title: "VAT return and payment for the last quarter", kind: "Tax", who: "fm", state: "track", note: "Figures will be ready a week before. Needs October closed first.", source: "HMRC" },
  { inDays: 41, title: "Confirmation statement", kind: "Company", who: "cm", state: "ready", note: "Draft checked against the company register. Ready for you to file.", source: "Companies House" },
  { inDays: 58, title: "Data protection fee renewal", kind: "Licence", who: "cm", state: "track", note: "Renews once a year. A reminder is set for two weeks before.", source: "ICO" },
  { inDays: 80, title: "Annual accounts", kind: "Company", who: "fm", state: "track", note: "Your accountant files these. Finance will prepare the pack.", source: "Companies House" },
];
const STATE: Record<Deadline["state"], [string, string]> = { action: ["warn", "Needs your action"], ready: ["good", "Ready to file"], track: ["info", "On track"] };
const dueDate = (inDays: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + inDays); return d; };
const dayMonth = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** One summary tile. With `href` the whole tile is a link to the screen behind the number. */
function tile(label: string, value: string, note: string, href?: string, tone = ""): string {
  const body = `<span class="l">${esc(label)}</span><span class="v">${esc(value)}</span><span class="dl ${tone}">${esc(note)}</span>`;
  return href ? `<a class="tile-kpi" href="${href}">${body}</a>` : `<div class="tile-kpi">${body}</div>`;
}
const energyBar = (used: number, allowance: number) => {
  const left = allowance - used;
  return `<div class="e-cell"><div class="energy${left / allowance < 0.25 ? " low" : ""}"><i style="width:${Math.round((left / allowance) * 100)}%"></i></div><span class="mono">${left} / ${allowance}</span></div>`;
};
const who = (e: Employee) => `<span class="who-cell"><span class="av av-sm ${e.cls}" aria-hidden="true">${e.abbr}</span>${esc(e.name)}</span>`;
const status = (tone: string, text: string) => `<span class="status ${tone === "idle" ? "" : tone}"><span class="dot"></span>${esc(text)}</span>`;

function renderOverview(): void {
  const next = [...DEADLINES].sort((a, b) => a.inDays - b.inDays)[0]!;
  $("ov-kpis").innerHTML = [
    tile("Needs you", "3", "2 approvals, 1 question", "#approvals", "warn"),
    tile("In quality review", String(proposalCount()), "Specialised work MAIZ checks before it starts", "#work", "warn"),
    tile("Tasks in progress", String(count("In progress")), `${count("Planned")} planned, ${count("Done this week")} done this week`, "#work"),
    tile("Energy used today", `${usedToday} / ${allowanceToday}`, "Marketing is running low", "#usage"),
    tile("Spend this month", gbp(0), `Free trial. Then ${gbp(monthly)} a month`, "#usage"),
    tile("Next deadline", dayMonth(dueDate(next.inDays)), next.title, "#compliance", next.state === "action" ? "warn" : ""),
  ].join("");
  $("ov-next").innerHTML = [
    `<li>Mon 9:00 · Weekly cash report <span class="mono muted">10 reserved</span></li>`,
    `<li>Mon 10:00 · Competitor price watch <span class="mono muted">8 reserved</span></li>`,
    ...DEADLINES.slice(0, 2).map((d) => `<li>${esc(dayMonth(dueDate(d.inDays)))} · ${esc(d.title)}</li>`),
  ].join("");
}

function renderTeam(): void {
  const working = EMPLOYEES.filter((e) => e.status === "good").length;
  const done = EMPLOYEES.reduce((n, e) => n + e.done, 0);
  const first = Math.round(EMPLOYEES.reduce((n, e) => n + e.firstTime * e.done, 0) / done);
  $("team-kpis").innerHTML = [
    tile("Employees", String(EMPLOYEES.length), "Plus your free Admin manager"),
    tile("Working now", String(working), "1 waiting on you, 1 idle"),
    tile("Tasks done this week", String(done), `${first}% accepted first time`),
    tile("Energy left today", `${allowanceToday - usedToday} / ${allowanceToday}`, "Refills at midnight, your time", "#usage"),
  ].join("");
  $("team-table").innerHTML = `<thead><tr><th scope="col">Employee</th><th scope="col">Status</th><th scope="col">Working on</th><th scope="col" class="num">Done</th><th scope="col" class="num">Accepted first time</th><th scope="col">Energy left today</th></tr></thead><tbody>` +
    `<tr><td><span class="who-cell"><span class="av av-sm av-tl" aria-hidden="true">AM</span>Admin manager</span></td><td>${status("good", "Working")}</td><td>Routing requests and writing your daily briefing</td><td class="num">Daily</td><td class="num">–</td><td class="muted">Uses no energy</td></tr>` +
    EMPLOYEES.map((e) => `<tr><td>${who(e)}</td><td>${status(e.status, e.statusText)}</td><td>${esc(e.doing)}</td><td class="num">${e.done}</td><td class="num">${e.firstTime}%</td><td>${energyBar(e.used, e.allowance)}</td></tr>`).join("") + "</tbody>";
}

let taskFilter = "all";
function renderTasks(): void {
  $("task-filter").innerHTML = [["all", "Everyone"], ...EMPLOYEES.map((e) => [e.key, e.short])]
    .map(([k, label]) => `<button type="button" class="chip" aria-pressed="${k === taskFilter}" data-who="${k}">${esc(label!)}</button>`).join("");
  const shown = TASKS.filter((t) => taskFilter === "all" || t.who === taskFilter);
  $("kan").innerHTML = COLUMNS.map((col) => {
    const cards = shown.filter((t) => t.col === col);
    const body = cards.map((t) => {
      const e = emp(t.who);
      return `<div class="kcard">${esc(t.title)}<div class="ft"><span class="av av-sm ${e.cls}" title="${esc(e.name)}">${e.abbr}</span>${esc(t.note)}</div>${t.pct ? `<div class="energy" role="img" aria-label="${t.pct}% done"><i style="width:${t.pct}%"></i></div>` : ""}</div>`;
    }).join("");
    return `<div class="kcol"><h2>${col} <span>${cards.length}</span></h2>${body || `<p class="xs muted kempty">Nothing here.</p>`}</div>`;
  }).join("");
  $("cons-table").innerHTML = `<thead><tr><th scope="col">Consultant</th><th scope="col">Pass</th><th scope="col">Days left</th><th scope="col">Tasks</th><th scope="col">Energy used</th><th scope="col">Next approval</th></tr></thead><tbody>` +
    `<tr><td><span class="who-cell"><span class="av av-sm av-sc" aria-hidden="true">BC</span>Brand and content creator</span> <span class="badge badge-dark">Preview</span></td><td>30 days · £249 once</td><td>18 of 30</td><td>4 of 9 done</td><td><div class="e-cell"><div class="energy"><i style="width:35%"></i></div><span class="mono">3,150 / 9,000</span></div></td><td>Brand kit, first draft</td></tr></tbody>`;
}

function renderUsage(): void {
  const week = EMPLOYEES.reduce((n, e) => n + e.week.reduce((a, b) => a + b, 0), 0);
  $("usage-kpis").innerHTML = [
    tile("Energy used today", `${usedToday} / ${allowanceToday}`, `${Math.round((usedToday / allowanceToday) * 100)}% of today's allowance`),
    tile("Energy used, 7 days", week.toLocaleString(), `About ${Math.round(week / 7)} a day`),
    tile("Spend this month", gbp(0), "Free trial, 5 days left"),
    tile("Monthly price after trial", gbp(monthly), `${EMPLOYEES.length} employees, 15% team discount`, "/pricing.html"),
  ].join("");
  $("usage-table").innerHTML = `<thead><tr><th scope="col">Employee</th><th scope="col">Skill</th><th scope="col">Energy left today</th><th scope="col" class="num">Used, 7 days</th><th scope="col" class="num">List price a month</th></tr></thead><tbody>` +
    EMPLOYEES.map((e) => `<tr><td>${who(e)}</td><td>${e.skill}</td><td>${energyBar(e.used, e.allowance)}</td><td class="num">${e.week.reduce((a, b) => a + b, 0)}</td><td class="num">${gbp(e.price)}</td></tr>`).join("") +
    `<tr class="total"><td colspan="3">Total after 15% team discount</td><td class="num">${week.toLocaleString()}</td><td class="num">${gbp(monthly)}</td></tr></tbody>`;
  $("bars-legend").innerHTML = EMPLOYEES.map((e) => `<span><i style="background:${e.color}"></i>${e.short}</span>`).join("");
  drawBars();
}

function drawBars(): void {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - (6 - i)); return d.toLocaleDateString(undefined, { weekday: "short" }); });
  const x0 = 44, right = 690, top = 16, bottom = 150, max = 300, slot = (right - x0) / 7, bw = 44;
  const y = (v: number) => bottom - ((bottom - top) * v) / max;
  let s = `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" fill="#abaebb">`;
  for (const v of [0, max / 2, max]) s += `<line x1="${x0}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#151e32" ${v === max ? 'stroke-dasharray="4 4"' : ""}/><text x="38" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  days.forEach((label, i) => {
    let acc = 0;
    const cx = x0 + slot * i + (slot - bw) / 2;
    EMPLOYEES.forEach((e, k) => {
      const v = e.week[i]!;
      if (v > 0) { const y1 = y(acc + v); s += `<rect x="${cx}" y="${y1}" width="${bw}" height="${Math.max(y(acc) - y1 - 1, 0)}" rx="${k === EMPLOYEES.length - 1 ? 3 : 1}" fill="${e.color}"><title>${e.short}: ${v}</title></rect>`; }
      acc += v;
    });
    s += `<text x="${cx + bw / 2}" y="170" text-anchor="middle">${esc(label)}</text>`;
  });
  $("bars").innerHTML = s + "</g>";
}

let calFilter = "All";
function renderCalendar(): void {
  const soon = DEADLINES.filter((d) => d.inDays <= 30).length;
  const next = DEADLINES[0]!;
  $("cal-kpis").innerHTML = [
    tile("Next deadline", dayMonth(dueDate(next.inDays)), `${next.title}, in ${next.inDays} days`, undefined, "warn"),
    tile("Due in the next 30 days", String(soon), `${DEADLINES.filter((d) => d.state === "action").length} need your action`),
    tile("Overdue", "0", "Nothing has been missed", undefined, "up"),
    tile("Rules tracked", "14", "Last checked this week"),
  ].join("");
  $("cal-filter").innerHTML = ["All", "Tax", "Payroll", "Company", "Licence"].map((k) => `<button type="button" class="chip" aria-pressed="${k === calFilter}" data-kind="${k}">${k}</button>`).join("");
  const shown = DEADLINES.filter((d) => calFilter === "All" || d.kind === calFilter);
  $("cal-list").innerHTML = shown.map((d) => {
    const date = dueDate(d.inDays);
    const [tone, label] = STATE[d.state];
    const e = emp(d.who);
    return `<li><time class="cal-date" datetime="${date.toISOString().slice(0, 10)}"><b>${date.getDate()}</b>${esc(date.toLocaleDateString(undefined, { month: "short" }))}</time>
      <div class="cal-body"><b>${esc(d.title)}</b><span>${esc(d.note)}</span><span class="cal-meta"><span class="av av-sm ${e.cls}" aria-hidden="true">${e.abbr}</span>${esc(e.name)} · ${d.kind} · Source: ${esc(d.source)}</span></div>
      <div class="cal-side">${status(tone, label)}<span class="xs muted">in ${d.inDays} days</span></div></li>`;
  }).join("") || `<li class="muted">No ${esc(calFilter.toLowerCase())} deadlines coming up.</li>`;
}

export function initDash(): void {
  renderOverview(); renderTeam(); void initSignOff(); renderTasks(); renderUsage(); renderCalendar();
  $("task-filter").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-who]");
    if (b) { taskFilter = b.dataset.who!; renderTasks(); $("task-filter").querySelector<HTMLElement>(`[data-who="${taskFilter}"]`)?.focus(); }
  });
  $("cal-filter").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
    if (b) { calFilter = b.dataset.kind!; renderCalendar(); $("cal-filter").querySelector<HTMLElement>(`[data-kind="${calFilter}"]`)?.focus(); }
  });
  $("new-task").addEventListener("click", () => { $("ask-in").focus(); toast("Type what you need in the ask bar. Your Admin manager turns it into a task."); });
}
