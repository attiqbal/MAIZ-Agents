// Plan and billing: every monthly line the client pays for, and stopping one extra at the end of the month already paid for.
import { api } from "./api";
import { esc } from "./owner-common";
import { isBusy, keepFocus, setBusy } from "./keep-focus";

interface Line { orderId: string; key: string; title: string; qty: number; monthlyMinor: number; plan: boolean; state: "active" | "stopping"; renewsAt?: string; endsAt?: string; canStop: boolean }
interface View { enabled: boolean; lines: Line[]; monthlyMinor: number }

const pounds = (minor: number) => `£${(minor / 100).toLocaleString("en-GB", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const keyOf = (l: Line) => `${l.orderId}|${l.key}`;

let root: HTMLElement | undefined;
let msg: HTMLElement | undefined;
let view: View | undefined;
/** The line waiting for the client to confirm that it should stop. */
let asking: string | undefined;

function row(l: Line): string {
  const k = keyOf(l);
  const when = l.state === "stopping" ? `Works until ${day(l.endsAt!)}, then stops. Not charged again.` : `Renews on ${day(l.renewsAt!)}`;
  const what = `${l.qty > 1 ? `${l.qty} × ` : ""}${l.title}`;
  const action = l.state === "stopping" ? `<span class="status warn"><span class="dot"></span>Stopping</span>`
    : !l.canStop ? ""
    : asking === k ? `<span class="bl-sure" role="group" aria-label="Stop ${esc(what)}"><span class="small">Stop ${esc(what)} at the end of the month? It keeps working until then and is not charged again.</span><span class="acts"><button class="btn btn-sm btn-primary" type="button" data-bl="yes">Yes, stop it</button><button class="btn btn-sm btn-ghost" type="button" data-bl="no">Keep it</button></span></span>`
    : `<button class="btn btn-sm btn-ghost" type="button" data-bl="ask" aria-label="Stop ${esc(what)} at the end of the month">Stop at the end of the month</button>`;
  return `<li class="bl-row" data-id="${esc(k)}"><div class="bl-main"><b>${esc(what)}</b><span class="small muted">${esc(when)}</span></div><span class="bl-price mono">${pounds(l.monthlyMinor)} a month</span><div class="bl-act">${action}</div></li>`;
}

function draw(): void {
  if (!root || !view) return;
  if (!view.lines.length) { root.innerHTML = ""; root.hidden = true; return; }
  root.hidden = false;
  root.innerHTML = `<h3 id="bill-lines-h" class="bl-h">What you pay for each month</h3><ul class="bl-list" aria-labelledby="bill-lines-h">${view.lines.map(row).join("")}</ul><p class="small muted bl-total">Total each month: <b class="mono">${pounds(view.monthlyMinor)}</b>. Stopping something takes it off your next bill. Money you already paid is not refunded.</p>`;
}

function say(text: string): void { if (msg) msg.textContent = text; }

export async function loadBillingLines(): Promise<void> {
  const r = await api<View>("/billing/lines");
  if (!r.ok || !r.data) return;
  view = r.data;
  if (root) keepFocus(root, ".bl-row", "data-bl", draw, document.getElementById("bill-h"));
}

async function stop(btn: HTMLElement): Promise<void> {
  const rowEl = btn.closest<HTMLElement>(".bl-row");
  const line = view?.lines.find((l) => keyOf(l) === rowEl?.dataset.id);
  if (!line || isBusy(btn)) return;
  setBusy(btn, true);
  say("Stopping it…");
  const r = await api<View & { error?: string }>("/billing/lines/stop", { body: { orderId: line.orderId, key: line.key } });
  asking = undefined;
  if (r.ok && r.data) {
    view = r.data;
    say(`Done. ${line.title} works until the end of the month you paid for and is not charged again.`);
  } else {
    say(r.data?.error ?? "We could not stop this just now, so nothing has changed. Please try again in a few minutes.");
  }
  if (root) keepFocus(root, ".bl-row", "data-bl", draw, document.getElementById("bill-h"));
}

export function mountBillingLines(el: HTMLElement, status: HTMLElement): void {
  // Shown again each time Plan and billing is opened: the click handler is added once.
  if (root === el) { void loadBillingLines(); return; }
  root = el;
  msg = status;
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bl]");
    const id = b?.closest<HTMLElement>(".bl-row")?.dataset.id;
    if (!b || !id) return;
    const act = b.dataset.bl;
    if (act === "yes") { void stop(b); return; }
    asking = act === "ask" ? id : undefined;
    say("");
    if (root) keepFocus(root, ".bl-row", "data-bl", draw, document.getElementById("bill-h"));
  });
  void loadBillingLines();
}
