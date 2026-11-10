// "Waiting for your sign-off" on the Tasks screen. A specialist compiles everything it knows and the
// directions it could take; the owner picks a direction and signs off, or asks for more information.
// The rules (what blocks sign-off) live in src/modules/workforce/signoff.ts and are tested there.
import { toast } from "./common";
import { answerBrief, missingInfo, planEnergy, proposalStage, requestMoreInfo, signOff, type TaskProposal } from "../../src/modules/workforce/signoff";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let proposals: TaskProposal[] = [
  {
    title: "Brand kit for the autumn range", employee: "Brand and content creator", days: 5,
    brief: [
      { label: "Who you sell to", value: "Home coffee drinkers, 25 to 45, UK (from your setup form)" },
      { label: "Tone of voice", value: "Warm, plain, playful (read from your website)" },
      { label: "What competitors do", value: "Two local roasters use dark, premium packaging; none use illustration" },
      { label: "Colours and logos you already use" },
    ],
    design: "One brand kit shown on a bag label, a social post and an email header, so you can judge it in real use.",
    directions: [
      { key: "refresh", name: "Refresh", summary: "Keep the kestrel logo, add an autumn palette and one new typeface. Fastest, and existing customers will recognise it. Recommended.", recommended: true },
      { key: "illustrated", name: "Illustrated", summary: "Keep the logo and add hand-drawn illustrations for each blend. Stands out from both competitors, needs more approval rounds." },
      { key: "rebrand", name: "Full rebrand", summary: "New logo, palette and type. Biggest change, and old packaging would need replacing." },
    ],
    plan: [{ title: "Three sample layouts in the chosen direction", energy: 300 }, { title: "Palette, type and logo rules", energy: 250 }, { title: "Templates: label, post, email header", energy: 400 }],
  },
  {
    title: "Staff handbook, first edition", employee: "People, policy and operations consultant", days: 7,
    brief: [
      { label: "Country and number of staff", value: "United Kingdom, 4 staff (from your setup form)" },
      { label: "Working hours and holiday allowance", value: "Mon to Sat, 28 days including bank holidays" },
      { label: "Existing contracts", value: "2 contracts read from your uploads" },
    ],
    design: "A short, plain-language handbook built from your contracts and the UK minimum requirements, with each policy marked required or recommended.",
    directions: [
      { key: "essentials", name: "Essentials", summary: "Only the policies UK law requires for a team of 4, about 12 pages. Recommended.", recommended: true },
      { key: "full", name: "Full handbook", summary: "Required policies plus recommended ones such as remote work and training, about 30 pages." },
    ],
    plan: [{ title: "Outline and list of policies", energy: 150 }, { title: "Draft all policies", energy: 600 }, { title: "Compliance manager review", energy: 120 }],
  },
];
/** The direction ticked on each card before sign-off. */
const picked = new Map<number, string>();

export const proposalCount = (): number => proposals.filter((p) => proposalStage(p) !== "signed_off").length;
const status = (tone: string, text: string) => `<span class="status ${tone}"><span class="dot"></span>${esc(text)}</span>`;

function card(p: TaskProposal, i: number): string {
  const stage = proposalStage(p);
  const done = stage === "signed_off";
  const missing = missingInfo(p);
  const state = done ? status("good", "Signed off, work has started") : stage === "ready_for_sign_off" ? status("info", "Ready for your decision") : status("warn", `${missing.length} thing${missing.length === 1 ? "" : "s"} still missing`);
  const brief = p.brief.map((b, j) => {
    if (b.value?.trim()) return `<li><span class="so-k">${esc(b.label)}</span><span>${esc(b.value)}</span></li>`;
    if (b.from === "employee") return `<li><span class="so-k">${esc(b.label)}</span><span class="so-wait">${status("info", "You asked for this. The specialist is finding out.")}<button type="button" class="btn btn-quiet btn-sm" data-so-found="${i}" data-item="${j}">Show example answer</button></span></li>`;
    return `<li><label class="so-k" for="so-${i}-${j}">${esc(b.label)}${b.optional ? " (optional)" : ""}</label><span class="so-in"><input class="input" id="so-${i}-${j}" placeholder="${b.optional ? "Skip if you like" : "Only you can answer this"}"><button type="button" class="btn btn-ghost btn-sm" data-so-save="${i}" data-item="${j}">Save</button></span></li>`;
  }).join("");
  const chosen = done ? p.chosenDirection : picked.get(i);
  const directions = (p.directions ?? []).map((d) => `<label class="so-dir${chosen === d.key ? " on" : ""}"><input type="radio" name="so-dir-${i}" value="${esc(d.key)}" data-so-dir="${i}"${chosen === d.key ? " checked" : ""}${done ? " disabled" : ""}><span><b>${esc(d.name)}</b>${esc(d.summary)}</span></label>`).join("");
  const steps = p.plan.map((x) => `<li><span>${esc(x.title)}</span><span class="mono">${x.energy} energy</span></li>`).join("");
  const locked = stage === "needs_info" || (p.directions?.length ? !chosen : false);
  const why = stage === "needs_info" ? "Locked until the missing information is in." : locked ? "Choose a direction to sign off." : "";
  const acts = done ? "" : `<div class="so-acts"><div class="acts"><button type="button" class="btn btn-primary btn-sm" data-so-ok="${i}"${locked ? ` disabled aria-describedby="so-why-${i}"` : ""}>Sign off and start</button>${why ? `<span class="xs muted" id="so-why-${i}">${why}</span>` : ""}</div>
      <form class="so-ask" data-so-ask="${i}"><label class="so-k" for="so-q-${i}">Not ready to decide? Ask for more information</label><span class="so-in"><input class="input" id="so-q-${i}" placeholder="For example: what would each direction cost to print?"><button type="submit" class="btn btn-ghost btn-sm">Ask</button></span></form></div>`;
  return `<article class="so-card"><div class="so-h"><div><h3>${esc(p.title)}</h3><span class="xs muted">${esc(p.employee)} · ${p.days} working days · ${planEnergy(p).toLocaleString()} energy</span></div>${state}</div>
    <div class="so-grid"><div><h4>1. What the specialist has gathered</h4><ul class="so-brief">${brief}</ul></div>
    <div><h4>2. Which direction to take</h4><p>${esc(p.design)}</p><fieldset class="so-dirs"><legend class="sr-only">Direction for ${esc(p.title)}</legend>${directions}</fieldset><h4>3. Plan and cost</h4><ol class="so-plan">${steps}</ol></div></div>${acts}</article>`;
}

function render(): void {
  const n = proposalCount();
  $("so-count").textContent = n ? `${n} waiting` : "All signed off";
  $("so-list").innerHTML = proposals.map(card).join("");
}
const update = (i: number, next: TaskProposal) => { proposals = proposals.map((p, k) => (k === i ? next : p)); render(); };

export function initSignOff(): void {
  render();
  const list = $("so-list");
  list.addEventListener("change", (e) => {
    const r = e.target as HTMLInputElement;
    if (r.dataset.soDir === undefined) return;
    picked.set(Number(r.dataset.soDir), r.value);
    render();
    list.querySelector<HTMLInputElement>(`input[name="${r.name}"]:checked`)?.focus();
  });
  list.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = (e.target as HTMLElement).closest<HTMLFormElement>("[data-so-ask]");
    if (!form) return;
    const i = Number(form.dataset.soAsk);
    const q = $<HTMLInputElement>(`so-q-${i}`).value.trim();
    if (!q) { toast("Type your question first"); return; }
    update(i, requestMoreInfo(proposals[i]!, q));
    toast("Sent back. The specialist will add the answer to the brief.");
  });
  list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const save = t.closest<HTMLElement>("[data-so-save]");
    const found = t.closest<HTMLElement>("[data-so-found]");
    const ok = t.closest<HTMLElement>("[data-so-ok]");
    if (save) {
      const i = Number(save.dataset.soSave), j = Number(save.dataset.item);
      const value = $<HTMLInputElement>(`so-${i}-${j}`).value.trim();
      if (!value) { toast("Type an answer first"); return; }
      update(i, answerBrief(proposals[i]!, proposals[i]!.brief[j]!.label, value));
    } else if (found) {
      const i = Number(found.dataset.soFound), j = Number(found.dataset.item);
      update(i, answerBrief(proposals[i]!, proposals[i]!.brief[j]!.label, "Example answer: the specialist's findings appear here, with sources."));
    } else if (ok) {
      const i = Number(ok.dataset.soOk);
      const r = signOff(proposals[i]!, new Date(), picked.get(i));
      if (!r.ok) { toast(r.missing.length ? `Still missing: ${r.missing.join(", ")}` : r.reason); return; }
      update(i, r.proposal);
      toast("Signed off. Work has started.");
    }
  });
}
