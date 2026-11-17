// The Compliance calendar for a signed-in client: real dates only (staff records, the plan, keys and sign-ins that
// run out) and the dates the client adds themselves (GET /api/overview/calendar). No official deadline is made up:
// MAIZ holds no checked list of them, so the screen says so and lets the client add their own.
// Loaded only when the screen is opened by someone who is logged in.
import { api } from "./api";
import { tile } from "./dash";
import { isBusy, keepFocus, setBusy } from "./keep-focus";

type Kind = "staff" | "plan" | "connection" | "yours";
interface Item {
  id: string; kind: Kind; date: string; title: string; note?: string; source: string; href: string; daysLeft: number; state: "overdue" | "soon" | "later";
  owner?: { key: string; title: string }; own?: { id: string; firstDate: string; repeat: string; remindDays: number };
}
interface Calendar {
  today: string; items: Item[]; done: { id: string; title: string; date: string }[]; canEdit: boolean; staffIncluded: boolean;
  team: { key: string; title: string }[]; choices: { repeat: string[]; remindDays: number[] };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeHref = (h: string): string => (/^#[\w/-]*$/.test(h) || /^\/[\w./-]*$/.test(h) ? h : "#compliance");
const root = (): HTMLElement => document.getElementById("cal-live")!;
const part = (id: string): HTMLElement => document.getElementById(id)!;
const say = (text: string): void => { const s = document.getElementById("cal-status"); if (s) s.textContent = text; };
const at = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
const day = (iso: string): string => at(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const KIND_LABEL: Record<Kind, string> = { staff: "Staff", plan: "Your plan", connection: "Connections", yours: "Added by you" };
const REPEAT_LABEL: Record<string, string> = { none: "Does not repeat", monthly: "Every month", quarterly: "Every 3 months", yearly: "Every year" };
const remindLabel = (n: number): string => (n === 0 ? "On the day only" : `${plural(n, "day", "days")} before, and on the day`);
const GO: Record<string, string> = { "#people": "Open staff records", "#store": "Open the store", "#settings": "Open settings", "#apps": "Open Apps and connections", "/connect-social.html": "Open social accounts" };

let view: Calendar | undefined;
let filter: Kind | "all" = "all";
/** The date being changed in the form ("" adds a new one), and the one being asked about before removal. */
let editing = "";
let removing = "";

function howFar(i: Item): string {
  const n = i.daysLeft;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n > 1) return `In ${n} days`;
  return i.kind === "yours" || i.kind === "staff" ? `Overdue by ${plural(-n, "day", "days")}` : `${plural(-n, "day", "days")} ago`;
}

function ownButtons(i: Item, canEdit: boolean): string {
  if (!i.own || !canEdit) return "";
  if (removing === i.own.id) {
    return `<div class="acts"><span class="small">Remove this date for good?</span><button class="btn btn-sm btn-primary" type="button" data-cal="remove-yes">Yes, remove<span class="sr-only">: ${esc(i.title)}</span></button><button class="btn btn-sm btn-ghost" type="button" data-cal="remove-no">Keep it</button></div>`;
  }
  const name = `<span class="sr-only">: ${esc(i.title)}</span>`;
  return `<div class="acts"><button class="btn btn-sm btn-ghost" type="button" data-cal="done">Done${name}</button><button class="btn btn-sm btn-ghost" type="button" data-cal="edit">Change${name}</button><button class="btn btn-sm btn-quiet" type="button" data-cal="remove">Remove${name}</button></div>`;
}

function itemHtml(i: Item, v: Calendar): string {
  const d = at(i.date);
  const otherYear = i.date.slice(0, 4) !== v.today.slice(0, 4);
  const tone = i.daysLeft < 0 ? "crit" : i.state === "soon" ? "warn" : "";
  const meta = [
    i.kind === "yours" ? esc(i.source) : `From ${esc(i.source)}`,
    i.owner ? `Looked after by your ${esc(i.owner.title)}` : "",
    i.own && i.own.repeat !== "none" ? esc(REPEAT_LABEL[i.own.repeat] ?? "") : "",
    i.own ? `Reminder: ${esc(remindLabel(i.own.remindDays).toLowerCase())}` : "",
  ].filter(Boolean).join(" · ");
  const go = i.kind !== "yours" && GO[i.href] ? `<a class="link small" href="${safeHref(i.href)}">${esc(GO[i.href]!)}<span class="sr-only">: ${esc(i.title)}</span></a>` : "";
  return `<li data-id="${esc(i.own?.id ?? i.id)}"><time class="cal-date" datetime="${esc(i.date)}"><b>${d.getUTCDate()}</b>${esc(d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }))}${otherYear ? `<span class="ovl-year">${esc(i.date.slice(0, 4))}</span>` : ""}</time>
    <div class="cal-body"><b>${esc(i.title)}</b>${i.note ? `<span>${esc(i.note)}</span>` : ""}<span class="cal-meta">${meta}</span>${go}${ownButtons(i, v.canEdit)}</div>
    <div class="cal-side"><span class="status ${tone}"><span class="dot"></span>${esc(howFar(i))}</span></div></li>`;
}

const options = (pairs: [string, string][], chosen: string): string => pairs.map(([value, label]) => `<option value="${esc(value)}"${value === chosen ? " selected" : ""}>${esc(label)}</option>`).join("");

function formHtml(v: Calendar): string {
  if (!v.canEdit) return '<section class="panel"><div class="panel-h"><h2>Dates of your own</h2></div><p class="muted">Only the owner and admins of this business can add or change dates. You can see every date on the list.</p></section>';
  const cur = editing ? v.items.find((i) => i.own?.id === editing) : undefined;
  const repeats = v.choices.repeat.map((r): [string, string] => [r, REPEAT_LABEL[r] ?? r]);
  const reminds = v.choices.remindDays.map((n): [string, string] => [String(n), remindLabel(n)]);
  const people: [string, string][] = [["", "Nobody in particular"], ...v.team.map((e): [string, string] => [e.key, e.title])];
  return `<form class="ag-form ovl-form" id="cal-form" novalidate>
    <h3 id="cal-form-h" tabindex="-1">${cur ? "Change this date" : "Add a date of your own"}</h3>
    <p class="small muted">An insurance renewal, a licence, a tax return, an inspection: anything you must not miss.</p>
    <div class="field"><label for="cal-title">What is it for?</label><input class="input" id="cal-title" name="title" maxlength="120" required autocomplete="off" value="${esc(cur?.title ?? "")}"></div>
    <div class="ag-two">
      <div class="field"><label for="cal-date">${cur && cur.own?.repeat !== "none" ? "First date" : "Date"}</label><input class="input" id="cal-date" name="date" type="date" required min="2000-01-01" max="2100-12-31" value="${esc(cur?.own?.firstDate ?? "")}"></div>
      <div class="field"><label for="cal-repeat">Does it repeat?</label><select class="input" id="cal-repeat" name="repeat">${options(repeats, cur?.own?.repeat ?? "none")}</select></div>
    </div>
    <div class="ag-two">
      <div class="field"><label for="cal-remind">When should we remind you?</label><select class="input" id="cal-remind" name="remindDays">${options(reminds, String(cur?.own?.remindDays ?? 7))}</select></div>
      <div class="field"><label for="cal-who">Who looks after it?</label><select class="input" id="cal-who" name="employee">${options(people, cur?.owner?.key ?? "")}</select></div>
    </div>
    <div class="field"><label for="cal-note">Note (optional)</label><textarea class="input ovl-note-in" id="cal-note" name="note" maxlength="500" rows="2">${esc(cur?.note ?? "")}</textarea></div>
    <p class="small muted">The reminder rings the bell at the top of this page, and reaches your phone if you have turned alerts on in Settings. The employee you pick is told the date, but not your note.</p>
    <p class="status crit wrap" id="cal-err" role="alert" hidden></p>
    <div class="acts"><button class="btn btn-primary btn-sm" type="submit">${cur ? "Save changes" : "Add to calendar"}</button>${cur ? '<button class="btn btn-ghost btn-sm" type="button" data-cal="edit-cancel">Cancel</button>' : ""}</div>
  </form>`;
}

function doneHtml(v: Calendar): string {
  if (!v.done.length) return "";
  const rows = v.done.map((d) => `<li class="ubar ubar-2" data-id="${esc(d.id)}"><span>${esc(d.title)} <span class="muted">· ${esc(day(d.date))}</span></span>${v.canEdit ? `<span class="acts"><button class="btn btn-sm btn-ghost" type="button" data-cal="undo">Not done<span class="sr-only">: ${esc(d.title)}</span></button><button class="btn btn-sm btn-quiet" type="button" data-cal="remove-done">Remove<span class="sr-only">: ${esc(d.title)}</span></button></span>` : ""}</li>`);
  return `<section class="panel" aria-labelledby="cal-done-h"><div class="panel-h"><h2 id="cal-done-h">Done</h2><span class="r">${plural(v.done.length, "date", "dates")} ticked off</span></div><ul class="ovl-done">${rows.join("")}</ul></section>`;
}

function aboutHtml(v: Calendar): string {
  return `<section class="panel" aria-labelledby="cal-about-h"><div class="panel-h"><h2 id="cal-about-h">What is on this calendar</h2></div>
    <ul class="brief"><li>Staff documents, checks and reviews that have a date in your staff records.</li><li>The end of your free trial, or your next monthly payment.</li><li>Keys and sign-ins for your connected apps that run out.</li><li>Every date you add yourself.</li></ul>
    ${v.staffIncluded ? "" : '<p class="small muted">Staff dates are left out for you, because only the owner and admins can open staff records.</p>'}
    <p class="small muted">MAIZ does not add tax, filing or licence deadlines for you. It holds no checked list of official dates for your country, so none is guessed. Add the ones you know, and ask your accountant or adviser if you are unsure. This calendar reminds you; it never files or pays anything, and it is not legal advice.</p></section>`;
}

function kpis(v: Calendar): string {
  const upcoming = v.items.filter((i) => i.daysLeft >= 0);
  const next = upcoming[0];
  const soon = upcoming.filter((i) => i.daysLeft <= 30).length;
  const overdue = v.items.filter((i) => i.daysLeft < 0 && (i.kind === "yours" || i.kind === "staff")).length;
  const yours = v.items.filter((i) => i.kind === "yours").length;
  return `<div class="kpis kpis-4">${[
    tile("Next date", next ? day(next.date).replace(/ \d{4}$/, "") : "None", next ? next.title : "Nothing is coming up"),
    tile("In the next 30 days", String(soon), soon ? "See the list below" : "Nothing is due soon"),
    tile("Overdue", String(overdue), overdue ? "Past their date and not ticked off" : "Nothing is overdue", undefined, overdue ? "warn" : ""),
    tile("Added by you", String(yours), yours ? "Each one has a reminder" : "Add your first one below"),
  ].join("")}</div>`;
}

/** The parts of the screen that never change, drawn once. The form has its own place so typing in it survives a redraw of the list. */
const SKELETON = `<div id="cl-kpis"></div><div class="grid2">
  <section class="panel" aria-labelledby="cal-list-h"><div class="panel-h"><h2 id="cal-list-h" tabindex="-1">Your dates</h2><div class="chips r" id="cl-chips" role="group" aria-label="Show dates by where they come from"></div></div><div id="cl-list"></div></section>
  <div class="stack"><div id="cl-form"></div><div id="cl-side" class="ovl-stack"></div></div></div>`;

function draw(): void {
  const v = view;
  if (!v) return;
  if (!document.getElementById("cl-list")) { part("cl-body").innerHTML = SKELETON; drawForm(); }
  const kinds = (["staff", "plan", "connection", "yours"] as Kind[]).filter((k) => v.items.some((i) => i.kind === k));
  if (filter !== "all" && !kinds.includes(filter)) filter = "all";
  part("cl-kpis").innerHTML = kpis(v);
  part("cl-chips").innerHTML = kinds.length > 1 ? (["all", ...kinds] as (Kind | "all")[]).map((k) => `<button type="button" class="chip" aria-pressed="${k === filter}" data-cal="filter" data-kind="${k}">${k === "all" ? "All" : esc(KIND_LABEL[k])}</button>`).join("") : "";
  const shown = v.items.filter((i) => filter === "all" || i.kind === filter);
  part("cl-list").innerHTML = shown.length ? `<ul class="cal">${shown.map((i) => itemHtml(i, v)).join("")}</ul>` : '<p class="muted">No dates yet. Add your first one with the form on this page.</p>';
  part("cl-side").innerHTML = doneHtml(v) + aboutHtml(v);
}

/** Draws the form afresh: on first load, when a date is picked to change, and after a save. */
function drawForm(): void {
  if (view) part("cl-form").innerHTML = formHtml(view);
}

const redraw = (): void => keepFocus(root(), "[data-id]", "data-cal", draw, document.getElementById("cal-list-h"));

async function load(): Promise<boolean> {
  const r = await api<Calendar>("/overview/calendar");
  if (!r.ok || !r.data) {
    if (!view) part("cl-body").innerHTML = '<div class="ovl-empty"><p>We could not load your calendar just now.</p><p><button class="btn btn-sm btn-ghost" type="button" data-cal="retry">Try again</button></p></div>';
    say("We could not load your calendar just now. Please try again.");
    return false;
  }
  view = r.data;
  redraw();
  return true;
}

/** Sends one change, says what happened, and reads the calendar again. */
async function change(button: HTMLElement | undefined, path: string, payload: unknown, done: string): Promise<boolean> {
  if (button) setBusy(button, true);
  const r = await api<{ error?: string }>(path, { body: payload });
  if (!r.ok) {
    if (button) setBusy(button, false);
    say(r.data?.error ?? "That did not work just now. Please try again.");
    return false;
  }
  await load();
  say(done);
  return true;
}

function onClick(ev: Event): void {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button[data-cal]");
  if (!b || isBusy(b)) return;
  const a = b.dataset.cal!;
  if (a === "retry") { say("Loading…"); void load(); return; }
  if (a === "filter") { filter = (b.dataset.kind as Kind | "all") ?? "all"; draw(); part("cl-chips").querySelector<HTMLElement>(`[data-kind="${filter}"]`)?.focus(); return; }
  if (a === "edit-cancel") { editing = ""; drawForm(); document.getElementById("cal-list-h")?.focus(); return; }
  const id = b.closest<HTMLElement>("[data-id]")?.dataset.id;
  if (!id) return;
  const item = view?.items.find((i) => i.own?.id === id);
  const at_ = `/overview/calendar/dates/${encodeURIComponent(id)}`;
  if (a === "edit") { editing = id; removing = ""; draw(); drawForm(); document.getElementById("cal-title")?.focus(); return; }
  if (a === "remove") { removing = id; redraw(); return; }
  if (a === "remove-no") { removing = ""; redraw(); return; }
  if (a === "remove-yes" || a === "remove-done") { removing = ""; if (editing === id) { editing = ""; drawForm(); } void change(b, `${at_}/remove`, {}, "Removed from your calendar."); return; }
  if (a === "undo") { void change(b, `${at_}/done`, { done: false }, "Put back on your calendar."); return; }
  if (a === "done") void change(b, `${at_}/done`, { done: true }, item?.own?.repeat && item.own.repeat !== "none" ? "Ticked off. It has moved to its next date." : "Ticked off. You can undo this under Done.");
}

async function onSubmit(ev: Event): Promise<void> {
  const f = ev.target as HTMLFormElement;
  if (f.id !== "cal-form") return;
  ev.preventDefault();
  const val = (id: string): string => (document.getElementById(id) as HTMLInputElement).value.trim();
  const err = document.getElementById("cal-err")!;
  const fail = (message: string, field?: string): void => { err.hidden = false; err.textContent = message; if (field) document.getElementById(field)?.focus(); };
  if (!val("cal-title")) { fail("Say what the date is for.", "cal-title"); return; }
  if (!val("cal-date")) { fail("Pick the date.", "cal-date"); return; }
  const submit = f.querySelector<HTMLElement>('button[type="submit"]');
  if (submit && isBusy(submit)) return;
  const payload = { title: val("cal-title"), date: val("cal-date"), repeat: val("cal-repeat"), remindDays: Number(val("cal-remind")), employee: val("cal-who"), note: val("cal-note") };
  if (submit) setBusy(submit, true);
  const wasEditing = editing;
  const r = await api<{ error?: string }>(wasEditing ? `/overview/calendar/dates/${encodeURIComponent(wasEditing)}` : "/overview/calendar/dates", { body: payload });
  if (!r.ok) {
    if (submit) setBusy(submit, false);
    fail(r.data?.error ?? "That could not be saved just now. Please try again.");
    return;
  }
  editing = "";
  await load();
  drawForm();
  say(wasEditing ? "Saved." : "Added to your calendar.");
  // Focus goes back to the top of the form, ready for the next date.
  document.getElementById("cal-form-h")?.focus();
}

let wired = false;
/** Called each time the calendar is opened by a signed-in client. */
export function showCalendar(): void {
  const el = document.getElementById("cal-live");
  if (!el) return;
  if (!wired) {
    wired = true;
    document.querySelector('[data-screen="compliance"] .eg')?.remove();
    const intro = document.querySelector('[data-screen="compliance"] .page-h p');
    if (intro) intro.textContent = "Real dates from your staff records, your plan and your connections, and the dates you add yourself.";
    el.innerHTML = '<p class="ovl-status" role="status" aria-live="polite" id="cal-status"></p><div id="cl-body" class="ovl-stack"><p class="small muted">Loading your calendar…</p></div>';
    el.hidden = false;
    el.addEventListener("click", onClick);
    el.addEventListener("submit", (e) => void onSubmit(e));
  }
  void load();
}
