// Team screen: "Need a role that isn't here?" The Admin manager's role designer turns the owner's
// brief into a draft job description, which goes to MAIZ for review: MAIZ checks it and confirms
// the price before anything is trained, then the owner decides whether to hire it.
// The rules live in src/modules/workforce/custom-roles.ts and src/modules/review/specialists.ts.
import { api, getToken } from "./api";
import { toast } from "./common";
import { jdHtml } from "./jd";
import { draftCustomRole } from "../../src/modules/workforce/custom-roles";
import { MONTHLY_PRICE_GBP } from "../../src/modules/store/cart";
import type { ClientSpecialistView } from "../../src/modules/review/specialists";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const TONE: Record<string, string> = { in_review: "info", changes_requested: "warn", approved: "good", declined: "" };

function renderRequests(list: ClientSpecialistView[]): void {
  const box = document.getElementById("rd-requests");
  if (!box) return;
  box.innerHTML = list.length
    ? `<h3 class="small" style="margin:8px 0">Your new specialists</h3><ul class="so-brief">${list.map((r) => `<li><span class="so-k">${esc(r.title)} · £${r.priceGbp} a month</span><span><span class="status ${TONE[r.status] ?? ""}"><span class="dot"></span>${esc(r.statusLabel)}</span>${r.messageToClient ? ` <span class="xs muted">MAIZ: ${esc(r.messageToClient)}</span>` : ""}</span></li>`).join("")}</ul>`
    : "";
}

async function loadRequests(): Promise<void> {
  if (!getToken()) return;
  const r = await api<{ requests: ClientSpecialistView[] }>("/specialists");
  if (r.ok && r.data) renderRequests(r.data.requests);
}

export function initRoleDesigner(): void {
  void loadRequests();
  $<HTMLFormElement>("rd-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const brief = {
      title: $<HTMLInputElement>("rd-title").value,
      purpose: $<HTMLInputElement>("rd-purpose").value,
      duties: $<HTMLTextAreaElement>("rd-duties").value.split("\n"),
    };
    const draft = draftCustomRole(brief);
    const out = $("rd-out");
    if (!draft.ok) {
      out.innerHTML = `<ul class="rd-problems">${draft.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
      return;
    }
    const price = draft.role.tier === "premium" ? MONTHLY_PRICE_GBP.specialistPremium : MONTHLY_PRICE_GBP.specialistStandard;
    out.innerHTML = `<div class="rd-draft"><div class="so-h"><div><h3>Draft: ${esc(draft.role.title)}</h3><span class="xs muted">Custom specialist · about £${price} a month · MAIZ confirms the price when it reviews the role</span></div><span class="status info"><span class="dot"></span>Draft</span></div>
      ${draft.notes.length ? `<ul class="rd-notes">${draft.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <details class="jd"><summary>Read the full job description</summary><div>${jdHtml(draft.jobDescription, 4)}</div></details>
      <div class="acts"><button type="button" class="btn btn-primary btn-sm" id="rd-ok">Send to MAIZ for review</button><button type="button" class="btn btn-ghost btn-sm" id="rd-edit">Change the brief</button></div></div>`;
    $("rd-ok").addEventListener("click", async () => {
      if (!getToken()) { toast("Example: once you have an account, MAIZ reviews the role and confirms the price before it is trained."); return; }
      const r = await api<{ error?: string }>("/specialists", { body: { title: brief.title, purpose: brief.purpose, duties: brief.duties.filter((d) => d.trim()) } });
      if (!r.ok) { toast(r.data?.error ?? "Could not send it. Try again."); return; }
      out.innerHTML = `<p class="all-clear">Sent. MAIZ reviews every new specialist and confirms the price before it is trained. You will hear back from your Admin manager.</p>`;
      void loadRequests();
    });
    $("rd-edit").addEventListener("click", () => $("rd-title").focus());
  });
}
