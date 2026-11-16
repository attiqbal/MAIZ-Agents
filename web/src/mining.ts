// Market data (#mining): the Data mining agent's own screen. The owner types a topic, ticks where to look, sees
// what it uses in energy before anything runs, and then decides which employees may use what was found.
// Everything shown here came from public pages, so it is escaped and links are only ever https.
import { api, getToken } from "./api";
import { toast } from "./common";
import { isBusy, keepFocus, setBusy } from "./keep-focus";

interface MineSource { id: string; label: string; gives: string; energy: number; paid: boolean; available: boolean; reason?: string }
type SourceStatus = "ok" | "empty" | "unavailable" | "failed";
interface SetHeader { id: string; topic: string; createdAt: string; summary: string; energyUsed: number; sharedWith: string[]; sources: { id: string; label: string; status: SourceStatus; count: number; note?: string }[] }
interface SetItem { title: string; snippet: string; url: string; source: string; at?: string }
interface SetFigure { label: string; value: string; date?: string; detail?: string; url?: string }
interface Dataset extends Omit<SetHeader, "sources"> { sources: { id: string; label: string; status: SourceStatus; note?: string; items: SetItem[]; figures?: SetFigure[] }[] }
interface Overview { hired: boolean; sources: MineSource[]; datasets: SetHeader[]; employees: { key: string; title: string }[]; limits: { maxSources: number; runsPerHour: number; maxDatasets: number; minTopic: number; maxTopic: number } }
interface Quote { topic: string; total: number; unavailable: string[] }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Only a plain https address is ever made into a link. */
const safeUrl = (u: string | undefined): string => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "");
const day = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
const energy = (n: number): string => `${n.toLocaleString("en-GB")} energy`;
const STATUS_WORDS: Record<SourceStatus, string> = { ok: "found", empty: "nothing found", unavailable: "not available", failed: "could not be read" };
const DEFAULT_SOURCES = ["news"];

let view: Overview | undefined;
let quote: Quote | undefined;
let asked: { topic: string; sources: string[] } | undefined;
let busy = false;
const opened = new Map<string, Dataset>();
let sharing = "";
let removing = "";
let wired = false;

const body = (): HTMLElement => document.getElementById("mine-body")!;

function introHtml(signedIn: boolean): string {
  return `<section class="panel mine-intro" aria-labelledby="mine-intro-h">
    <div class="who"><span class="av av-dm" aria-hidden="true">DM</span><div><h2 id="mine-intro-h">Data mining agent</h2><span class="small muted">An extra employee you can add to your team</span></div></div>
    <p>Give it a topic, such as a product, a competitor or a place. It gathers what is public about it, saves it as a small dataset, and hands it to the employees you choose, so your Marketing manager or Business consultant works from real findings and not from guesses.</p>
    <ul class="brief">
      <li>News coverage, public conversations, videos, company records and economy figures for your country.</li>
      <li>You see what a search uses in energy before it starts, and you only pay for sources that find something.</li>
      <li>It reads public information only. It never logs in anywhere and never posts.</li>
    </ul>
    <div class="acts">${signedIn ? '<a class="btn btn-primary btn-sm" href="#store">Hire from the store</a>' : '<a class="btn btn-primary btn-sm" href="/onboarding.html">Start free trial</a>'}</div>
  </section>`;
}

function sourceHtml(s: MineSource): string {
  return `<label class="mine-opt"><input type="checkbox" name="src" value="${esc(s.id)}"${DEFAULT_SOURCES.includes(s.id) ? " checked" : ""}>
    <span><b>${esc(s.label)}</b><span class="small muted">${esc(s.gives)}</span><span class="small mine-cost">${esc(`${energy(s.energy)}${s.paid ? " · paid service, so it uses more" : ""}`)}</span></span></label>`;
}

function formHtml(v: Overview): string {
  // Places MAIZ has not switched on yet are named in one line, not offered as boxes that cannot be ticked.
  const ready = v.sources.filter((s) => s.available);
  const later = v.sources.filter((s) => !s.available);
  if (!ready.length) return `<section class="panel"><div class="panel-h"><h2>New search</h2></div><p class="all-clear">No places to search are switched on yet. MAIZ has been told, and nothing is charged.</p></section>`;
  return `<section class="panel" aria-labelledby="mine-new-h">
    <div class="panel-h"><h2 id="mine-new-h">New search</h2><span class="r">Up to ${v.limits.maxSources} places a search</span></div>
    <form id="mine-form" class="mine-form" novalidate>
      <div class="field"><label for="mine-topic">What do you want to know about?</label>
        <input id="mine-topic" class="input" maxlength="${v.limits.maxTopic}" autocomplete="off" placeholder="For example: oat milk prices, or coffee carts in Leeds"></div>
      <fieldset class="mine-src"><legend class="label">Where should I look?</legend><div class="mine-opts">${ready.map(sourceHtml).join("")}</div></fieldset>
      ${later.length ? `<p class="small muted mine-later">Not switched on yet: ${esc(later.map((s) => s.label).join(", "))}.</p>` : ""}
      <p class="small muted" id="mine-total" aria-live="polite"></p>
      <div class="acts"><button class="btn btn-primary btn-sm" type="submit" id="mine-go">See what it uses</button></div>
      <div id="mine-quote" class="mine-quote" role="status" aria-live="polite"></div>
    </form>
  </section>`;
}

function setHtml(h: SetHeader, v: Overview): string {
  const titleOf = (key: string) => v.employees.find((e) => e.key === key)?.title ?? key;
  const found = h.sources.map((s) => `${esc(s.label)} (${s.status === "ok" ? s.count : STATUS_WORDS[s.status]})`).join(", ");
  const shared = h.sharedWith.length ? `Shared with ${esc(h.sharedWith.map(titleOf).join(", "))}.` : "Not shared yet, so only the Data mining agent uses it.";
  const full = opened.get(h.id);
  const shareBox = sharing === h.id
    ? `<form class="mine-share" data-share="${esc(h.id)}"><fieldset><legend class="label">Who may use this dataset?</legend>${v.employees.length
      ? v.employees.map((e) => `<label class="sf-check"><input type="checkbox" name="emp" value="${esc(e.key)}"${h.sharedWith.includes(e.key) ? " checked" : ""}> ${esc(e.title)}</label>`).join("")
      : '<p class="small muted">There is nobody else on your team yet.</p>'}</fieldset>
      <div class="acts"><button class="btn btn-primary btn-sm" type="submit">Save</button><button class="btn btn-ghost btn-sm" type="button" data-mine="share-close">Cancel</button></div></form>`
    : "";
  const removeBox = removing === h.id
    ? `<div class="acts mine-sure"><span class="small">Remove this dataset for good? Employees it was shared with stop seeing it.</span><button class="btn btn-sm btn-primary" type="button" data-mine="remove-yes">Yes, remove</button><button class="btn btn-sm btn-ghost" type="button" data-mine="remove-no">Keep it</button></div>`
    : "";
  return `<li class="mine-set" data-id="${esc(h.id)}">
    <div class="mine-set-h"><h3>${esc(h.topic)}</h3><span class="small muted">${esc(day(h.createdAt))} · used ${esc(energy(h.energyUsed))}</span></div>
    <p class="mine-sum">${esc(h.summary)}</p>
    <p class="small muted">Looked in: ${found}.</p>
    <p class="small muted">${shared}</p>
    <div class="acts"><button class="btn btn-sm btn-ghost" type="button" data-mine="open" aria-expanded="${full ? "true" : "false"}">${full ? "Hide what was found" : "See what was found"}</button><button class="btn btn-sm btn-ghost" type="button" data-mine="share">Share with employees</button><button class="btn btn-sm btn-ghost" type="button" data-mine="remove">Remove</button></div>
    ${shareBox}${removeBox}${full ? detailHtml(full) : ""}
  </li>`;
}

function detailHtml(d: Dataset): string {
  const sources = d.sources.map((s) => {
    const items = s.items.map((i) => {
      const url = safeUrl(i.url);
      const title = url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : `<b>${esc(i.title)}</b>`;
      return `<li>${title}<span class="small muted">${esc([i.source, i.at ? day(i.at) : ""].filter(Boolean).join(" · "))}</span>${i.snippet ? `<span class="small">${esc(i.snippet)}</span>` : ""}</li>`;
    }).join("");
    const figures = (s.figures ?? []).map((f) => `<div class="ubar ubar-2"><span>${esc(f.label)}${f.detail || f.date ? ` <span class="small muted">${esc([f.detail, f.date].filter(Boolean).join(" · "))}</span>` : ""}</span><span class="mono">${esc(f.value)}</span></div>`).join("");
    const empty = !items && !figures ? `<p class="small muted">${esc(s.note ?? (s.status === "ok" ? "Nothing to show." : `This source ${STATUS_WORDS[s.status]}.`))}</p>` : "";
    return `<section class="mine-found"><h4>${esc(s.label)}</h4>${figures}${items ? `<ul class="mine-items">${items}</ul>` : ""}${empty}</section>`;
  }).join("");
  return `<div class="mine-detail">${sources}<p class="small muted">Gathered from public pages on ${esc(day(d.createdAt))}. Check anything important at the source before you rely on it.</p></div>`;
}

function setsHtml(v: Overview): string {
  const list = v.datasets.length
    ? `<ul class="mine-sets">${v.datasets.map((h) => setHtml(h, v)).join("")}</ul>`
    : '<p class="all-clear">No datasets yet. Run a search above and what it finds is kept here.</p>';
  return `<section class="panel" aria-labelledby="mine-sets-h"><div class="panel-h"><h2 id="mine-sets-h">Your datasets</h2><span class="r">${v.datasets.length} of ${v.limits.maxDatasets} kept</span></div>${list}</section>`;
}

/** Redraws only the saved datasets, so a half-typed search is not lost. */
function paintSets(): void {
  const box = document.getElementById("mine-sets");
  const v = view;
  if (box && v) keepFocus(box, ".mine-set", "data-mine", () => { box.innerHTML = setsHtml(v); }, document.getElementById("mine-sets-h"));
}

function paint(): void {
  if (!view || !view.hired) { body().innerHTML = introHtml(Boolean(getToken())); return; }
  body().innerHTML = `${formHtml(view)}<div id="mine-sets">${setsHtml(view)}</div>`;
  showTotal();
}

const chosen = (): string[] => Array.from(body().querySelectorAll<HTMLInputElement>('input[name="src"]:checked')).map((i) => i.value);

function showTotal(): void {
  const line = document.getElementById("mine-total");
  if (!line || !view) return;
  const ids = chosen();
  const total = view.sources.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.energy, 0);
  line.textContent = ids.length ? `${ids.length} ${ids.length === 1 ? "place" : "places"} chosen, up to ${energy(total)}. You only pay for the ones that find something.` : "Tick at least one place to look.";
}

function say(html: string): void {
  const box = document.getElementById("mine-quote");
  if (box) box.innerHTML = html;
}

async function run(confirmed: boolean): Promise<void> {
  if (busy || !asked) return;
  busy = true;
  const go = document.getElementById("mine-go") as HTMLButtonElement | null;
  if (go) setBusy(go, true);
  if (confirmed) say('<p class="status live wrap"><span class="dot"></span>Searching now. This can take up to a minute.</p>');
  const r = await api<{ dataset?: Dataset; quote?: Quote; error?: string }>("/mining/run", { body: confirmed && quote ? { ...asked, confirm: true, confirmEnergy: quote.total } : asked });
  busy = false;
  if (go) setBusy(go, false);
  if (r.status === 409 && r.data?.quote) {
    quote = r.data.quote;
    say(`<p>${esc(r.data.error ?? `This uses up to ${energy(quote.total)}.`)}</p><div class="acts"><button class="btn btn-primary btn-sm" type="button" data-mine="confirm">Confirm and start</button><button class="btn btn-ghost btn-sm" type="button" data-mine="cancel">Not now</button></div>`);
    document.querySelector<HTMLButtonElement>('[data-mine="confirm"]')?.focus();
    return;
  }
  quote = undefined;
  if (!r.ok || !r.data?.dataset) {
    say(`<p class="status warn wrap"><span class="dot"></span>${esc(r.data?.error ?? "The search could not start just now. Please try again.")}</p>`);
    // The Confirm button is gone by now, so focus goes back to the button that starts a search.
    if (confirmed) go?.focus();
    return;
  }
  const made = r.data.dataset;
  opened.set(made.id, made);
  asked = undefined;
  toast(`Dataset saved. It used ${energy(made.energyUsed)}.`);
  await load();
  const row = document.querySelector<HTMLElement>(`.mine-set[data-id="${CSS.escape(made.id)}"]`);
  row?.scrollIntoView({ block: "start", behavior: "smooth" });
  row?.querySelector<HTMLElement>('[data-mine="open"]')?.focus({ preventScroll: true });
}

async function onClick(ev: Event): Promise<void> {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-mine]");
  if (!b || !view || isBusy(b)) return;
  const act = b.dataset.mine;
  if (act === "confirm") { await run(true); return; }
  if (act === "cancel") { quote = undefined; say(""); return; }
  const id = b.closest<HTMLElement>(".mine-set")?.dataset.id;
  if (!id) return;
  if (act === "open") {
    if (opened.has(id)) opened.delete(id);
    else {
      setBusy(b, true);
      const r = await api<{ dataset?: Dataset }>(`/mining/datasets/${encodeURIComponent(id)}`);
      if (!r.ok || !r.data?.dataset) { setBusy(b, false); toast("That dataset could not be opened just now."); return; }
      opened.set(id, r.data.dataset);
    }
  } else if (act === "share") { sharing = sharing === id ? "" : id; removing = ""; }
  else if (act === "share-close") sharing = "";
  else if (act === "remove") { removing = removing === id ? "" : id; sharing = ""; }
  else if (act === "remove-no") removing = "";
  else if (act === "remove-yes") {
    setBusy(b, true);
    const r = await api<{ datasets?: SetHeader[] }>(`/mining/datasets/${encodeURIComponent(id)}/remove`, { body: {} });
    removing = "";
    if (!r.ok || !r.data?.datasets) { toast("That dataset could not be removed just now."); paintSets(); return; }
    opened.delete(id);
    view = { ...view, datasets: r.data.datasets };
    toast("Dataset removed");
  }
  paintSets();
}

async function onSubmit(ev: Event): Promise<void> {
  const form = ev.target as HTMLFormElement;
  if (form.id === "mine-form") {
    ev.preventDefault();
    if (!view) return;
    const topic = (document.getElementById("mine-topic") as HTMLInputElement).value.trim();
    const sources = chosen();
    if (topic.length < view.limits.minTopic) { say('<p class="status warn wrap"><span class="dot"></span>Type what you want to know about first.</p>'); document.getElementById("mine-topic")?.focus(); return; }
    if (!sources.length) { say('<p class="status warn wrap"><span class="dot"></span>Tick at least one place to look.</p>'); return; }
    if (sources.length > view.limits.maxSources) { say(`<p class="status warn wrap"><span class="dot"></span>Choose up to ${view.limits.maxSources} places for one search.</p>`); return; }
    asked = { topic, sources };
    quote = undefined;
    await run(false);
    return;
  }
  const id = form.dataset.share;
  if (!id || !view) return;
  ev.preventDefault();
  const employees = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="emp"]:checked')).map((i) => i.value);
  const r = await api<{ dataset?: Dataset; error?: string }>(`/mining/datasets/${encodeURIComponent(id)}/share`, { body: { employees } });
  if (!r.ok || !r.data?.dataset) { toast(r.data?.error ?? "That could not be saved just now."); return; }
  const saved = r.data.dataset;
  if (opened.has(id)) opened.set(id, saved);
  view = { ...view, datasets: view.datasets.map((h) => (h.id === id ? { ...h, sharedWith: saved.sharedWith } : h)) };
  sharing = "";
  toast(employees.length ? "Shared. They will use it from their next piece of work." : "Sharing stopped for this dataset");
  paintSets();
}

async function load(): Promise<void> {
  const r = getToken() ? await api<Overview>("/mining") : undefined;
  view = r?.ok ? r.data : undefined;
  paint();
}

/** Called each time the screen is opened. */
export function showMining(): void {
  if (!wired) {
    wired = true;
    body().addEventListener("click", (e) => void onClick(e));
    body().addEventListener("submit", (e) => void onSubmit(e));
    body().addEventListener("change", (e) => { if ((e.target as HTMLInputElement).name === "src") showTotal(); });
  }
  void load();
}
