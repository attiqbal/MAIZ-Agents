// The control center's real numbers. dash.ts draws an example business first; when the client is signed in and the
// API answers, this replaces the overview, team, tasks and energy screens with their own records (GET /api/dashboard).
// Compliance, approvals and finance stay examples until their data exists, and keep their "Example data" tag.
import { api, getToken } from "./api";
import { energyBar, status, tile } from "./dash";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface LiveEmployee { id: string; name: string; templateKey: string; allowance: number; usedToday: number; week: number[]; doneWeek: number; status: "working" | "idle"; doing: string | null }
interface LiveTask { id: string; employeeId: string | null; employeeName: string | null; title: string; column: "planned" | "in_progress" | "waiting" | "done"; runsAt?: string; note?: string; energy?: number }
interface TeamEnergy { pool: number; used: number; left: number; percentUsed: number; leftToday: number; dailyCeiling: number | null; refillsAt: string | null }
interface Live {
  team: LiveEmployee[]; tasks: LiveTask[]; teamEnergy?: TeamEnergy | null;
  totals: { energyToday: number; allowanceToday: number; energyWeek: number; energyMonth: number; queued: number; waitingOnYou: number; inReview: number; doneWeek: number; nextRunLabel: string };
}

const LOOK: Record<string, [abbr: string, cls: string, color: string]> = {
  "finance-manager": ["FM", "av-fm", "#2d7be0"], "marketing-manager": ["MM", "av-mm", "#8a5cf5"], "business-consultant": ["BC", "av-bc", "#e05aa8"],
  "hr-manager": ["HR", "av-hr", "#2bb59a"], "compliance-manager": ["CM", "av-cm", "#d9a23a"], "supply-chain-manager": ["SC", "av-sc", "#6f86d6"], "admin-manager": ["AM", "av-tl", "#8a93b2"],
};
const look = (key: string): [string, string, string] => LOOK[key] ?? ["AI", "av-tl", "#8a93b2"];
const who = (e: LiveEmployee) => `<a class="who-cell desk-a" href="#desk/${esc(e.templateKey)}"><span class="av av-sm ${look(e.templateKey)[1]}" aria-hidden="true">${look(e.templateKey)[0]}</span>${esc(e.name)}</a>`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const COLUMNS: [LiveTask["column"], string][] = [["planned", "Planned"], ["in_progress", "In progress"], ["waiting", "Waiting on you"], ["done", "Done this week"]];

const n = (x: number) => x.toLocaleString("en-GB");
/** When the shared weekly energy refills, in words. */
const refills = (te: TeamEnergy) => te.refillsAt ? `Refills ${new Date(te.refillsAt).toLocaleDateString("en-GB", { weekday: "long" })}` : "For the whole trial";
/** One employee's share of the week's shared energy, as a bar and a percentage. */
const share = (used: number, pool: number) => { const pct = pool > 0 ? Math.min(100, Math.round((used / pool) * 100)) : 0; return `<div class="e-cell"><div class="energy"><i style="width:${pct}%"></i></div><span class="mono">${pct}%</span></div>`; };

function hideExampleTag(screen: string): void {
  document.querySelector(`[data-screen="${screen}"] .eg`)?.remove();
}

function overview(d: Live): void {
  const t = d.totals;
  const inProgress = d.tasks.filter((x) => x.column === "in_progress").length;
  $("need-count").textContent = t.waitingOnYou ? `${t.waitingOnYou} need${t.waitingOnYou === 1 ? "s" : ""} you` : "All clear";
  $("ov-kpis").innerHTML = [
    tile("Needs you", String(t.waitingOnYou), t.waitingOnYou ? "Questions from specialised tasks" : "Nothing is waiting on you", "#work", t.waitingOnYou ? "warn" : ""),
    tile("In quality review", String(t.inReview), "Specialised work MAIZ checks before it starts", "#work"),
    tile("Tasks in progress", String(inProgress), `${t.queued} waiting for the next batch, ${t.doneWeek} done this week`, "#work"),
    d.teamEnergy
      ? tile("Energy this week", `${d.teamEnergy.percentUsed}%`, `Of the team's ${n(d.teamEnergy.pool)}. ${refills(d.teamEnergy)}`, "#usage", d.teamEnergy.percentUsed >= 75 ? "warn" : "")
      : tile("Energy used today", `${t.energyToday} / ${t.allowanceToday}`, t.energyToday >= t.allowanceToday * 0.75 ? "Getting low" : "Plenty left", "#usage"),
    tile("Energy this month", t.energyMonth.toLocaleString(), "Across your whole team", "#usage"),
    tile("Next batch", t.nextRunLabel, `${t.queued} task${t.queued === 1 ? "" : "s"} waiting`, "#work"),
  ].join("");
  const planned = d.tasks.filter((x) => x.column === "planned").slice(0, 4);
  $("ov-next").innerHTML = planned.length
    ? planned.map((x) => `<li>${esc(x.employeeName ?? "")} · ${esc(x.title)}</li>`).join("")
    : `<li class="muted">Nothing is lined up. Ask your team for something with the bar at the top.</li>`;
  hideExampleTag("home");
}

function team(d: Live): void {
  const t = d.totals;
  $("team-kpis").innerHTML = [
    tile("Employees", String(d.team.length), "Includes your free Admin manager"),
    tile("Working now", String(d.team.filter((e) => e.status === "working").length), `${d.team.filter((e) => e.status === "idle").length} idle`),
    tile("Tasks done this week", String(t.doneWeek), "Drafts waiting for your review"),
    d.teamEnergy
      ? tile("Energy left this week", `${100 - d.teamEnergy.percentUsed}%`, `Shared by the whole team. ${refills(d.teamEnergy)}`, "#usage")
      : tile("Energy left today", `${Math.max(0, t.allowanceToday - t.energyToday)} / ${t.allowanceToday}`, "Refills at midnight (UTC)", "#usage"),
  ].join("");
  $("team-table").innerHTML = `<thead><tr><th scope="col">Employee</th><th scope="col">Status</th><th scope="col">Working on</th><th scope="col" class="num">Done this week</th><th scope="col">${d.teamEnergy ? "Share of the week's energy" : "Energy left today"}</th></tr></thead><tbody>` +
    d.team.map((e) => `<tr><td>${who(e)}</td><td>${status(e.status === "working" ? "good" : "idle", e.status === "working" ? "Working" : "Ready")}</td><td>${esc(e.doing ?? "Waiting for your next request")}</td><td class="num">${e.doneWeek}</td><td>${d.teamEnergy ? share(sum(e.week), d.teamEnergy.pool) : energyBar(e.usedToday, Math.max(e.allowance, 1))}</td></tr>`).join("") + "</tbody>";
  hideExampleTag("team");
}

let filter = "all";
function tasks(d: Live): void {
  const render = () => {
    $("task-filter").innerHTML = [["all", "Everyone"], ...d.team.map((e) => [e.id, e.name])]
      .map(([k, label]) => `<button type="button" class="chip" aria-pressed="${k === filter}" data-who="${esc(k!)}">${esc(label!)}</button>`).join("");
    const shown = d.tasks.filter((x) => filter === "all" || x.employeeId === filter);
    $("kan").innerHTML = COLUMNS.map(([col, label]) => {
      const cards = shown.filter((x) => x.column === col);
      const body = cards.map((x) => {
        const note = x.column === "planned" ? `Runs ${x.runsAt ? new Date(x.runsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "with the next batch"}` : x.column === "done" ? `Ready for your review${x.energy ? ` · ${x.energy} energy` : ""}` : x.note ?? "Working on it";
        const l = x.employeeId ? d.team.find((e) => e.id === x.employeeId) : undefined;
        const av = l ? `<span class="av av-sm ${look(l.templateKey)[1]}" title="${esc(l.name)}">${look(l.templateKey)[0]}</span>` : "";
        return `<div class="kcard">${esc(x.title)}<div class="ft">${av}${esc(note)}</div></div>`;
      }).join("");
      return `<div class="kcol"><h2>${label} <span>${cards.length}</span></h2>${body || `<p class="xs muted kempty">Nothing here.</p>`}</div>`;
    }).join("");
  };
  // Drop the example screen's click handler by swapping the node, then listen for our own.
  const old = $("task-filter");
  const fresh = old.cloneNode(false) as HTMLElement;
  old.replaceWith(fresh);
  fresh.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-who]");
    if (b) { filter = b.dataset.who!; render(); $("task-filter").querySelector<HTMLElement>(`[data-who="${CSS.escape(filter)}"]`)?.focus(); }
  });
  render();
  $("cons-table").innerHTML = `<tbody><tr><td class="muted">No consultant passes yet. Add one from the store and it shows here with its days and energy.</td></tr></tbody>`;
  hideExampleTag("work");
}

function usage(d: Live): void {
  const t = d.totals;
  $("usage-kpis").innerHTML = [
    d.teamEnergy
      ? tile("Energy used this week", `${d.teamEnergy.percentUsed}%`, `${n(d.teamEnergy.used)} of ${n(d.teamEnergy.pool)}. ${refills(d.teamEnergy)}`)
      : tile("Energy used today", `${t.energyToday} / ${t.allowanceToday}`, `${t.allowanceToday ? Math.round((t.energyToday / t.allowanceToday) * 100) : 0}% of today's allowance`),
    tile("Energy used, 7 days", t.energyWeek.toLocaleString(), `About ${Math.round(t.energyWeek / 7)} a day`),
    tile("Energy this month", t.energyMonth.toLocaleString(), "Across your whole team"),
    tile("Spend this month", "£0.00", "Nothing is charged yet", "/pricing.html"),
  ].join("");
  $("usage-table").innerHTML = `<thead><tr><th scope="col">Employee</th><th scope="col">Energy left today</th><th scope="col" class="num">Used, 7 days</th></tr></thead><tbody>` +
    d.team.map((e) => `<tr><td>${who(e)}</td><td>${energyBar(e.usedToday, Math.max(e.allowance, 1))}</td><td class="num">${sum(e.week).toLocaleString()}</td></tr>`).join("") + `<tr class="total"><td colspan="2">Total</td><td class="num">${t.energyWeek.toLocaleString()}</td></tr></tbody>`;
  $("bars-legend").innerHTML = d.team.map((e) => `<span><i style="background:${look(e.templateKey)[2]}"></i>${esc(e.name)}</span>`).join("");
  bars(d);
  const allowance = document.querySelector<HTMLElement>('[data-screen="usage"] .panel-h .r');
  if (allowance) allowance.textContent = d.teamEnergy
    ? `This week: ${d.teamEnergy.percentUsed}% of the team's energy used${d.teamEnergy.dailyCeiling ? `, at most ${n(d.teamEnergy.dailyCeiling)} a day` : ""}`
    : `Daily allowance: ${t.allowanceToday.toLocaleString()} across the team`;
  hideExampleTag("usage");
}

function bars(d: Live): void {
  const today = new Date();
  const labels = Array.from({ length: 7 }, (_, i) => { const x = new Date(today); x.setDate(today.getDate() - (6 - i)); return x.toLocaleDateString(undefined, { weekday: "short" }); });
  const dayTotals = labels.map((_, i) => sum(d.team.map((e) => e.week[i] ?? 0)));
  const max = Math.max(50, Math.ceil(Math.max(...dayTotals) / 50) * 50);
  const x0 = 44, right = 690, top = 16, bottom = 150, slot = (right - x0) / 7, bw = 44;
  const y = (v: number) => bottom - ((bottom - top) * v) / max;
  let s = `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" fill="#abaebb">`;
  for (const v of [0, max / 2, max]) s += `<line x1="${x0}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#151e32"/><text x="38" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  labels.forEach((label, i) => {
    let acc = 0;
    const cx = x0 + slot * i + (slot - bw) / 2;
    d.team.forEach((e) => {
      const v = e.week[i] ?? 0;
      if (v > 0) { const y1 = y(acc + v); s += `<rect x="${cx}" y="${y1}" width="${bw}" height="${Math.max(y(acc) - y1 - 1, 0)}" rx="1" fill="${look(e.templateKey)[2]}"><title>${esc(e.name)}: ${v}</title></rect>`; }
      acc += v;
    });
    s += `<text x="${cx + bw / 2}" y="170" text-anchor="middle">${esc(label)}</text>`;
  });
  $("bars").innerHTML = s + "</g>";
}

export async function loadLive(): Promise<void> {
  if (!getToken()) return;
  const r = await api<Live>("/dashboard");
  if (!r.ok || !r.data) return;
  // The top bar counts what needs the client. Approvals (below) is still an example screen, so only real questions count here.
  document.getElementById("need-count")!.textContent = `${r.data.totals.waitingOnYou} need${r.data.totals.waitingOnYou === 1 ? "s" : ""} you`;
  overview(r.data); team(r.data); tasks(r.data); usage(r.data);
}
