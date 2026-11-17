// Connections (owner-connections.html): everything the site and the owner's AI team connect to, on one page that
// fits a screen. A list on the left (a list you tap into on a phone) groups every service as Critical, Must have or
// Optional, with what needs the owner first. On the right only the selected service opens: what it is for, how it is
// doing, its steps, its saved details (never a secret), and Change, Test and Disconnect. The page draws whatever the
// server lists and knows no service by name, so new connectors appear here without a change to this file.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { setBusy, isBusy } from "./keep-focus";
import { CATALOG } from "../../src/modules/connections/catalog";
import { modeOf, tierOf, TIER_ORDER, type Tier } from "../../src/modules/connections/tiers";
import { OWNER_SPECIALISTS } from "../../src/modules/promoter/owner-team";
import { detailHtml, listHtml, matchesFilter, matchesQuery, shortTitle, sorted, summaryHtml, type Conn, type DetailUi, type Filter, type Person } from "./owner-connections-view";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface View { connections: Conn[]; persistent: boolean }

/** Who asks for each connection: the owner's own specialists, and the decisions desk (the owner's inbox). */
const PEOPLE: Record<string, Person> = {
  ...Object.fromEntries(OWNER_SPECIALISTS.map((s) => [s.key, { name: s.key === "promotion-agent" ? "Promotion agent" : "Community growth manager", avatar: s.avatar, initials: s.key === "promotion-agent" ? "PA" : "CG" }])),
  decisions: { name: "Your decisions desk", avatar: "av-tl", initials: "DD" },
};

const FILTERS: [Filter, string][] = [["all", "All"], ["needs", "Needs you"], ["working", "Working"], ["waiting", "Waiting for approval"], ["manual", "Cannot be connected"]];

let view: View = { connections: [], persistent: true };
let live = false;
let query = "";
let filter: Filter = "all";
let editing = new Set<string>();
let confirming = false;
let drafts: Record<string, string> = {};
let shownKey: string | undefined;
let openTiers: Set<Tier> | undefined;

const DEMO: View = {
  persistent: true,
  connections: CATALOG.map((c) => ({
    key: c.key, title: c.title, summary: c.summary, group: c.group, usedBy: [...c.usedBy], editable: c.editable,
    tier: tierOf(c).tier, tierWhy: tierOf(c).why, mode: modeOf(c), status: "not_connected" as const, source: "none" as const,
    statusText: "Not connected yet.", missing: c.fields.filter((f) => f.required).map((f) => f.label), canTest: true,
    fields: c.fields.map((f) => ({ ...f, set: false })), guide: [...c.guide], clientsSee: c.clientsSee,
    copies: c.copies?.map((x) => ({ label: x.label, value: `${location.origin}${x.path}` })),
    webhook: c.key === "whatsapp" ? { callbackUrl: `${location.origin}/api/whatsapp/webhook` } : undefined,
  })),
};

// ------------------------------------------------------------ remembered ticks (this browser only)
const TICKS = "maiz.connSteps";
const readTicks = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(TICKS) ?? "{}") ?? {}; } catch { return {}; } };
const writeTick = (id: string, on: boolean): void => {
  try { const t = readTicks(); if (on) t[id] = true; else delete t[id]; localStorage.setItem(TICKS, JSON.stringify(t)); } catch { /* storage blocked: ticks just are not remembered */ }
};

// ------------------------------------------------------------ what is selected

const hashKey = (): string | undefined => { const m = /^#c-(.+)$/.exec(location.hash); try { return m ? decodeURIComponent(m[1]!) : undefined; } catch { return undefined; } };
const find = (key: string | undefined): Conn | undefined => view.connections.find((c) => c.key === key);
/** The service in the right-hand side: the one in the address, else the first that needs the owner. */
function current(): Conn | undefined {
  const asked = find(hashKey());
  if (asked) return asked;
  const all = sorted(view.connections);
  return all.find((c) => matchesFilter(c, "needs")) ?? all[0];
}
const isShown = (c: Conn): boolean => matchesFilter(c, filter) && matchesQuery(c, query);

const announce = (text: string): void => { $("cxm-live").textContent = text; };
const msg = (text: string): void => { announce(text); const el = document.querySelector<HTMLElement>(".cxm-card [id^='m-']"); if (el) el.textContent = text; };

function ui(): DetailUi { return { editing, confirm: confirming, drafts, ticks: readTicks(), people: PEOPLE }; }

/** Remembers which control has focus, so a redraw can give it back. */
function focusKey(): string | undefined {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !$("cxm-detail").contains(a)) return undefined;
  if (a.id) return `#${CSS.escape(a.id)}`;
  const d = Array.from(a.attributes).find((x) => x.name.startsWith("data-"));
  return d ? `[${d.name}="${CSS.escape(d.value)}"]` : undefined;
}

function paintDetail(): void {
  const c = current();
  const box = $("cxm-detail");
  const back = focusKey();
  box.innerHTML = c ? detailHtml(c, ui()) : `<div class="panel"><p>No services are listed.</p></div>`;
  if (!back) return;
  const again = box.querySelector<HTMLElement>(back) ?? box.querySelector<HTMLElement>("h2[tabindex]");
  again?.focus({ preventScroll: true });
}

function paintList(): void {
  const c = current();
  const filtering = filter !== "all" || query.trim() !== "";
  openTiers ??= new Set(TIER_ORDER.filter((t) => view.connections.some((x) => x.tier === t && matchesFilter(x, "needs"))));
  if (c) openTiers.add(c.tier);
  const open = filtering ? new Set(TIER_ORDER) : openTiers;
  $("cxm-list").innerHTML = listHtml(view.connections, isShown, hashKey() ? c?.key : undefined, open);
  $("cxm-filters").querySelectorAll<HTMLElement>("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
}

function paintSummary(): void {
  $("cx-progress").innerHTML = summaryHtml(view.connections);
  $("cx-temp").hidden = !live || view.persistent;
}

function paint(): void {
  const c = current();
  if (c?.key !== shownKey) { editing = new Set(); confirming = false; drafts = {}; shownKey = c?.key; }
  $("cxm").dataset.view = hashKey() && c ? "detail" : "list";
  paintSummary();
  paintList();
  paintDetail();
}

/** The address changed (a link in the list, the summary, another page, or Back). */
function onSelect(moveFocus: boolean): void {
  paint();
  const c = find(hashKey());
  if (c) {
    announce(`Showing ${shortTitle(c)}`);
    if (moveFocus) $("cxm-detail").querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    $("cxm-detail").scrollIntoView({ block: "start" });
  } else if (location.hash === "#services" && moveFocus) {
    ($("cxm-list").querySelector<HTMLElement>("[aria-current]") ?? $("cxm-search")).focus({ preventScroll: true });
    $("cxm").scrollIntoView({ block: "start" });
  }
}

// ------------------------------------------------------------ talking to the server

/** New data from the server: the list and the selected service are drawn again, keeping what was half-typed. */
function setView(v: View): void { view = v; paint(); }

async function call(path: string, init: { method?: string; body?: unknown }, busy: string): Promise<{ ok: boolean; data?: any }> {
  if (!live) { toast("This is example data. Log in as the platform owner to connect for real."); return { ok: false }; }
  msg(busy);
  const r = await api<View & { error?: string; message?: string }>(path, init);
  if (r.status === 0) { msg("The server could not be reached. Nothing was changed."); return { ok: false }; }
  if (!r.ok) { msg(r.data?.error ?? "That did not work. Nothing was changed."); return { ok: false, data: r.data }; }
  if (r.data?.connections) setView(r.data);
  return { ok: true, data: r.data };
}

const selectedKey = (): string | undefined => current()?.key;

async function save(form: HTMLFormElement): Promise<void> {
  const key = form.dataset.form!;
  const fields: Record<string, string> = {};
  form.querySelectorAll<HTMLInputElement>("input[name]").forEach((i) => { fields[i.name] = i.value; });
  const r = await call(`/owner/connections/${encodeURIComponent(key)}`, { method: "PUT", body: { fields } }, "Saving…");
  if (!r.ok) return;
  editing = new Set(); drafts = {}; paint();
  const c = find(key);
  msg(c?.status === "connected" ? "Saved. Now press Test connection." : `Saved. Still needed: ${c?.missing.join(", ")}.`);
}

async function runTest(btn: HTMLElement): Promise<void> {
  const key = selectedKey();
  if (!key || isBusy(btn)) return;
  setBusy(btn, true);
  await call(`/owner/connections/${encodeURIComponent(key)}/test`, { method: "POST", body: {} }, "Testing with a harmless read…");
  const c = find(key);
  if (c?.lastTest) msg(c.lastTest.ok ? `Test passed. ${c.lastTest.message}` : `Test failed. ${c.lastTest.message}`);
}

async function disconnect(): Promise<void> {
  const key = selectedKey();
  if (!key) return;
  const r = await call(`/owner/connections/${encodeURIComponent(key)}/disconnect`, { method: "POST", body: {} }, "Removing…");
  confirming = false;
  paint();
  if (r.ok) { msg("Disconnected. The saved details were removed."); $("cxm-detail").querySelector<HTMLElement>("h2")?.focus({ preventScroll: true }); }
}

function keepDraft(input: HTMLInputElement): void { drafts = { ...drafts, [input.name]: input.value }; }

document.addEventListener("submit", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("form[data-form]");
  if (!form) return;
  e.preventDefault();
  void save(form);
});

document.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!btn) return;
  const d = btn.dataset;
  if (d.filter) { filter = d.filter as Filter; paintList(); announce(`${$("cxm-list").querySelectorAll(".cxm-row").length} services shown`); }
  else if (d.reset) { filter = "all"; query = ""; $<HTMLInputElement>("cxm-search").value = ""; paintList(); $("cxm-search").focus(); }
  else if (d.test) await runTest(btn);
  else if (d.change) { editing = new Set([...editing, d.change]); paintDetail(); $(`f-${selectedKey()}-${d.change}`)?.focus(); }
  else if (d.cancel) { editing = new Set([...editing].filter((f) => f !== d.cancel)); const { [d.cancel]: _x, ...rest } = drafts; drafts = rest; paintDetail(); document.querySelector<HTMLElement>(`[data-change="${CSS.escape(d.cancel)}"]`)?.focus(); }
  else if (d.disconnect) { confirming = true; paintDetail(); document.getElementById("cxm-dc-h")?.focus(); }
  else if (d.disconnectNo) { confirming = false; paintDetail(); document.querySelector<HTMLElement>("[data-disconnect]")?.focus(); }
  else if (d.disconnectYes) await disconnect();
  else if (d.sendtest) { const r = await call("/owner/connections/whatsapp/send-test", { method: "POST", body: {} }, "Sending…"); if (r.ok) msg(r.data?.message ?? "Sent."); }
  else if (d.clear) {
    const key = selectedKey();
    const r = key ? await call(`/owner/connections/${encodeURIComponent(key)}`, { method: "PUT", body: { fields: {}, clear: [d.clear] } }, "Removing…") : { ok: false };
    if (r.ok) msg("Removed.");
  } else if (d.gen) {
    const input = $<HTMLInputElement>(d.gen);
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    input.value = Array.from(crypto.getRandomValues(new Uint8Array(28)), (b) => abc[b % abc.length]).join("");
    keepDraft(input);
    input.focus();
  } else if (d.copy) {
    const text = document.getElementById(d.copy)?.textContent ?? "";
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { toast("Copy did not work here. Select the text and copy it."); }
    setTimeout(() => { btn.textContent = "Copy"; }, 1800);
  }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "cxm-search") { query = t.value; paintList(); announce(`${$("cxm-list").querySelectorAll(".cxm-row").length} services shown`); return; }
  if (t.closest("form[data-form]") && t.name) keepDraft(t);
});

document.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (box.dataset.step) writeTick(box.dataset.step, box.checked);
});

// `toggle` does not bubble, so it is caught on the way down. Remembers which groups the owner opened or closed.
document.addEventListener("toggle", (e) => {
  const el = e.target as HTMLElement;
  const tier = el.dataset?.tier as Tier | undefined;
  if (!tier || !el.classList.contains("cxm-group") || filter !== "all" || query.trim()) return;
  openTiers ??= new Set();
  if ((el as HTMLDetailsElement).open) openTiers.add(tier); else openTiers.delete(tier);
}, true);

window.addEventListener("hashchange", () => onSelect(true));

void (async () => {
  const filters = $("cxm-filters");
  filters.innerHTML = FILTERS.map(([id, label]) => `<button type="button" class="chip" data-filter="${id}" aria-pressed="${id === "all"}">${label}</button>`).join("");
  const loaded = await ownerLoad<View>("/owner/connections");
  if (loaded === undefined) return;
  if (loaded === "demo") { view = DEMO; markDemo(); } else { view = loaded; live = true; }
  paint();
  if (hashKey() && find(hashKey())) onSelect(true);
})();
