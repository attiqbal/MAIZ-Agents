// Renders an employee's job description (from the backend's pure data module)
// for the agent store page and the team builder in the app.
import { JOB_DESCRIPTIONS, energyText, getJobDescription, type JobDescription } from "../../src/modules/workforce/job-descriptions";

export { JOB_DESCRIPTIONS, getJobDescription };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ul = (xs: readonly string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

/** `level` is the heading level for section titles, so headings never skip a level on the page. */
export function jdHtml(jd: JobDescription, level: 3 | 4 | 5 = 4): string {
  const h = `h${level}`;
  return `<div class="jd-body">
  <p class="jd-meta">${esc(jd.department)} · reports to the ${esc(jd.reportsTo.toLowerCase())}</p>
  <${h}>Role summary</${h}><p>${esc(jd.purpose)}</p>
  ${jd.engagement ? `<${h}>The deal</${h}><p class="jd-area">£${jd.engagement.fixedGbp} fixed · ${jd.engagement.includedEnergy.toLocaleString("en-GB")} energy included · ${esc(jd.engagement.turnaround)}</p><p class="jd-area">Covered</p>${ul(jd.engagement.scope)}<p class="jd-area">Not included</p>${ul(jd.engagement.notIncluded)}<p class="jd-area">You approve</p>${ul(jd.engagement.approvalPoints)}<p class="jd-area">If the included energy runs out</p>${ul(jd.engagement.overageRule)}` : ""}
  <${h}>Key responsibilities</${h}>${jd.responsibilities.map((r) => `<p class="jd-area">${esc(r.area)}</p>${ul(r.duties)}`).join("")}
  <${h}>Skills and competencies</${h}>
  <table class="jd-table"><thead><tr><th>Skill</th><th>Level</th></tr></thead><tbody>${jd.competencies.map((c) => `<tr><td><b>${esc(c.skill)}</b><span>${esc(c.detail)}</span></td><td><span class="jd-lvl jd-${c.level.toLowerCase()}">${c.level}</span></td></tr>`).join("")}</tbody></table>
  <${h}>Legal requirements it knows and applies</${h}>${ul(jd.legal)}
  <${h}>Documents and records it keeps up to date</${h}>${ul(jd.records)}
  <${h}>Knowledge and standards</${h}>${ul(jd.knowledge)}
  <${h}>Deliverables</${h}>
  <table class="jd-table"><thead><tr><th>Deliverable</th><th>Typical energy</th></tr></thead><tbody>${jd.deliverables.map((d) => `<tr><td><b>${esc(d.name)}</b><span>${esc(d.cadence)}</span></td><td class="mono">${energyText(d)}</td></tr>`).join("")}</tbody></table>
  <p class="jd-note">Energy is an estimate. You are only charged what the work really uses.</p>
  <${h}>How you will know it is working</${h}>${ul(jd.kpis)}
  <${h}>What it may do</${h}>
  <div class="jd-auth"><div><p class="jd-area">On its own, as drafts</p>${ul(jd.authority.autonomous)}</div><div><p class="jd-area">Only with your approval</p>${ul(jd.authority.needsApproval)}</div><div><p class="jd-area">Never</p>${ul(jd.authority.never)}</div></div>
  <${h}>Tools</${h}>${ul(jd.tools.map((t) => `${t.name}${t.status === "planned" ? " (coming soon)" : ""}`))}
  <${h}>When it brings in a qualified person</${h}>${ul(jd.escalate)}
  <${h}>What it needs from you to take over</${h}>${ul(jd.handover)}
</div>`;
}
