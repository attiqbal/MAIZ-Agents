// Renders an employee's job description (from the backend's pure data module)
// for the agent store page and the team builder in the app.
import { JOB_DESCRIPTIONS, energyText, getJobDescription, type JobDescription } from "../../src/modules/workforce/job-descriptions";

export { JOB_DESCRIPTIONS, getJobDescription };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ul = (xs: readonly string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

export function jdHtml(jd: JobDescription): string {
  return `<div class="jd-body">
  <p class="jd-meta">${esc(jd.department)} · reports to the ${esc(jd.reportsTo.toLowerCase())}</p>
  <h4>Role summary</h4><p>${esc(jd.purpose)}</p>
  <h4>Key responsibilities</h4>${jd.responsibilities.map((r) => `<p class="jd-area">${esc(r.area)}</p>${ul(r.duties)}`).join("")}
  <h4>Skills and competencies</h4>
  <table class="jd-table"><thead><tr><th>Skill</th><th>Level</th></tr></thead><tbody>${jd.competencies.map((c) => `<tr><td><b>${esc(c.skill)}</b><span>${esc(c.detail)}</span></td><td><span class="jd-lvl jd-${c.level.toLowerCase()}">${c.level}</span></td></tr>`).join("")}</tbody></table>
  <h4>Legal requirements it knows and applies</h4>${ul(jd.legal)}
  <h4>Documents and records it keeps up to date</h4>${ul(jd.records)}
  <h4>Knowledge and standards</h4>${ul(jd.knowledge)}
  <h4>Deliverables</h4>
  <table class="jd-table"><thead><tr><th>Deliverable</th><th>Typical energy</th></tr></thead><tbody>${jd.deliverables.map((d) => `<tr><td><b>${esc(d.name)}</b><span>${esc(d.cadence)}</span></td><td class="mono">${energyText(d)}</td></tr>`).join("")}</tbody></table>
  <p class="jd-note">Energy is an estimate. You are only charged what the work really uses.</p>
  <h4>How you will know it is working</h4>${ul(jd.kpis)}
  <h4>What it may do</h4>
  <div class="jd-auth"><div><p class="jd-area">On its own, as drafts</p>${ul(jd.authority.autonomous)}</div><div><p class="jd-area">Only with your approval</p>${ul(jd.authority.needsApproval)}</div><div><p class="jd-area">Never</p>${ul(jd.authority.never)}</div></div>
  <h4>Tools</h4>${ul(jd.tools.map((t) => `${t.name}${t.status === "planned" ? " (coming soon)" : ""}`))}
  <h4>When it brings in a qualified person</h4>${ul(jd.escalate)}
  <h4>What it needs from you to take over</h4>${ul(jd.handover)}
</div>`;
}
