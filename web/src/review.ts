// Quality review (review.html): the MAIZ platform owner's queue of every client's specialised tasks.
// The server only answers this page for emails in PLATFORM_OWNER_EMAILS; clients get a 403 and a link
// back to their control center. With no API running, the page shows example tasks that work locally.
import "./styles.css";
import { api, getToken } from "./api";
import { initNav, toast } from "./common";
import { EXAMPLE_TASKS } from "./review-examples";
import { missingInfo, planEnergy, requestMoreInfo, reviewStatus, signOff, type ReviewStatus } from "../../src/modules/workforce/signoff";
import type { OwnerReviewView } from "../../src/modules/review/index";

initNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Filter = "waiting" | "elsewhere" | "approved";
const FILTERS: [Filter, string][] = [["waiting", "Waiting for you"], ["elsewhere", "Waiting on client or specialist"], ["approved", "Approved"]];
const inFilter = (s: ReviewStatus, f: Filter) => (f === "waiting" ? s === "in_review" : f === "approved" ? s === "approved" : s === "gathering_info" || s === "more_info_requested");
const LABEL: Record<ReviewStatus, [string, string]> = {
  in_review: ["info", "Waiting for your sign-off"],
  more_info_requested: ["warn", "You asked for more information"],
  gathering_info: ["warn", "Client still answering"],
  approved: ["good", "Approved, work has started"],
};

let reviews: OwnerReviewView[] = [];
let live = false;
let filter: Filter = "waiting";
/** Direction ticked on each card before approving. */
const picked = new Map<string, string>();

function demo(): OwnerReviewView[] {
  return EXAMPLE_TASKS.map((t) => toDemoView(t.id, t.clientName, t.ageHours, t.proposal));
}
function toDemoView(id: string, clientName: string, ageHours: number, proposal: OwnerReviewView["proposal"], prev?: OwnerReviewView): OwnerReviewView {
  const status = reviewStatus(proposal);
  return {
    id, workspaceId: "example", clientName, ageHours, proposal, status, energy: planEnergy(proposal), missing: missingInfo(proposal).map((m) => m.label),
    submittedAt: "", updatedAt: new Date().toISOString(), reviewNotes: prev?.reviewNotes ?? [], history: prev?.history ?? [],
  };
}

const status = (s: ReviewStatus) => `<span class="status ${LABEL[s][0]}"><span class="dot"></span>${LABEL[s][1]}</span>`;
const age = (h: number) => (h < 1 ? "under an hour" : h < 48 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.floor(h / 24)} days`);

function card(r: OwnerReviewView): string {
  const p = r.proposal;
  const open = r.status === "in_review";
  const brief = p.brief.map((b) => `<li><span class="so-k">${esc(b.label)}${b.from === "specialist" ? " (you asked)" : ""}</span><span${b.value?.trim() ? "" : ' class="rv-missing"'}>${b.value?.trim() ? esc(b.value) : "Not answered yet"}</span></li>`).join("");
  const chosen = r.status === "approved" ? p.chosenDirection : picked.get(r.id);
  const dirs = (p.directions ?? []).map((d) => `<label class="so-dir${chosen === d.key ? " on" : ""}"><input type="radio" name="rv-dir-${esc(r.id)}" value="${esc(d.key)}" data-rv-dir="${esc(r.id)}"${chosen === d.key ? " checked" : ""}${open ? "" : " disabled"}><span><b>${esc(d.name)}${d.recommended ? " (specialist recommends)" : ""}</b>${esc(d.summary)}</span></label>`).join("");
  const steps = p.plan.map((x) => `<li><span>${esc(x.title)}</span><span class="mono">${x.energy.toLocaleString()} energy</span></li>`).join("");
  const notes = r.reviewNotes.map((n) => `<li>Your note: ${esc(n.note)}</li>`).join("");
  const WHAT: Record<string, string> = { submitted: "submitted", answered: "answered", entered_review: "Joined your queue", info_requested: "You asked", approved: "You approved" };
  const WHO: Record<string, string> = { client: "Client", specialist: "Specialist", platform_owner: "" };
  const hist = r.history.map((h) => {
    const line = h.action === "entered_review" || h.by === "platform_owner" ? WHAT[h.action] : `${WHO[h.by]} ${WHAT[h.action]}`;
    return `<li>${esc(new Date(h.at).toLocaleString())} · ${esc(line ?? h.action)}${h.detail ? `: ${esc(h.detail)}` : ""}</li>`;
  }).join("");
  const needsDir = Boolean(p.directions?.length) && !chosen;
  const id = esc(r.id);
  const acts = r.status === "approved" ? "" : `<div class="rv-acts">
    <form data-rv-approve="${id}"><label class="so-k" for="rv-nc-${id}">Note to the client (optional, shown after approval)</label><textarea class="input" id="rv-nc-${id}" rows="2" maxlength="2000"></textarea>
      <div class="acts"><button type="submit" class="btn btn-primary btn-sm"${open && !needsDir ? "" : ` disabled aria-describedby="rv-why-${id}"`}>Approve and start work</button>${!open ? `<span class="xs muted" id="rv-why-${id}">Locked until every question is answered.</span>` : needsDir ? `<span class="xs muted" id="rv-why-${id}">Pick a direction first.</span>` : ""}</div></form>
    <form data-rv-ask="${id}"><label class="so-k" for="rv-q-${id}">Ask for more information (the client sees the question)</label><input class="input" id="rv-q-${id}" maxlength="300" placeholder="For example: which deli is the priority?">
      <label class="so-k" for="rv-n-${id}">Note for the specialist (the client never sees it)</label><input class="input" id="rv-n-${id}" maxlength="2000">
      <div class="acts"><button type="submit" class="btn btn-ghost btn-sm">Send back</button></div></form></div>`;
  return `<article class="so-card" id="${id}"><div class="so-h"><div><h3>${esc(p.title)}</h3>
      <div class="rv-meta"><span>Client <b>${esc(r.clientName)}</b></span><span>${esc(p.employee)}</span><span>${r.status === "approved" ? "Approved" : `Waiting ${age(r.ageHours)}`}</span><span>${p.days} working days</span><span>${r.energy.toLocaleString()} energy</span></div></div>${status(r.status)}</div>
    <div class="so-grid"><div><h4>1. Brief the specialist compiled</h4><ul class="so-brief">${brief}</ul>${notes || hist ? `<h4 style="margin-top:14px">History</h4><ul class="rv-hist">${notes}${hist}</ul>` : ""}</div>
    <div><h4>2. Approach and directions</h4><p>${esc(p.design || "No approach yet.")}</p>${dirs ? `<fieldset class="so-dirs"><legend class="sr-only">Direction for ${esc(p.title)}</legend>${dirs}</fieldset>` : ""}<h4>3. Plan and cost</h4><ol class="so-plan">${steps}</ol></div></div>${acts}</article>`;
}

function render(): void {
  $("rv-filter").innerHTML = FILTERS.map(([k, label]) => `<button type="button" class="chip" aria-pressed="${k === filter}" data-rv-filter="${k}">${label} (${reviews.filter((r) => inFilter(r.status, k)).length})</button>`).join("");
  const shown = reviews.filter((r) => inFilter(r.status, filter));
  $("rv-list").innerHTML = shown.map(card).join("") || `<p class="all-clear">${filter === "waiting" ? "Nothing is waiting for you. New tasks are emailed to you as they arrive." : "Nothing here."}</p>`;
}

function gate(h: string, p: string, link?: [string, string]): void {
  $("rv-body").hidden = true;
  $("rv-gate").hidden = false;
  $("rv-gate-h").textContent = h;
  $("rv-gate-p").textContent = p;
  const a = $<HTMLAnchorElement>("rv-gate-a");
  if (link) { a.href = link[0]; a.textContent = link[1]; } else a.hidden = true;
}

async function load(): Promise<void> {
  // Not logged in: ask to log in when the API is up, or show the examples when it is not.
  if (!getToken()) {
    const health = await api("/health");
    if (health.status !== 0) { gate("Log in to review tasks", "Quality review is for the MAIZ platform owner. Log in with your owner email.", ["/signin.html", "Log in"]); return; }
  }
  const r = await api<{ reviews: OwnerReviewView[] }>("/owner/reviews");
  if (r.status === 401) { gate("Log in to review tasks", "Quality review is for the MAIZ platform owner. Log in with your owner email.", ["/signin.html", "Log in"]); return; }
  if (r.status === 403) { gate("This page is for the MAIZ platform owner", "Your own specialised tasks, and where each one is in review, are on the Tasks screen of your control center.", ["/app.html#work", "Open your control center"]); return; }
  if (r.ok && r.data) { reviews = r.data.reviews; live = true; }
  else { reviews = demo(); $("rv-eg").hidden = false; }
  const target = location.hash.slice(1);
  const hit = reviews.find((x) => x.id === target);
  if (hit) filter = inFilter(hit.status, "waiting") ? "waiting" : inFilter(hit.status, "approved") ? "approved" : "elsewhere";
  render();
  if (hit) document.getElementById(hit.id)?.scrollIntoView();
}

async function act(id: string, kind: "approve" | "request-info", body: Record<string, string>): Promise<boolean> {
  const r0 = reviews.find((x) => x.id === id)!;
  let next: OwnerReviewView | undefined;
  if (live) {
    const r = await api<{ review?: OwnerReviewView; error?: string }>(`/owner/reviews/${encodeURIComponent(id)}/${kind}`, { body });
    if (!r.ok || !r.data?.review) { toast(r.data?.error ? `${r.data.error[0]!.toUpperCase()}${r.data.error.slice(1)}` : "Could not save that. Try again."); return false; }
    next = r.data.review;
  } else if (kind === "approve") {
    const s = signOff(r0.proposal, new Date(), body.direction);
    if (!s.ok) { toast(s.reason); return false; }
    next = toDemoView(id, r0.clientName, r0.ageHours, s.proposal, r0);
  } else {
    next = toDemoView(id, r0.clientName, r0.ageHours, requestMoreInfo(r0.proposal, body.question!), { ...r0, reviewNotes: body.note ? [...r0.reviewNotes, { at: new Date().toISOString(), note: body.note }] : r0.reviewNotes });
  }
  reviews = reviews.map((x) => (x.id === id ? next! : x));
  render();
  return true;
}

document.addEventListener("change", (e) => {
  const r = e.target as HTMLInputElement;
  if (r.dataset.rvDir === undefined) return;
  picked.set(r.dataset.rvDir, r.value);
  render();
  document.querySelector<HTMLInputElement>(`input[name="${CSS.escape(r.name)}"]:checked`)?.focus();
});
document.addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>("[data-rv-filter]");
  if (!f) return;
  filter = f.dataset.rvFilter as Filter;
  render();
  $("rv-filter").querySelector<HTMLElement>(`[data-rv-filter="${filter}"]`)?.focus();
});
document.addEventListener("submit", async (e) => {
  const form = e.target as HTMLFormElement;
  const approveId = form.dataset.rvApprove;
  const askId = form.dataset.rvAsk;
  if (!approveId && !askId) return;
  e.preventDefault();
  if (approveId) {
    const note = $<HTMLTextAreaElement>(`rv-nc-${approveId}`).value.trim();
    const direction = picked.get(approveId);
    if (await act(approveId, "approve", { ...(direction ? { direction } : {}), ...(note ? { noteToClient: note } : {}) })) toast("Approved. The client is told and work starts.");
    return;
  }
  const question = $<HTMLInputElement>(`rv-q-${askId}`).value.trim();
  const note = $<HTMLInputElement>(`rv-n-${askId}`).value.trim();
  if (!question) { toast("Type your question first"); return; }
  if (await act(askId!, "request-info", { question, ...(note ? { note } : {}) })) toast("Sent back. It returns to your queue once answered.");
});

void load();
