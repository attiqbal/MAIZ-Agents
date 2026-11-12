// "Suggested for you" on Home: things the records say are worth a look, worded without any AI (so they cost no energy).
import { api, getToken } from "./api";

interface Suggestion {
  id: string; severity: "high" | "medium" | "low"; title: string; detail: string;
  action: { label: string; href: string } | { label: string; ask: { employee: string; text: string } };
}

const DISMISS_KEY = "maiz.dismissedSuggestions";
const DISMISS_DAYS = 3;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function dismissed(): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now));
  } catch { return {}; }
}
function dismiss(id: string): void {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify({ ...dismissed(), [id]: Date.now() + DISMISS_DAYS * 86_400_000 })); } catch { /* storage blocked: it returns next visit */ }
}

/** `onAsk` puts a ready-made question in the ask bar for the person to send. */
export async function initSuggestions(onAsk: (employee: string, text: string) => void): Promise<void> {
  if (!getToken()) return;
  const r = await api<{ suggestions: Suggestion[] }>("/suggestions");
  const panel = $("suggest");
  const draw = (): void => {
    const skip = dismissed();
    const list = (r.data?.suggestions ?? []).filter((s) => !skip[s.id]);
    panel.hidden = list.length === 0;
    $("suggest-list").innerHTML = list.map((s) => {
      const act = "href" in s.action
        ? `<a class="btn btn-sm btn-primary" href="${esc(s.action.href)}">${esc(s.action.label)}</a>`
        : `<button type="button" class="btn btn-sm btn-primary" data-ask="${esc(s.id)}">${esc(s.action.label)}</button>`;
      return `<div class="need${s.severity === "high" ? " hi" : ""}"><b>${esc(s.title)}</b><span class="d">${esc(s.detail)}</span><div class="acts">${act}<button type="button" class="btn btn-sm btn-ghost" data-dismiss="${esc(s.id)}">Not now</button></div></div>`;
    }).join("");
    $("suggest-list").querySelectorAll<HTMLButtonElement>("[data-dismiss]").forEach((b) => b.addEventListener("click", () => { dismiss(b.dataset.dismiss!); draw(); }));
    $("suggest-list").querySelectorAll<HTMLButtonElement>("[data-ask]").forEach((b) => b.addEventListener("click", () => {
      const s = list.find((x) => x.id === b.dataset.ask);
      if (s && "ask" in s.action) onAsk(s.action.ask.employee, s.action.ask.text);
    }));
  };
  if (r.ok) draw();
}
