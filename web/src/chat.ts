// One conversation per employee (#chat/<employee>): what you asked, what came back, follow-ups that remember it,
// answers that stream in as they are written, and queued answers that land here when the batch finishes.
import { api, getToken, type Org } from "./api";
import { askStream, describeOutcome } from "./stream";
import { toast } from "./common";

interface Turn { id: string; role: "you" | "employee"; text: string; at: string; status?: "answered" | "queued" | "failed" | "no_energy"; checked?: boolean; runsAt?: string; feedback?: "up" | "down" | "redo"; edited?: boolean }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const time = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

let team: Org["team"] = [];
let current: Org["team"][number] | undefined;
let busy = false;
let confirmClear = false;
let turns: Turn[] = [];
/** The note or edit box open under one answer. */
let panel: { id: string; mode: "down" | "redo" | "edit" } | undefined;
const FEEDBACK_NOTE: Record<string, string> = { up: "Marked as good", down: "You said this was not right", redo: "You asked for a redo" };

function actionsHtml(t: Turn): string {
  if (panel?.id === t.id) {
    const edit = panel.mode === "edit";
    const label = edit ? "Change the words" : panel.mode === "redo" ? "What should be different? (optional)" : "What was not right? (optional)";
    const field = edit
      ? `<textarea class="input" rows="5" maxlength="8000" data-fb-text>${esc(t.text)}</textarea>`
      : `<input class="input" type="text" maxlength="200" data-fb-note placeholder="For example: shorter, friendlier, mention free delivery">`;
    return `<form class="fb-form" data-fb-form="${esc(t.id)}"><label class="small"><span class="muted">${label}</span>${field}</label><span class="fb-row"><button type="submit" class="btn btn-sm btn-primary">${edit ? "Save my version" : panel.mode === "redo" ? "Redo it" : "Send"}</button><button type="button" class="btn btn-sm btn-quiet" data-fb-cancel>Cancel</button></span></form>`;
  }
  const said = t.feedback ? `<span class="small muted">${esc(FEEDBACK_NOTE[t.feedback] ?? "")}.</span> ` : "";
  const btn = (k: string, text: string) => `<button type="button" class="btn btn-sm btn-quiet" data-fb="${k}" data-turn="${esc(t.id)}">${text}</button>`;
  return `<div class="fb-row">${said}${btn("up", "Good")}${btn("down", "Not right")}${btn("redo", "Redo")}${btn("edit", "Edit")}</div>`;
}

function turnHtml(t: Turn, who: string): string {
  if (t.role === "you") return `<div class="turn turn-you"><span class="small muted">You · ${esc(time(t.at))}</span><p>${esc(t.text)}</p></div>`;
  const state = t.status === "queued"
    ? `<span class="badge">Queued${t.runsAt ? ` for ${esc(time(t.runsAt))}` : ""}</span>`
    : t.status === "answered" ? `<span class="badge">${t.edited ? "Edited by you" : t.checked ? "Checked" : "Draft for you to review"}</span>` : "";
  return `<div class="turn turn-them${t.status === "failed" || t.status === "no_energy" ? " turn-note" : ""}"><span class="small muted">${esc(who)} · ${esc(time(t.at))} ${state}</span><p class="turn-text">${esc(t.text)}</p>${t.status === "answered" ? actionsHtml(t) : ""}</div>`;
}

function renderThread(): void {
  if (!current) return;
  $("chat-thread").innerHTML = turns.length
    ? turns.map((t) => turnHtml(t, current!.name)).join("")
    : `<p class="small muted">Nothing here yet. Ask ${esc(current.name)} something below. Follow-up questions remember what you said before. Tell ${esc(current.name)} what you like and what you do not, and it will remember.</p>`;
  $("chat-clear").hidden = turns.length === 0;
}

async function loadThread(): Promise<void> {
  if (!current) return;
  const r = await api<{ turns: Turn[] }>(`/conversations/${current.id}`);
  turns = r.data?.turns ?? [];
  renderThread();
  const box = $("chat-thread");
  box.scrollTop = box.scrollHeight;
}

/** Sends feedback on one answer, then shows what the team took from it. A redo also asks again. */
async function sendFeedback(turnId: string, kind: "up" | "down" | "redo" | "edit", note?: string, text?: string): Promise<void> {
  if (!current) return;
  const r = await api<{ learned: string[]; turns: Turn[]; error?: string }>("/feedback", { body: { employeeId: current.id, turnId, kind, note, text } });
  if (!r.ok || !r.data) { toast((r.data as { error?: string } | undefined)?.error ?? "That could not be saved. Try again."); return; }
  turns = r.data.turns;
  panel = undefined;
  renderThread();
  const learned = r.data.learned;
  toast(learned.length ? `Noted: ${learned[0]}` : kind === "up" ? "Thanks, noted." : "Noted.");
  if (kind === "redo") {
    $<HTMLTextAreaElement>("chat-in").value = `Please redo your last answer.${note ? ` ${note}` : ""}`;
    $<HTMLFormElement>("chat-form").requestSubmit();
  }
}

function pick(key: string): void {
  current = team.find((e) => e.templateKey === key) ?? team.find((e) => e.templateKey === "business-consultant") ?? team[0];
  if (!current) { $("chat-body").hidden = true; $("chat-empty").hidden = false; return; }
  $("chat-body").hidden = false; $("chat-empty").hidden = true;
  $("chat-title").textContent = `Conversation with ${current.name}`;
  $("chat-pick").innerHTML = team.map((e) => `<a class="chip" href="#chat/${esc(e.templateKey)}"${e.id === current!.id ? ' aria-current="page"' : ""}>${esc(e.name)}</a>`).join("");
  confirmClear = false;
  panel = undefined;
  $("chat-clear").textContent = "Clear this conversation";
  void loadThread();
}

/** Called by the router each time the conversation screen opens. */
export async function showChat(key: string): Promise<void> {
  if (!getToken()) { $("chat-body").hidden = true; $("chat-empty").hidden = false; return; }
  if (!team.length) {
    const r = await api<Org>("/org");
    team = r.data?.team ?? [];
  }
  pick(key);
}

export function initChat(): void {
  $<HTMLFormElement>("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLTextAreaElement>("chat-in");
    const text = input.value.trim();
    if (!text || !current || busy) return;
    busy = true;
    const emp = current;
    $<HTMLButtonElement>("chat-send").disabled = true;
    const thread = $("chat-thread");
    thread.setAttribute("aria-busy", "true");
    thread.insertAdjacentHTML("beforeend", `<div class="turn turn-you"><span class="small muted">You</span><p>${esc(text)}</p></div><div class="turn turn-them"><span class="small muted">${esc(emp.name)}</span><p class="turn-text" id="chat-live">${esc(emp.name)} is on it…</p></div>`);
    thread.scrollTop = thread.scrollHeight;
    const live = $("chat-live");
    let started = false;
    const result = await askStream({ text, employeeId: emp.id }, {
      onDelta: (piece) => { if (!started) { started = true; live.textContent = ""; } live.textContent += piece; thread.scrollTop = thread.scrollHeight; },
      onReset: () => { started = false; live.textContent = `${emp.name} is on it…`; },
    });
    thread.setAttribute("aria-busy", "false");
    busy = false;
    $<HTMLButtonElement>("chat-send").disabled = false;
    if (!result.ok) {
      live.textContent = result.message ?? "I could not reach your team. Your question is still in the box, so you can send it again.";
      return; // the question stays in the box
    }
    input.value = "";
    // Reload from the server so what is shown is exactly what was saved (and the final, checked answer replaces the stream).
    const out = describeOutcome(emp.name, result.done);
    if (out.kind === "note") live.textContent = out.text;
    await loadThread();
    input.focus();
  });
  const thread = $("chat-thread");
  thread.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("[data-fb]");
    if (b) {
      const kind = b.dataset.fb as "up" | "down" | "redo" | "edit";
      const id = b.dataset.turn!;
      if (kind === "up") { void sendFeedback(id, "up"); return; }
      panel = { id, mode: kind };
      renderThread();
      thread.querySelector<HTMLElement>("[data-fb-note], [data-fb-text]")?.focus();
      return;
    }
    if (t.closest("[data-fb-cancel]")) { panel = undefined; renderThread(); }
  });
  thread.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = (e.target as HTMLElement).closest<HTMLFormElement>("[data-fb-form]");
    if (!f || !panel) return;
    const note = f.querySelector<HTMLInputElement>("[data-fb-note]")?.value.trim();
    const text = f.querySelector<HTMLTextAreaElement>("[data-fb-text]")?.value;
    void sendFeedback(panel.id, panel.mode, note || undefined, text);
  });
  $("chat-clear").addEventListener("click", async () => {
    if (!current) return;
    if (!confirmClear) { confirmClear = true; $("chat-clear").textContent = "Click again to delete this conversation"; return; }
    await api(`/conversations/${current.id}/clear`, { method: "POST", body: {} });
    confirmClear = false;
    $("chat-clear").textContent = "Clear this conversation";
    await loadThread();
  });
  $("chat-in").addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && !k.shiftKey && !k.isComposing) { k.preventDefault(); $<HTMLFormElement>("chat-form").requestSubmit(); }
  });
}
