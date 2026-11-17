// The Approvals screen for a signed-in client: one real list of everything waiting for them, from every part of
// MAIZ (needs.ts reads it). Each button calls the existing endpoint for that kind of item; anything decided on
// another screen links there. Loaded only when the screen is opened by someone who is logged in.
import { api } from "./api";
import { isBusy, keepFocus, setBusy } from "./keep-focus";
import { loadNeeds, needsFailed, needsNow, onNeeds, safeHref, type NeedItem } from "./needs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const root = (): HTMLElement => document.getElementById("appr-live")!;
const list = (): HTMLElement => document.getElementById("appr-list")!;
const say = (text: string): void => { const s = document.getElementById("appr-status"); if (s) s.textContent = text; };

const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dayTime = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** What the date on an item means, which depends on what the item is. */
function deadline(i: NeedItem): string {
  if (!i.dueAt) return "";
  if (i.kind === "agent_job") return `Closes by itself on ${day(i.dueAt)} if you do nothing.`;
  if (i.kind === "social_post") return `Picked to go out on ${dayTime(i.dueAt)}.`;
  if (i.kind === "leave_request") return `Starts on ${day(i.dueAt)}.`;
  return "";
}

/** What to say once a decision has gone through. */
const DONE: Record<string, Record<string, string>> = {
  agent_job: { approve: "Approved. The employee is starting on it.", refuse: "Refused. The tool has been told." },
  social_post: { approve: "Approved. It will be posted.", refuse: "It will not be posted." },
  leave_request: { approve: "Leave approved.", refuse: "Leave declined." },
};

function itemHtml(i: NeedItem): string {
  const when = [i.at ? `Asked ${dayTime(i.at)}` : "", deadline(i)].filter(Boolean).join(" ");
  const buttons = i.actions.map((a) => `<button class="btn btn-sm ${a.key === "approve" ? "btn-primary" : "btn-ghost"}" type="button" data-act="${a.key}">${esc(a.label)}<span class="sr-only">: ${esc(i.title)}</span></button>`).join("");
  const link = i.link ? `<a class="btn btn-sm btn-ghost" href="${safeHref(i.link.href)}" data-act="open">${esc(i.link.label)}<span class="sr-only">: ${esc(i.title)}</span></a>` : "";
  return `<li class="ag-job ovl-item" data-id="${esc(i.id)}">
    <div class="ag-conn-h"><b>${esc(i.title)}</b><span class="badge badge-dark">${esc(i.source)}</span></div>
    <p class="small muted">From ${esc(i.who)}${when ? `. ${esc(when)}` : ""}</p>
    ${i.detail ? `<p class="preview">${esc(i.detail)}</p>` : ""}
    ${i.cost || i.why ? `<p class="small">${i.cost ? `<b class="ovl-cost">${esc(i.cost)}.</b> ` : ""}${i.why ? esc(i.why) : ""}</p>` : ""}
    ${buttons || link ? `<div class="acts">${buttons}${link}</div>` : ""}
    ${i.blocked ? `<p class="small muted">${esc(i.blocked)}</p>` : ""}
  </li>`;
}

function draw(): void {
  const n = needsNow();
  if (!n) {
    list().innerHTML = needsFailed()
      ? '<div class="ovl-empty"><p>We could not load what is waiting for you just now.</p><p><button class="btn btn-sm btn-ghost" type="button" data-act="retry">Try again</button></p></div>'
      : '<p class="small muted">Checking what needs you…</p>';
    return;
  }
  if (!n.items.length) {
    list().innerHTML = '<div class="ovl-empty"><p class="all-clear">Nothing needs you right now.</p><p class="small muted">When a job from one of your tools, a post, a leave request or a question from your team is waiting for you, it shows here.</p></div>';
    return;
  }
  const s = n.summary;
  const lead = `${s.total} ${s.total === 1 ? "thing is" : "things are"} waiting for you.${s.elsewhere ? ` ${s.elsewhere === s.total ? (s.total === 1 ? "It is" : "They are") : `${s.elsewhere} ${s.elsewhere === 1 ? "is" : "are"}`} decided on another screen, with a link to take you there.` : ""}`;
  list().innerHTML = `<p class="small muted ovl-lead">${esc(lead)} What runs out soonest is first.</p><ul class="ag-list">${n.items.map(itemHtml).join("")}</ul>`;
}

const redraw = (): void => keepFocus(root(), "[data-id]", "data-act", draw);

/** After an item has left the list, focus goes to the one that took its place, or to the page heading. */
function focusAfter(nextId: string | undefined): void {
  const row = nextId ? Array.from(list().querySelectorAll<HTMLElement>("[data-id]")).find((r) => r.dataset.id === nextId) : undefined;
  const target = row?.querySelector<HTMLElement>("button, a[href]") ?? document.querySelector<HTMLElement>('[data-screen="approvals"] h1');
  if (!target) return;
  if (target.tagName === "H1") target.tabIndex = -1;
  target.focus();
}

async function decide(button: HTMLElement, item: NeedItem, key: string): Promise<void> {
  const action = item.actions.find((a) => a.key === key);
  if (!action) return;
  const rows = Array.from(list().querySelectorAll<HTMLElement>("[data-id]"));
  const at = rows.findIndex((r) => r.dataset.id === item.id);
  const nextId = (rows[at + 1] ?? rows[at - 1])?.dataset.id;
  setBusy(button, true);
  say("Sending your answer…");
  const r = await api<{ error?: string }>(action.path, { body: action.body });
  if (!r.ok) {
    setBusy(button, false);
    say(r.data?.error ?? "That did not work just now. Please try again.");
    void loadNeeds();
    return;
  }
  await loadNeeds();
  say(DONE[item.kind]?.[key] ?? "Done.");
  if (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected) focusAfter(nextId);
}

function onClick(ev: Event): void {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button[data-act]");
  if (!b || isBusy(b)) return;
  if (b.dataset.act === "retry") { say("Checking again…"); void loadNeeds(); return; }
  const id = b.closest<HTMLElement>("[data-id]")?.dataset.id;
  const item = needsNow()?.items.find((i) => i.id === id);
  if (item) void decide(b, item, b.dataset.act!);
}

let wired = false;
/** Called each time the Approvals screen is opened by a signed-in client. */
export function showApprovals(): void {
  const el = document.getElementById("appr-live");
  if (!el) return;
  if (!wired) {
    wired = true;
    document.querySelector('[data-screen="approvals"] .eg')?.remove();
    const intro = document.querySelector('[data-screen="approvals"] .page-h p');
    if (intro) intro.textContent = "Everything that is waiting for you, from every part of MAIZ, in one list.";
    el.innerHTML = '<p class="ovl-status" role="status" aria-live="polite" id="appr-status"></p><div id="appr-list"></div>';
    el.hidden = false;
    el.addEventListener("click", onClick);
    onNeeds(redraw);
  }
  draw();
  void loadNeeds();
}
