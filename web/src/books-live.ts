// Books and cash for a signed-in client: only figures a connected app sent or the client's own books hold, each
// with the app and the period it came from (GET /api/overview/books). Nothing is worked out here that could pass
// for accounting advice: no bank figure, no profit of our own, no forecast. Where there is no real figure the
// screen says what would show and where to connect it. Loaded only when the screen is opened by someone logged in.
import { api } from "./api";
import { tile } from "./dash";

interface Money { moneyIn: number; tax: number; tips: number; refunds: number; fees: number; transactions: number }
interface Source extends Money { connectionId: string; app: string; currency: string; daysWithFigures: number; firstDate: string; lastDate: string; waiting: number }
interface DayRow { date: string; currency: string; moneyIn: number; refunds: number; fees: number; tips: number; transactions: number; apps: string[] }
interface Books {
  period: { from: string; to: string; days: number };
  apps: { id: string; app: string; category: string; brings: string[]; problem: boolean; lastUpdatedAt?: string }[];
  sales: { sources: Source[]; days: DayRow[]; totals: (Money & { currency: string })[] };
  payroll: { app: string; payDate: string; currency: string; gross: number; net: number; employerCosts: number; headcount: number; inBooks: boolean }[];
  accounts: { app: string; month: string; currency: string; income: number; costOfSales: number; expenses: number; reportedProfit?: number }[];
  ledger: { opened: boolean; currency: string; entries: number; fromApps: number; lastEntryDate?: string; lines: { code: string; name: string; type: "income" | "expense"; amount: number }[]; waiting: number };
  check?: { date: string; ranAt: string; entriesChecked: number; ok: boolean; problems: number; warnings: number };
}

const PERIODS = [7, 30, 90];
/** Days listed before the table offers the rest. */
const DAYS_SHOWN = 14;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const body = (): HTMLElement => document.getElementById("books-body")!;
const say = (text: string): void => { const s = document.getElementById("books-status"); if (s) s.textContent = text; };
const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const day = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const month = (ym: string): string => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** Pence (or cents) as money in its own currency. A currency code the browser does not know is shown as written. */
function money(minor: number, currency: string): string {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100); }
  catch { return `${(minor / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`; }
}

let days = 30;
let view: Books | undefined;
let allDays = false;

const lastDays = (): string => `last ${view?.period.days ?? days} days`;
const num = (label: string, value: string): string => `<td class="num" data-label="${esc(label)}">${esc(value)}</td>`;
const cell = (label: string, value: string): string => `<td data-label="${esc(label)}">${esc(value)}</td>`;
const table = (caption: string, heads: string[], rows: string[]): string =>
  `<div class="tbl-wrap"><table class="tbl tbl-stack ovl-tbl"><caption class="sr-only">${esc(caption)}</caption><thead><tr>${heads.map((h, i) => `<th scope="col"${i > 0 && h.startsWith("#") ? ' class="num"' : ""}>${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

function salesHtml(v: Books): string {
  const sellers = v.apps.filter((a) => a.brings.includes("sales"));
  if (!sellers.length) {
    return `<div class="ovl-empty"><p>No till, card payment or online shop app is connected yet.</p><p class="small muted">Once one is connected, each day's takings, refunds and fees show here with the name of the app they came from. Your team only reads them.</p><p><a class="btn btn-sm btn-primary" href="#apps">Open Apps and connections</a></p></div>`;
  }
  const names = listOf(sellers.map((a) => a.app));
  if (!v.sales.sources.length) {
    return `<div class="ovl-empty"><p>${esc(names)} ${sellers.length === 1 ? "is" : "are"} connected, but no takings arrived for the ${esc(lastDays())}.</p><p class="small muted">Try a longer period above, or open Apps and connections to fetch the latest figures.</p><p><a class="btn btn-sm btn-ghost" href="#apps">Open Apps and connections</a></p></div>`;
  }
  const from = `From ${listOf([...new Set(v.sales.sources.map((s) => s.app))])}, ${lastDays()}`;
  const tiles = v.sales.totals.map((t) => `<div class="kpis kpis-4">${[
    tile("Takings", money(t.moneyIn, t.currency), from),
    tile("Refunds", money(t.refunds, t.currency), from),
    tile("Fees the app kept", money(t.fees, t.currency), from),
    tile("Number of sales", t.transactions.toLocaleString("en-GB"), from),
  ].join("")}</div>`).join("");
  const byApp = table("Takings by app", ["App", "#Takings", "#Sales tax inside takings", "#Tips", "#Refunds", "#Fees", "#Sales", "Days covered"], v.sales.sources.map((s) =>
    `<tr><td><b>${esc(s.app)}</b>${s.waiting ? `<br><span class="small muted">${plural(s.waiting, "day is", "days are")} not in your books yet</span>` : ""}</td>${num("Takings", money(s.moneyIn, s.currency))}${num("Sales tax inside takings", money(s.tax, s.currency))}${num("Tips", money(s.tips, s.currency))}${num("Refunds", money(s.refunds, s.currency))}${num("Fees", money(s.fees, s.currency))}${num("Sales", s.transactions.toLocaleString("en-GB"))}${cell("Days covered", s.firstDate === s.lastDate ? day(s.firstDate) : `${plural(s.daysWithFigures, "day", "days")}, ${day(s.firstDate)} to ${day(s.lastDate)}`)}</tr>`));
  const shown = allDays ? v.sales.days : v.sales.days.slice(0, DAYS_SHOWN);
  const byDay = table("Takings by day", ["Day", "#Takings", "#Refunds", "#Fees", "#Sales", "From"], shown.map((d) =>
    `<tr><td><b>${esc(day(d.date))}</b></td>${num("Takings", money(d.moneyIn, d.currency))}${num("Refunds", money(d.refunds, d.currency))}${num("Fees", money(d.fees, d.currency))}${num("Sales", d.transactions.toLocaleString("en-GB"))}${cell("From", listOf(d.apps))}</tr>`));
  const more = v.sales.days.length > DAYS_SHOWN ? `<p><button class="btn btn-sm btn-ghost" type="button" data-books="days" aria-expanded="${allDays}">${allDays ? `Show the latest ${DAYS_SHOWN} days only` : `Show all ${v.sales.days.length} days`}</button></p>` : "";
  return `${tiles}<h3 class="ag-h">By app</h3>${byApp}<h3 class="ag-h">By day, newest first</h3>${byDay}${more}
    <p class="small muted">These are each app's own totals. Takings include sales tax and leave out tips. Nothing has been taken off or added up across apps for you, and two currencies are never added together.</p>`;
}

function payrollHtml(v: Books): string {
  if (!v.payroll.length) return "";
  const rows = v.payroll.map((p) => `<tr><td><b>${esc(day(p.payDate))}</b></td>${num("Total pay before tax", money(p.gross, p.currency))}${num("Take-home pay", money(p.net, p.currency))}${num("Employer's own costs", money(p.employerCosts, p.currency))}${num("People paid", String(p.headcount))}${cell("From", p.app)}${cell("In your books", p.inBooks ? "Yes" : "Not yet")}</tr>`);
  return `<section class="panel" aria-labelledby="bk-pay-h"><div class="panel-h"><h2 id="bk-pay-h">Pay runs</h2><span class="r">From your payroll app, ${esc(lastDays())}</span></div>
    ${table("Pay runs", ["Pay day", "#Total pay before tax", "#Take-home pay", "#Employer's own costs", "#People paid", "From", "In your books"], rows)}
    <p class="small muted">Totals only. Nobody's own pay is shown here.</p></section>`;
}

function accountsHtml(v: Books): string {
  if (!v.accounts.length) return "";
  const anyProfit = v.accounts.some((a) => a.reportedProfit !== undefined);
  const rows = v.accounts.map((a) => `<tr><td><b>${esc(month(a.month))}</b></td>${num("Income", money(a.income, a.currency))}${num("Cost of sales", money(a.costOfSales, a.currency))}${num("Other costs", money(a.expenses, a.currency))}${anyProfit ? num("Profit as the app reported it", a.reportedProfit === undefined ? "Not reported" : money(a.reportedProfit, a.currency)) : ""}${cell("From", a.app)}</tr>`);
  return `<section class="panel" aria-labelledby="bk-acc-h"><div class="panel-h"><h2 id="bk-acc-h">Your own accounts, month by month</h2><span class="r">Read only</span></div>
    ${table("Monthly figures from your accounting app", ["Month", "#Income", "#Cost of sales", "#Other costs", ...(anyProfit ? ["#Profit as the app reported it"] : []), "From"], rows)}
    <p class="small muted">These are your accounting app's own figures, repeated here as it reported them. MAIZ has not worked any of them out.</p></section>`;
}

function ledgerHtml(v: Books): string {
  const l = v.ledger;
  const waiting = l.waiting ? `<p class="status warn wrap"><span class="dot"></span><span>${plural(l.waiting, "set of figures from your apps is", "sets of figures from your apps are")} waiting. They go into your books only when you say so. <a class="link" href="#apps">Add them on Apps and connections</a></span></p>` : "";
  const range = `${day(v.period.from)} to ${day(v.period.to)}`;
  if (!l.lines.length) {
    return `<section class="panel" aria-labelledby="bk-led-h"><div class="panel-h"><h2 id="bk-led-h">Recorded in your books</h2><span class="r">${esc(range)}</span></div>
      <p class="muted">Nothing was recorded in your books for the ${esc(lastDays())}${l.lastEntryDate ? `. The latest entry is dated ${esc(day(l.lastEntryDate))}` : ""}.</p>${waiting}
      ${waiting ? "" : '<p class="small muted">Figures from a connected till, payments or payroll app can be added to your books from Apps and connections.</p>'}</section>`;
  }
  const rows = l.lines.map((x) => `<tr><td><b>${esc(x.name)}</b></td>${cell("Kind", x.type === "income" ? "Money in" : "Cost")}${num("Recorded", money(x.amount, l.currency))}</tr>`);
  return `<section class="panel" aria-labelledby="bk-led-h"><div class="panel-h"><h2 id="bk-led-h">Recorded in your books</h2><span class="r">${esc(range)}</span></div>
    ${table("Amounts recorded in your books by account", ["Account", "Kind", "#Recorded"], rows)}
    <p class="small muted">From ${plural(l.entries, "entry", "entries")} in your books for the ${esc(lastDays())}${l.fromApps ? `, ${l.fromApps === l.entries ? "all" : l.fromApps} of them from your connected apps` : ""}. These are the amounts recorded against each account. They are not added up into a profit here.</p>${waiting}</section>`;
}

function checkHtml(v: Books): string {
  const c = v.check;
  if (!c) return "";
  const found = [c.problems ? plural(c.problems, "problem", "problems") : "", c.warnings ? plural(c.warnings, "thing to look at", "things to look at") : ""].filter(Boolean);
  const text = c.ok && !found.length ? `Checked on ${day(c.date)}: ${plural(c.entriesChecked, "entry", "entries")}, no problems found.`
    : `Checked on ${day(c.date)}: ${plural(c.entriesChecked, "entry", "entries")}, ${listOf(found)} found. Nothing in your books was changed.${c.problems ? " The MAIZ team has been told." : ""}`;
  return `<section class="panel" aria-labelledby="bk-chk-h"><div class="panel-h"><h2 id="bk-chk-h">Nightly check of your books</h2></div>
    <p class="status ${c.problems ? "warn" : "good"} wrap"><span class="dot"></span><span>${esc(text)}</span></p>
    <p class="small muted">Every night your books are checked against themselves and against the figures your apps sent. The check only reads; it never changes anything.</p></section>`;
}

function appsHtml(v: Books): string {
  if (!v.apps.length) return "";
  const rows = v.apps.map((a) => `<div class="ubar ubar-2"><span>${esc(a.app)}${a.problem ? ' <span class="status warn"><span class="dot"></span>Needs a look</span>' : ""}</span><span class="small muted">${a.lastUpdatedAt ? `Last fetched ${esc(new Date(a.lastUpdatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}` : "Connected"}</span></div>`);
  return `<section class="panel" aria-labelledby="bk-apps-h"><div class="panel-h"><h2 id="bk-apps-h">Where these figures come from</h2><a class="r link" href="#apps">Apps and connections</a></div>${rows.join("")}</section>`;
}

function draw(): void {
  const v = view;
  if (!v) return;
  const chips = PERIODS.map((p) => `<button type="button" class="chip" aria-pressed="${p === v.period.days}" data-books="period" data-days="${p}">Last ${p} days</button>`).join("");
  body().innerHTML = `<div class="chips" role="group" aria-label="Period to show">${chips}</div>
    <section class="panel" aria-labelledby="bk-in-h"><div class="panel-h"><h2 id="bk-in-h">Money in from your apps</h2><span class="r">${esc(day(v.period.from))} to ${esc(day(v.period.to))}</span></div>${salesHtml(v)}</section>
    ${payrollHtml(v)}${accountsHtml(v)}${ledgerHtml(v)}${checkHtml(v)}${appsHtml(v)}
    <p class="small muted ovl-note">Not shown here: your bank balance, payouts to your bank and money owed. No connected app sends those to MAIZ, so they are left out and never guessed. For tax and accounting decisions, please ask your accountant.</p>`;
}

async function load(announce = false): Promise<void> {
  const r = await api<Books & { error?: string }>(`/overview/books?days=${days}`);
  if (!r.ok || !r.data) {
    if (!view) body().innerHTML = '<div class="ovl-empty"><p>We could not load your figures just now.</p><p><button class="btn btn-sm btn-ghost" type="button" data-books="retry">Try again</button></p></div>';
    say(r.data?.error ?? "We could not load your figures just now. Please try again.");
    return;
  }
  view = r.data;
  const focused = document.activeElement instanceof HTMLElement && body().contains(document.activeElement) ? document.activeElement.dataset : undefined;
  draw();
  // The chip or button that was pressed is drawn again, so focus is put back on it.
  if (focused?.books === "period") body().querySelector<HTMLElement>(`[data-books="period"][data-days="${view.period.days}"]`)?.focus();
  else if (focused?.books) body().querySelector<HTMLElement>(`[data-books="${focused.books}"]`)?.focus();
  if (announce) say(`Showing the ${lastDays()}.`);
}

function onClick(ev: Event): void {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button[data-books]");
  if (!b) return;
  if (b.dataset.books === "period") { days = Number(b.dataset.days) || 30; allDays = false; say("Loading…"); void load(true); }
  else if (b.dataset.books === "retry") { say("Loading…"); void load(true); }
  else if (b.dataset.books === "days") { allDays = !allDays; draw(); body().querySelector<HTMLElement>('[data-books="days"]')?.focus(); }
}

let wired = false;
/** Called each time Books and cash is opened by a signed-in client. */
export function showBooks(): void {
  const el = document.getElementById("books-live");
  if (!el) return;
  if (!wired) {
    wired = true;
    document.querySelector('[data-screen="finance"] .eg')?.remove();
    const intro = document.querySelector('[data-screen="finance"] .page-h p');
    if (intro) intro.textContent = "Figures your connected apps sent and what is recorded in your books. Every figure says where it came from.";
    el.innerHTML = '<p class="ovl-status" role="status" aria-live="polite" id="books-status"></p><div id="books-body" class="ovl-stack"><p class="small muted">Loading your figures…</p></div>';
    el.hidden = false;
    el.addEventListener("click", onClick);
  }
  void load();
}
