// New specialists (owner-specialists.html): custom roles drafted for clients, waiting for the platform
// owner to check the job description, set the price and approve, ask for changes or decline.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { jdHtml } from "./jd";
import { esc, gbp, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { draftCustomRole } from "../../src/modules/workforce/custom-roles";
import type { SpecialistRequest, SpecialistStatus } from "../../src/modules/review/specialists";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Row = SpecialistRequest & { clientName: string };

function demo(): Row[] {
  const make = (id: string, clientName: string, title: string, purpose: string, duties: string[]): Row | undefined => {
    const d = draftCustomRole({ title, purpose, duties });
    if (!d.ok) return undefined;
    const at = new Date().toISOString();
    return { id, clientName, workspaceId: "example", brief: { title, purpose, duties }, role: d.role, jobDescription: d.jobDescription, notes: d.notes, similar: d.similar, priceGbp: 30, status: "in_review", submittedAt: at, updatedAt: at, history: [] };
  };
  return [
    make("eg-wholesale", "Kestrel Coffee", "Wholesale account coordinator", "Look after the cafes and delis that buy coffee in bulk", ["Prepare monthly price lists for wholesale customers", "Chase repeat orders and late payments", "Keep the wholesale customer list up to date"]),
    make("eg-clinic", "Harbour Dental", "Patient recall coordinator", "Make sure patients book their check-ups and hygiene visits on time", ["Draft recall reminders for the practice to send", "Track who is overdue for a check-up", "Report missed appointments each week"]),
  ].filter((x): x is Row => Boolean(x));
}

const LABEL: Record<SpecialistStatus, [string, string]> = {
  in_review: ["info", "Waiting for you"], changes_requested: ["warn", "You asked for changes"], approved: ["good", "Approved"], declined: ["", "Declined"],
};
type Filter = "waiting" | "done";
let rows: Row[] = [];
let live = false;
let filter: Filter = "waiting";

function card(r: Row): string {
  const id = esc(r.id);
  const open = r.status === "in_review";
  const notes = [...r.notes].map((n) => `<li>${esc(n)}</li>`).join("");
  const acts = open ? `<form class="rv-acts" data-sp="${id}">
      <div class="field"><label class="so-k" for="sp-price-${id}">Monthly price (£)</label><input class="input" id="sp-price-${id}" type="number" min="0" step="0.01" inputmode="decimal" value="${r.priceGbp}"></div>
      <div class="field"><label class="so-k" for="sp-msg-${id}">Message to the client (needed to ask for changes or decline)</label><textarea class="input" id="sp-msg-${id}" rows="2" maxlength="1000"></textarea></div>
      <div class="acts" style="grid-column:1/-1"><button type="submit" class="btn btn-primary btn-sm" data-decision="approved">Approve and offer</button><button type="submit" class="btn btn-ghost btn-sm" data-decision="changes_requested">Ask for changes</button><button type="submit" class="btn btn-quiet btn-sm" data-decision="declined">Decline</button></div></form>`
    : `<p class="xs muted">${r.status === "approved" ? `Offered at ${gbp(r.priceGbp)} a month.` : ""}${r.messageToClient ? ` Your message: ${esc(r.messageToClient)}` : ""}</p>`;
  return `<article class="so-card" id="${id}"><div class="so-h"><div><h3>${esc(r.role.title)}</h3>
      <div class="rv-meta"><span>Client <b>${esc(r.clientName)}</b></span><span>${r.role.tier === "premium" ? "Premium lane" : "Standard lane"}</span><span>Quoted ${gbp(r.priceGbp)} a month</span><span>Asked ${esc(new Date(r.submittedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</span></div></div>
      <span class="status ${LABEL[r.status][0]}"><span class="dot"></span>${LABEL[r.status][1]}</span></div>
    <div class="so-grid"><div><h4>What the client asked for</h4><p>${esc(r.brief.purpose)}</p><ul class="rv-hist">${r.brief.duties.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>
      <div><h4>Checks</h4>${notes ? `<ul class="rd-notes">${notes}</ul>` : "<p>No regulated work and no overlap with existing roles found.</p>"}</div></div>
    <details class="jd"><summary>Read the drafted job description</summary><div>${jdHtml(r.jobDescription, 4)}</div></details>${acts}</article>`;
}

function render(): void {
  const waiting = rows.filter((r) => r.status === "in_review");
  $("sp-filter").innerHTML = ([["waiting", `Waiting for you (${waiting.length})`], ["done", `Decided (${rows.length - waiting.length})`]] as const)
    .map(([k, l]) => `<button type="button" class="chip" aria-pressed="${k === filter}" data-spf="${k}">${l}</button>`).join("");
  const shown = filter === "waiting" ? waiting : rows.filter((r) => r.status !== "in_review");
  $("sp-list").innerHTML = shown.map(card).join("") || `<p class="all-clear">${filter === "waiting" ? "No new specialists waiting. You are emailed when a client asks for one." : "Nothing decided yet."}</p>`;
  const hit = location.hash.slice(1);
  if (hit) document.getElementById(hit)?.scrollIntoView();
}

document.addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>("[data-spf]");
  if (!f) return;
  filter = f.dataset.spf as Filter;
  render();
  $("sp-filter").querySelector<HTMLElement>(`[data-spf="${filter}"]`)?.focus();
});

document.addEventListener("submit", async (e) => {
  const form = e.target as HTMLFormElement;
  const id = form.dataset.sp;
  if (!id) return;
  e.preventDefault();
  const decision = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.dataset.decision ?? "approved";
  const message = $<HTMLTextAreaElement>(`sp-msg-${id}`).value.trim();
  const price = Number($<HTMLInputElement>(`sp-price-${id}`).value);
  if (decision !== "approved" && !message) { toast("Tell the client what to change, or why"); $(`sp-msg-${id}`).focus(); return; }
  if (!Number.isFinite(price) || price < 0) { toast("Enter a price in pounds"); return; }
  if (live) {
    const r = await api<{ requests?: Row[]; error?: string }>(`/owner/specialists/${encodeURIComponent(id)}/decide`, { body: { decision, message, priceGbp: price } });
    if (!r.ok || !r.data?.requests) { toast(r.data?.error ?? "Could not save that. Try again."); return; }
    rows = r.data.requests;
  } else {
    rows = rows.map((x) => (x.id === id ? { ...x, status: decision as SpecialistStatus, priceGbp: price, ...(message ? { messageToClient: message } : {}) } : x));
  }
  render();
  toast(decision === "approved" ? "Approved. The client can now hire it." : decision === "declined" ? "Declined. The client has been told why." : "Sent back to the client.");
});

void (async () => {
  const r = await ownerLoad<{ requests: Row[] }>("/owner/specialists");
  if (!r) return;
  if (r === "demo") { rows = demo(); markDemo(); } else { rows = r.requests; live = true; }
  render();
})();
