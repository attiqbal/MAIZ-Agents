// One conversation per employee (#chat/<employee>): what you asked, what came back, follow-ups that remember it,
// answers that stream in as they are written, and queued answers that land here when the batch finishes.
import { api, getToken, type Org } from "./api";
import { askStream, describeOutcome } from "./stream";

interface Turn { id: string; role: "you" | "employee"; text: string; at: string; status?: "answered" | "queued" | "failed" | "no_energy"; checked?: boolean; runsAt?: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const time = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

let team: Org["team"] = [];
let current: Org["team"][number] | undefined;
let busy = false;
let confirmClear = false;

function turnHtml(t: Turn, who: string): string {
  if (t.role === "you") return `<div class="turn turn-you"><span class="small muted">You · ${esc(time(t.at))}</span><p>${esc(t.text)}</p></div>`;
  const state = t.status === "queued"
    ? `<span class="badge">Queued${t.runsAt ? ` for ${esc(time(t.runsAt))}` : ""}</span>`
    : t.status === "answered" ? `<span class="badge">${t.checked ? "Checked" : "Draft for you to review"}</span>` : "";
  return `<div class="turn turn-them${t.status === "failed" || t.status === "no_energy" ? " turn-note" : ""}"><span class="small muted">${esc(who)} · ${esc(time(t.at))} ${state}</span><p class="turn-text">${esc(t.text)}</p></div>`;
}

async function loadThread(): Promise<void> {
  if (!current) return;
  const r = await api<{ turns: Turn[] }>(`/conversations/${current.id}`);
  const turns = r.data?.turns ?? [];
  $("chat-thread").innerHTML = turns.length
    ? turns.map((t) => turnHtml(t, current!.name)).join("")
    : `<p class="small muted">Nothing here yet. Ask ${esc(current.name)} something below. Follow-up questions remember what you said before.</p>`;
  $("chat-clear").hidden = turns.length === 0;
  const box = $("chat-thread");
  box.scrollTop = box.scrollHeight;
}

function pick(key: string): void {
  current = team.find((e) => e.templateKey === key) ?? team.find((e) => e.templateKey === "business-consultant") ?? team[0];
  if (!current) { $("chat-body").hidden = true; $("chat-empty").hidden = false; return; }
  $("chat-body").hidden = false; $("chat-empty").hidden = true;
  $("chat-title").textContent = `Conversation with ${current.name}`;
  $("chat-pick").innerHTML = team.map((e) => `<a class="chip" href="#chat/${esc(e.templateKey)}"${e.id === current!.id ? ' aria-current="page"' : ""}>${esc(e.name)}</a>`).join("");
  confirmClear = false;
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
