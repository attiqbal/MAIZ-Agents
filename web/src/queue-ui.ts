// "Waiting for the batch" on the client's Tasks screen. Work that can wait is collected and sent to the
// AI together at the client's closing time. The client sees what is queued and when it runs, can run it
// now, cancel a task, and change the closing time. The rules live in src/modules/batch and are tested there.
import { api, getToken } from "./api";
import { toast } from "./common";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Job { id: string; brief: string; status: string; runsAtLabel?: string; problem?: string; deliverable?: string }
interface QueueView {
  schedule: { enabled: boolean; timezone: string; closingTime: string; skipWeekends: boolean; midnightSweep: boolean };
  nextRunLabel: string; queued: number; jobs: Job[]; realTime: { what: string; why: string }[];
}

const EXAMPLE: QueueView = {
  schedule: { enabled: true, timezone: "Europe/London", closingTime: "18:00", skipWeekends: false, midnightSweep: true },
  nextRunLabel: "Today, 6:00 pm", queued: 2, realTime: [],
  jobs: [
    { id: "x1", brief: "Plan next month's social posts", status: "queued", runsAtLabel: "Today, 6:00 pm" },
    { id: "x2", brief: "Categorise last week's receipts", status: "queued", runsAtLabel: "Today, 6:00 pm" },
    { id: "x3", brief: "Draft the supplier price review", status: "done" },
  ],
};

let view: QueueView = EXAMPLE;
let live = false;
const STATUS: Record<string, string> = { queued: "Waiting", running: "Running now", done: "Filed", failed: "Could not finish", cancelled: "Cancelled" };

function render(): void {
  const s = view.schedule;
  $("q-count").textContent = view.queued ? `${view.queued} waiting · next run ${view.nextRunLabel}` : "Nothing waiting";
  const run = $<HTMLButtonElement>("q-run");
  run.disabled = view.queued === 0;
  run.title = view.queued === 0 ? "Nothing is waiting. Work you send appears here until the next batch." : "Run everything that is waiting now, instead of at the next batch";
  $("q-list").innerHTML = view.jobs.map((j) => `<div class="q-row"><div><b>${esc(j.brief)}</b><span class="hint">${esc(STATUS[j.status] ?? j.status)}${j.runsAtLabel ? ` · runs ${esc(j.runsAtLabel)}` : ""}${j.problem ? ` · ${esc(j.problem)}` : ""}</span></div>${j.status === "queued" ? `<button type="button" class="btn btn-quiet btn-sm" data-q-cancel="${esc(j.id)}" aria-label="Cancel: ${esc(j.brief)}">Cancel</button>` : ""}</div>`).join("") || `<p class="all-clear">Nothing queued. Quick questions and urgent work are answered at once.</p>`;
  $<HTMLInputElement>("q-time").value = s.closingTime;
  $<HTMLInputElement>("q-tz").value = s.timezone;
  $<HTMLInputElement>("q-weekends").checked = s.skipWeekends;
  $<HTMLInputElement>("q-sweep").checked = s.midnightSweep !== false;
}

async function act(path: string, ok: string): Promise<void> {
  if (!live) { toast("Example data: sign in to use your own queue."); return; }
  const r = await api<QueueView & { error?: string }>(path, { body: {} });
  if (!r.ok || !r.data) { toast(r.data?.error ? `${r.data.error[0]!.toUpperCase()}${r.data.error.slice(1)}` : "That did not work. Try again."); return; }
  view = r.data; render(); toast(ok);
}

export async function initQueue(): Promise<void> {
  render();
  $("q-run").addEventListener("click", () => void act("/queue/run-now", "Sent. Your finished work will appear here."));
  $("q-list").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-q-cancel]");
    if (b) void act(`/queue/${encodeURIComponent(b.dataset.qCancel!)}/cancel`, "Cancelled.");
  });
  $<HTMLFormElement>("q-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!live) { toast("Example data: sign in to change your schedule."); return; }
    const r = await api<QueueView & { error?: string }>("/batch/schedule", { body: { closingTime: $<HTMLInputElement>("q-time").value, timezone: $<HTMLInputElement>("q-tz").value.trim(), skipWeekends: $<HTMLInputElement>("q-weekends").checked, midnightSweep: $<HTMLInputElement>("q-sweep").checked } });
    if (!r.ok || !r.data) { toast(r.data?.error ? `${r.data.error[0]!.toUpperCase()}${r.data.error.slice(1)}` : "Could not save. Try again."); return; }
    view = r.data; render(); toast("Saved. Waiting tasks moved to the new time.");
  });
  if (!getToken()) return;
  const r = await api<QueueView>("/queue");
  if (r.ok && r.data) { view = r.data; live = true; render(); }
}
