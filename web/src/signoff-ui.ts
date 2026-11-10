// "In quality review" on the client's Tasks screen. A specialist compiles everything it knows and the
// directions it could take, and MAIZ quality review (the platform owner) signs it off before work
// starts. The client follows each task here and answers the specialist's questions, but never approves.
// The rules live in src/modules/workforce/signoff.ts and src/modules/review, and are tested there.
import { api, getToken } from "./api";
import { toast } from "./common";
import { EXAMPLE_TASKS } from "./review-examples";
import { CLIENT_STATUS_LABEL, answerBrief, planEnergy, requestMoreInfo, reviewStatus, signOff, type ReviewStatus, type TaskProposal } from "../../src/modules/workforce/signoff";
import type { ClientReviewView } from "../../src/modules/review/index";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Example tasks at three stages: one waiting on the client, one in review, one approved. */
function examples(): ClientReviewView[] {
  const [brand, handbook, pitch] = EXAMPLE_TASKS;
  const waiting: TaskProposal = { ...brand!.proposal, brief: brand!.proposal.brief.map((b) => (b.label.startsWith("Colours") ? { label: b.label, from: "client" as const } : b)) };
  const asked = requestMoreInfo(handbook!.proposal, "Do any staff work nights or weekends only?");
  const approved = signOff(answerBrief(pitch!.proposal, "Who the investors are", "Two local angel investors"), new Date());
  const toView = (id: string, p: TaskProposal): ClientReviewView => {
    const status = reviewStatus(p);
    const chosen = status === "approved" ? p.directions?.find((d) => d.key === p.chosenDirection) : undefined;
    return { id, title: p.title, employee: p.employee, status, statusLabel: CLIENT_STATUS_LABEL[status], days: p.days, energy: planEnergy(p), design: p.design, brief: p.brief, ...(chosen ? { chosenDirection: chosen } : {}), submittedAt: "", updatedAt: "" };
  };
  return [toView(brand!.id, waiting), toView(handbook!.id, asked), ...(approved.ok ? [toView(pitch!.id, approved.proposal)] : [])];
}

let tasks: ClientReviewView[] = [];
let live = false;

export const proposalCount = (): number => tasks.filter((t) => t.status !== "approved").length;
const TONE: Record<ReviewStatus, string> = { gathering_info: "warn", in_review: "info", more_info_requested: "info", approved: "good" };
const status = (tone: string, text: string) => `<span class="status ${tone}"><span class="dot"></span>${esc(text)}</span>`;

function card(t: ClientReviewView, i: number): string {
  const done = t.status === "approved";
  const brief = t.brief.map((b, j) => {
    if (b.value?.trim()) return `<li><span class="so-k">${esc(b.label)}</span><span>${esc(b.value)}</span></li>`;
    if (b.from === "specialist") return `<li><span class="so-k">${esc(b.label)}</span><span class="so-wait">${status("info", "MAIZ quality review asked this. Your specialist is finding out.")}</span>
      <span class="so-in"><label class="sr-only" for="so-${i}-${j}">Answer it yourself: ${esc(b.label)}</label><input class="input" id="so-${i}-${j}" placeholder="Know the answer? Type it here"><button type="button" class="btn btn-ghost btn-sm" data-so-save="${i}" data-item="${j}">Save</button></span></li>`;
    return `<li><label class="so-k" for="so-${i}-${j}">${esc(b.label)}${b.optional ? " (optional)" : ""}</label><span class="so-in"><input class="input" id="so-${i}-${j}" placeholder="${b.optional ? "Skip if you like" : "Only you can answer this"}"><button type="button" class="btn btn-ghost btn-sm" data-so-save="${i}" data-item="${j}">Save</button></span></li>`;
  }).join("");
  const outcome = done
    ? `<h4>2. Direction approved by MAIZ</h4><p>${t.chosenDirection ? `<b>${esc(t.chosenDirection.name)}.</b> ${esc(t.chosenDirection.summary)}` : esc(t.design)}</p>${t.noteToClient ? `<p class="xs muted">Note from MAIZ: ${esc(t.noteToClient)}</p>` : ""}`
    : `<h4>2. The approach</h4><p>${esc(t.design)}</p><p class="xs muted">MAIZ checks every specialised task against what you asked for before any work starts. You will see the approved direction here.</p>`;
  return `<article class="so-card"><div class="so-h"><div><h3>${esc(t.title)}</h3><span class="xs muted">${esc(t.employee)} · ${t.days} working days · ${t.energy.toLocaleString()} energy</span></div>${status(TONE[t.status], t.statusLabel)}</div>
    <div class="so-grid"><div><h4>1. What the specialist has gathered</h4><ul class="so-brief">${brief}</ul></div><div>${outcome}</div></div></article>`;
}

function render(): void {
  const n = proposalCount();
  $("so-count").textContent = n ? `${n} in progress` : "All approved";
  $("so-list").innerHTML = tasks.map(card).join("") || `<p class="all-clear">No specialised tasks yet.</p>`;
}

async function save(i: number, j: number): Promise<void> {
  const t = tasks[i]!;
  const label = t.brief[j]!.label;
  const value = $<HTMLInputElement>(`so-${i}-${j}`).value.trim();
  if (!value) { toast("Type an answer first"); return; }
  if (live) {
    const r = await api<{ task?: ClientReviewView; error?: string }>(`/reviews/${encodeURIComponent(t.id)}/answer`, { body: { label, value } });
    if (!r.ok || !r.data?.task) { toast(r.data?.error ?? "Could not save that. Try again."); return; }
    tasks = tasks.map((x, k) => (k === i ? r.data!.task! : x));
  } else {
    const brief = t.brief.map((b) => (b.label === label ? { ...b, value } : b));
    const p = { title: t.title, employee: t.employee, brief, design: t.design, plan: [{ title: "plan", energy: t.energy }], days: t.days };
    const st = reviewStatus(p);
    tasks = tasks.map((x, k) => (k === i ? { ...x, brief, status: st, statusLabel: CLIENT_STATUS_LABEL[st] } : x));
  }
  render();
  toast(tasks[i]!.status === "in_review" ? "Thanks. It is now in quality review." : "Saved.");
}

export async function initSignOff(): Promise<void> {
  tasks = examples();
  render();
  const list = $("so-list");
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-so-save]");
    if (b) void save(Number(b.dataset.soSave), Number(b.dataset.item));
  });
  if (!getToken()) return; // demo visitor: examples only
  const r = await api<{ tasks: ClientReviewView[] }>("/reviews");
  // A signed-in client sees only their real tasks, even when there are none: never example approvals.
  if (r.ok && r.data) { tasks = r.data.tasks; live = true; render(); }
}
