// Team screen: "Need a role that isn't here?" The Admin manager's role designer turns the owner's
// brief into a draft job description. The rules live in src/modules/workforce/custom-roles.ts.
import { toast } from "./common";
import { jdHtml } from "./jd";
import { draftCustomRole } from "../../src/modules/workforce/custom-roles";
import { MONTHLY_PRICE_GBP } from "../../src/modules/store/cart";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function initRoleDesigner(): void {
  $<HTMLFormElement>("rd-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const draft = draftCustomRole({
      title: $<HTMLInputElement>("rd-title").value,
      purpose: $<HTMLInputElement>("rd-purpose").value,
      duties: $<HTMLTextAreaElement>("rd-duties").value.split("\n"),
    });
    const out = $("rd-out");
    if (!draft.ok) {
      out.innerHTML = `<ul class="rd-problems">${draft.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
      return;
    }
    const price = draft.role.tier === "premium" ? MONTHLY_PRICE_GBP.specialistPremium : MONTHLY_PRICE_GBP.specialistStandard;
    out.innerHTML = `<div class="rd-draft"><div class="so-h"><div><h3>Draft: ${esc(draft.role.title)}</h3><span class="xs muted">Custom specialist · £${price} a month (draft list price) · waiting for your sign-off</span></div><span class="status info"><span class="dot"></span>Draft</span></div>
      ${draft.notes.length ? `<ul class="rd-notes">${draft.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <details class="jd"><summary>Read the full job description</summary><div>${jdHtml(draft.jobDescription, 4)}</div></details>
      <div class="acts"><button type="button" class="btn btn-primary btn-sm" id="rd-ok">Sign off and train</button><button type="button" class="btn btn-ghost btn-sm" id="rd-edit">Change the brief</button></div></div>`;
    $("rd-ok").addEventListener("click", () => toast("Hiring opens with payments. Your draft is ready and nothing has been charged."));
    $("rd-edit").addEventListener("click", () => $("rd-title").focus());
  });
}
