// "What your team knows": the preferences and business profile the team has learned, all editable and deletable.
import { api, getToken } from "./api";
import { toast } from "./common";

interface Lesson { id: string; text: string; scope: string; source: string; count: number }
interface Fact { id: string; kind: string; text: string; source: string; edited?: boolean }
interface View { lessons: Lesson[]; facts: Fact[]; totals: { up: number; down: number; redo: number; edit: number }; window: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SOURCE: Record<string, string> = { signup: "From your signup", website: "From your website", connection: "From your connected apps", activity: "From your work", you: "Written by you", note: "From your note", edit: "From your edits", redo: "From a redo", rating: "From your rating" };
const KIND: Record<string, string> = { about: "About", how: "How you work", tool: "Tools", recurring: "Regular job", tone: "Tone" };
const SCOPE: Record<string, string> = { all: "Whole team", "marketing-manager": "Marketing", "finance-manager": "Finance", "business-consultant": "Consultant", "hr-manager": "HR", "compliance-manager": "Compliance", "admin-manager": "Admin" };
let editing: string | undefined;
let confirmForget = false;

function render(v: View): void {
  const t = v.totals;
  $("learn-totals").textContent = t.up + t.down + t.redo + t.edit ? `Last ${v.window} signals: ${t.up} good, ${t.down} not right, ${t.redo} redo, ${t.edit} edited` : "No feedback yet";
  $("learn-lessons").innerHTML = v.lessons.length
    ? v.lessons.map((l) => `<li><span class="k-text">${esc(l.text)} <span class="small muted">${esc(SCOPE[l.scope] ?? l.scope)} · ${esc(SOURCE[l.source] ?? l.source)}${l.count > 1 ? ` · said ${l.count} times` : ""}</span></span><button type="button" class="btn btn-sm btn-quiet" data-del-lesson="${esc(l.id)}">Delete</button></li>`).join("")
    : `<li><span class="small muted">Nothing yet. Use Good, Not right, Redo or Edit under an answer in Conversations, or add a line below.</span></li>`;
  $("learn-facts").innerHTML = v.facts.length
    ? v.facts.map((f) => editing === f.id
      ? `<li><form class="know-form" data-fact-form="${esc(f.id)}" style="margin:0;flex:1"><label class="sr-only" for="fact-edit">Change this line</label><input class="input" id="fact-edit" maxlength="240" value="${esc(f.text)}"><button class="btn btn-sm btn-primary" type="submit">Save</button><button class="btn btn-sm btn-quiet" type="button" data-cancel>Cancel</button></form></li>`
      : `<li><span class="k-text"><b>${esc(KIND[f.kind] ?? f.kind)}:</b> ${esc(f.text)} <span class="small muted">${esc(SOURCE[f.source] ?? f.source)}</span></span><span><button type="button" class="btn btn-sm btn-quiet" data-edit-fact="${esc(f.id)}">Change</button> <button type="button" class="btn btn-sm btn-quiet" data-del-fact="${esc(f.id)}">Delete</button></span></li>`).join("")
    : `<li><span class="small muted">Nothing yet. Lines appear from your signup, your website, the apps you connect and the jobs you repeat.</span></li>`;
  $("learn-forget").textContent = confirmForget ? "Click again to delete everything" : "Forget everything";
}

async function send(path: string, method: string, body?: unknown): Promise<void> {
  const r = await api<View & { error?: string }>(path, { method, body: body ?? (method === "POST" ? {} : undefined) });
  if (!r.ok || !r.data) { toast(r.data?.error ?? "That could not be saved. Try again."); return; }
  editing = undefined; confirmForget = false;
  render(r.data);
}

export async function showLearning(): Promise<void> {
  const signedIn = !!getToken();
  $("learn-body").hidden = !signedIn; $("learn-empty").hidden = signedIn;
  if (!signedIn) return;
  const r = await api<View>("/learning");
  if (r.data) render(r.data);
}

export function initLearning(): void {
  $("learn-add-lesson").addEventListener("submit", async (e) => {
    e.preventDefault();
    const i = $<HTMLInputElement>("learn-lesson-in");
    await send("/learning/lessons", "POST", { text: i.value });
    i.value = "";
  });
  $("learn-add-fact").addEventListener("submit", async (e) => {
    e.preventDefault();
    const i = $<HTMLInputElement>("learn-fact-in");
    await send("/learning/facts", "POST", { kind: $<HTMLSelectElement>("learn-fact-kind").value, text: i.value });
    i.value = "";
  });
  $("learn-body").addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const l = t.closest<HTMLElement>("[data-del-lesson]"); if (l) { await send(`/learning/lessons/${l.dataset.delLesson}`, "DELETE"); return; }
    const d = t.closest<HTMLElement>("[data-del-fact]"); if (d) { await send(`/learning/facts/${d.dataset.delFact}`, "DELETE"); return; }
    const ed = t.closest<HTMLElement>("[data-edit-fact]");
    if (ed) { editing = ed.dataset.editFact; const r = await api<View>("/learning"); if (r.data) { render(r.data); $<HTMLInputElement>("fact-edit").focus(); } return; }
    if (t.closest("[data-cancel]")) { editing = undefined; const r = await api<View>("/learning"); if (r.data) render(r.data); }
  });
  $("learn-body").addEventListener("submit", async (e) => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>("[data-fact-form]");
    if (!f) return;
    e.preventDefault();
    await send("/learning/facts", "POST", { id: f.dataset.factForm, text: f.querySelector<HTMLInputElement>("input")!.value });
  });
  $("learn-forget").addEventListener("click", async () => {
    if (!confirmForget) { confirmForget = true; $("learn-forget").textContent = "Click again to delete everything"; return; }
    await send("/learning/forget", "POST");
  });
}
