// My AI team (owner-team.html): the platform owner's own AI specialists, with their job descriptions, what each is
// doing now and what waits for approval. They are not store products and never appear in a client's package.
import "./styles.css";
import { initNav } from "./common";
import { jdHtml } from "./jd";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { OWNER_SPECIALISTS, type OwnerSpecialist } from "../../src/modules/promoter/owner-team";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Row = OwnerSpecialist & { status?: { waiting: number; doing: string; due: number } };

function render(rows: Row[]): void {
  $("tm-list").innerHTML = rows.map((s) => `<section class="panel" aria-labelledby="${esc(s.key)}-h">
    <div class="panel-h"><h2 id="${esc(s.key)}-h">${esc(s.title)}</h2><a class="btn btn-primary btn-sm r" href="${esc(s.page)}">Open workbench<span class="sr-only"> for ${esc(s.title)}</span></a></div>
    <p>${esc(s.summary)}</p>
    ${s.status ? `<p class="muted small">${s.status.waiting} waiting for your approval · ${esc(s.status.doing)}${s.status.due ? ` · ${s.status.due} follow-up${s.status.due === 1 ? "" : "s"} due` : ""}</p>` : ""}
    <details><summary>Job description</summary>${jdHtml(s.jobDescription, 3)}</details></section>`).join("");
}

void (async () => {
  const loaded = await ownerLoad<{ specialists: Row[] }>("/owner/team");
  if (loaded === undefined) return;
  if (loaded === "demo") markDemo();
  render(loaded === "demo" ? [...OWNER_SPECIALISTS] : loaded.specialists);
})();
