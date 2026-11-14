// The conversation surface for the first day: a thread of messages from the people on the team,
// the owner's replies, and a reply area that holds whatever control the current question needs.
// Messages are plain text only (escaped), so nothing typed or fetched can inject markup.
import { personaFor, type Persona } from "../../src/modules/onboarding/people";

export interface LogEntry { who: string; text: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const reduced = (): boolean => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches || location.search.includes("fast=1"); } catch { return false; } };
export const pause = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, reduced() ? 0 : ms));

let people = new Map<string, Persona>();
export function setPeople(list: Persona[]): void { people = new Map(list.map((p) => [p.key, p])); }
export const who = (key: string): Persona => people.get(key) ?? personaFor(key);

function bubble(entry: LogEntry): HTMLElement {
  const mine = entry.who === "you";
  const el = document.createElement("div");
  el.className = `fd-msg${mine ? " mine" : ""}`;
  if (mine) {
    el.innerHTML = `<div class="fd-bub"><span class="sr-only">You: </span>${esc(entry.text).replace(/\n/g, "<br>")}</div>`;
    return el;
  }
  const p = who(entry.who);
  el.innerHTML = `<span class="av ${p.avatar}" aria-hidden="true">${esc(p.initials)}</span><div class="fd-bub"><b class="fd-name">${esc(p.name)} <span>${esc(p.role)}</span></b>${esc(entry.text).replace(/\n/g, "<br>")}</div>`;
  return el;
}

function scroll(): void {
  // Scroll the thread itself, never the page, so the heading and roster stay where they are.
  const log = $("fd-log");
  log.scrollTo({ top: log.scrollHeight, behavior: reduced() ? "auto" : "smooth" });
}

/** Draws a saved message instantly (used when the owner comes back). */
export function paint(entry: LogEntry): void { $("fd-log").appendChild(bubble(entry)); }
export function clearLog(): void { $("fd-log").innerHTML = ""; }

/** A person speaks: a short "typing" moment, then the message. */
export async function speak(entry: LogEntry): Promise<void> {
  const log = $("fd-log");
  if (!reduced()) {
    const p = who(entry.who);
    const t = document.createElement("div");
    t.className = "fd-msg fd-typing";
    t.innerHTML = `<span class="av ${p.avatar}" aria-hidden="true">${esc(p.initials)}</span><div class="fd-bub" aria-hidden="true"><i></i><i></i><i></i></div>`;
    log.appendChild(t);
    scroll();
    await pause(Math.min(1100, 350 + entry.text.length * 9));
    t.remove();
  }
  log.appendChild(bubble(entry));
  scroll();
}

export function showWho(key: string | undefined): void {
  document.querySelectorAll<HTMLElement>("#fd-roster [data-who]").forEach((el) => el.classList.toggle("on", el.dataset.who === key));
}

export function drawRoster(keys: string[], met: Set<string>): void {
  $("fd-roster").innerHTML = keys.map((k) => {
    const p = who(k);
    return `<div class="fd-card${met.has(k) ? " met" : ""}" data-who="${esc(k)}"><span class="av ${p.avatar}" aria-hidden="true">${esc(p.initials)}</span><span><b>${esc(p.name)}</b><span class="fd-role">${esc(p.role)}</span><span class="fd-state">${met.has(k) ? "Here" : "On their way"}</span></span></div>`;
  }).join("");
}

/** Puts a control in the reply area. Resolves when the owner answers; the answer is written into the thread. */
export function reply<T>(build: (host: HTMLElement, done: (value: T, said: string) => void) => void, onSaid?: (said: string) => void): Promise<T> {
  const host = $("fd-reply");
  return new Promise<T>((resolve) => {
    host.innerHTML = "";
    host.removeAttribute("hidden");
    build(host, (value, said) => {
      host.innerHTML = "";
      onSaid?.(said);
      if (said) { paint({ who: "you", text: said }); scroll(); }
      resolve(value);
    });
    const first = host.querySelector<HTMLElement>("input, textarea, select, button");
    if (first && !reduced()) first.focus({ preventScroll: true });
    else first?.focus({ preventScroll: true });
  });
}

export function chips(host: HTMLElement, label: string, options: { v: string; label: string; quiet?: boolean }[], pick: (v: string, label: string) => void): void {
  const wrap = document.createElement("div");
  wrap.className = "fd-opts";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", label);
  wrap.innerHTML = options.map((o) => `<button type="button" class="chip${o.quiet ? " quiet" : ""}" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join("");
  wrap.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
    if (b) pick(b.dataset.v ?? "", b.textContent ?? "");
  });
  host.appendChild(wrap);
}

export function note(host: HTMLElement, text: string, tone: "err" | "hint" = "hint"): HTMLElement {
  const p = document.createElement("p");
  p.className = tone === "err" ? "err" : "hint";
  if (tone === "err") p.setAttribute("role", "alert");
  p.textContent = text;
  host.appendChild(p);
  return p;
}
