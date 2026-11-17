// What is really waiting for a signed-in client, read once and shared: the sidebar badge, the count in the top bar,
// the "Needs you" panel and tile on the Overview and the Approvals screen all draw from this one list, so they
// always agree (GET /api/overview/approvals). The signed-out example business never comes through here.
import { api, getToken } from "./api";

export interface NeedAction { key: "approve" | "refuse"; label: string; path: string; body: Record<string, unknown> }
export interface NeedItem {
  id: string; kind: string; source: string; who: string; title: string; detail?: string; cost?: string; why?: string;
  at?: string; dueAt?: string; actions: NeedAction[]; link?: { label: string; href: string }; blocked?: string;
}
export interface Needs { items: NeedItem[]; summary: { total: number; decideHere: number; elsewhere: number } }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Only a screen of this app or a page of this site, so a link can never lead anywhere else. */
export const safeHref = (h: string): string => (/^#[\w/-]*$/.test(h) || /^\/[\w./-]*$/.test(h) && !h.startsWith("//") ? h : "#approvals");
/** Cards shown on the Overview before it says how many more there are. */
const OVERVIEW_CARDS = 5;
const REFRESH_MS = 60_000;

let state: Needs | undefined;
let failed = false;
let loading: Promise<Needs | undefined> | undefined;
const listeners = new Set<() => void>();

export const needsNow = (): Needs | undefined => state;
export const needsFailed = (): boolean => failed;
/** Runs after every read of the list, including a failed one. */
export function onNeeds(fn: () => void): void { listeners.add(fn); }

function card(i: NeedItem): string {
  const go = i.actions.length || !i.link ? { href: "#approvals", label: i.actions.length ? "Decide in Approvals" : "See in Approvals" } : { href: safeHref(i.link.href), label: i.link.label };
  return `<div class="need" data-live-need><span class="k">${esc(i.source)} · ${esc(i.who)}</span><b>${esc(i.title)}</b>${i.detail ? `<span class="d">${esc(i.detail)}</span>` : ""}<div class="acts"><a class="btn btn-sm btn-ghost" href="${go.href}">${esc(go.label)}</a></div></div>`;
}

/** The Overview's "Needs you" panel. The setup card is the page's own (setup.ts shows and hides it), so it is not drawn twice. */
function paintPanel(): void {
  const panel = document.getElementById("needs");
  if (!panel) return;
  panel.querySelectorAll("[data-live-need], .all-clear").forEach((el) => el.remove());
  const setupCard = document.getElementById("setup-need");
  const setupShown = !!setupCard && !setupCard.hidden;
  const rest = (state?.items ?? []).filter((i) => i.kind !== "setup" || !setupCard);
  const shown = rest.slice(0, OVERVIEW_CARDS);
  const more = rest.length - shown.length;
  panel.insertAdjacentHTML("beforeend", shown.map(card).join("") + (more > 0 ? `<div class="need" data-live-need><b>And ${more} more</b><div class="acts"><a class="btn btn-sm btn-ghost" href="#approvals">Open Approvals</a></div></div>` : ""));
  const empty = !setupShown && rest.length === 0;
  panel.style.display = empty ? "block" : "";
  if (empty) panel.insertAdjacentHTML("beforeend", `<p class="all-clear">${failed ? "We could not check what needs you just now. Please reload in a moment." : state ? "Nothing needs you right now." : "Checking what needs you…"}</p>`);
}

function paintCounts(): void {
  const n = state?.summary.total ?? 0;
  const badge = document.getElementById("appr-count");
  if (badge) { badge.textContent = String(n); badge.toggleAttribute("hidden", n === 0); }
  const top = document.getElementById("need-count");
  if (top) top.textContent = failed && !state ? "" : !state ? "Checking…" : n === 0 ? "All clear" : `${n} need${n === 1 ? "s" : ""} you`;
  paintPanel();
}

/** Reads the list again and redraws everything that shows it. Calls made while one is running share its answer. */
export function loadNeeds(): Promise<Needs | undefined> {
  if (!getToken()) return Promise.resolve(undefined);
  loading ??= (async () => {
    const r = await api<Needs>("/overview/approvals");
    if (r.ok && r.data) { state = r.data; failed = false; } else failed = true;
    loading = undefined;
    paintCounts();
    for (const fn of listeners) fn();
    return state;
  })();
  return loading;
}

let started = false;
/** Called once for a signed-in client: clears the example counts at once, then keeps the real ones fresh. */
export function startNeeds(): void {
  if (started || !getToken()) return;
  started = true;
  paintCounts();
  void loadNeeds();
  // Something decided on another screen (a job on Apps, an answer on Tasks) changes the count: check on every move.
  window.addEventListener("hashchange", () => void loadNeeds());
  window.setInterval(() => { if (document.visibilityState === "visible") void loadNeeds(); }, REFRESH_MS);
}
