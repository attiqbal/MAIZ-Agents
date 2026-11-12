// The bell: what happened while you were away, and (if you allow it) a browser notification when something new arrives.
import { api, getToken } from "./api";
import { toast } from "./common";

interface Notice { id: string; kind: string; title: string; body?: string; link?: string; at: string; unread: boolean }
interface Bell { notices: Notice[]; unread: number }

const POLL_MS = 45_000;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only paths on this site are ever followed from a notice. */
export const isSafeLink = (l: string | undefined): l is string => !!l && l.startsWith("/") && !l.startsWith("//");

let announced = new Set<string>();
let first = true;

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function permissionLine(): string {
  if (typeof Notification === "undefined") return "";
  if (Notification.permission === "granted") return '<p class="small muted bell-perm">Browser alerts are on while this page is open.</p>';
  if (Notification.permission === "denied") return '<p class="small muted bell-perm">Browser alerts are blocked. You can allow them in your browser settings.</p>';
  return '<p class="bell-perm"><button type="button" class="btn btn-sm btn-ghost" id="bell-allow">Tell me in this browser when work is done</button></p>';
}

function paint(b: Bell): void {
  const count = $("bell-count");
  count.textContent = b.unread > 9 ? "9+" : String(b.unread);
  count.hidden = b.unread === 0;
  $("bell-btn").setAttribute("aria-label", b.unread ? `Notifications, ${b.unread} new` : "Notifications");
  $("bell-list").innerHTML = (b.notices.length
    ? b.notices.map((n) => {
      const inner = `<b>${esc(n.title)}</b>${n.body ? `<span class="d">${esc(n.body)}</span>` : ""}<span class="small muted">${esc(ago(n.at))}${n.unread ? " · new" : ""}</span>`;
      return `<li class="bell-item${n.unread ? " unread" : ""}">${isSafeLink(n.link) ? `<a href="${esc(n.link)}" data-bell-link>${inner}</a>` : `<div>${inner}</div>`}</li>`;
    }).join("")
    : '<li class="bell-empty small muted">Nothing yet. When a batch finishes or a review passes, it shows here.</li>') + `<li>${permissionLine()}</li>`;
  $("bell-allow")?.addEventListener("click", async () => {
    const result = await Notification.requestPermission();
    toast(result === "granted" ? "Browser alerts on" : "Browser alerts stay off");
    paint(b);
  });
}

/** Tells the person in the browser about notices they have not been told about, only when they are not looking at the page. */
function announce(b: Bell): void {
  const fresh = b.notices.filter((n) => n.unread && !announced.has(n.id));
  fresh.forEach((n) => announced.add(n.id));
  if (first) { first = false; return; } // what was already waiting when the page opened is in the bell, not a pop-up
  if (!fresh.length || typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
  const n = new Notification(fresh.length === 1 ? fresh[0]!.title : `${fresh.length} updates from your team`, { body: fresh.length === 1 ? fresh[0]!.body : fresh.map((x) => x.title).join("\n"), tag: "maiz-bell" });
  n.onclick = () => { window.focus(); $("bell-btn").click(); n.close(); };
}

async function load(): Promise<void> {
  const r = await api<Bell>("/notifications");
  if (!r.ok || !r.data) return;
  paint(r.data);
  announce(r.data);
}

export function initBell(): void {
  if (!getToken()) return;
  const btn = $("bell-btn"), panel = $("bell-panel");
  btn.hidden = false;
  const setOpen = async (open: boolean) => {
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      await load();
      // Opening the bell reads everything in it.
      const seen = await api<Bell>("/notifications/seen", { method: "POST", body: {} });
      if (seen.ok && seen.data) { announced = new Set(seen.data.notices.map((n) => n.id)); $("bell-count").hidden = true; }
    }
  };
  btn.addEventListener("click", () => void setOpen(panel.hidden));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { void setOpen(false); btn.focus(); } });
  document.addEventListener("click", (e) => { if (!panel.hidden && !(e.target as HTMLElement).closest("#bell-wrap")) void setOpen(false); });
  panel.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("[data-bell-link]")) void setOpen(false); });
  void load();
  window.setInterval(() => { if (!document.hidden || Notification?.permission === "granted") void load(); }, POLL_MS);
}
