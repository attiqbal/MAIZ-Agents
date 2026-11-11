// Prices and packages (owner-prices.html): the platform owner edits package prices, trial terms,
// the team's energy pool, optional per-agent daily caps and every store price. Only changed fields are sent, as one change that
// starts now or on a chosen date. The server keeps the history with what each value replaced.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, gbp, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { CATALOGUE } from "../../src/modules/store/cart";
import { EMPLOYEE_TEMPLATES } from "../../src/modules/workforce/templates";
import type { GeneralPrices, PriceBookView, PriceChange, PriceChangeSet } from "../../src/modules/pricing/index";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Book = PriceBookView & { history: (PriceChange & { upcoming: boolean })[] };

const GENERAL: [keyof GeneralPrices, string, string, string][] = [
  ["basicPackageMonthlyGbp", "Basic package, per month", "£", "The core team every client starts with"],
  ["addOnEmployeeMonthlyGbp", "Add-on employee, per month", "£", "Each ready-made employee beyond the package"],
  ["specialistStandardMonthlyGbp", "Specialist (standard), per month", "£", "Blueprint and custom specialists"],
  ["specialistPremiumMonthlyGbp", "Specialist (premium), per month", "£", "Roles near regulated work"],
  ["overageGbpPer100Energy", "Extra energy, per 100", "£", "Only with the client's approval"],
  ["trialDays", "Free trial length", "days", "For new sign-ups"],
  ["trialTeamEnergy", "Trial energy, whole trial", "energy", "Shared by the team for the entire trial"],
  ["weeklyTeamEnergy", "Team energy per week", "energy", "Shared by the basic team, refills every Monday"],
  ["dailyTeamCeiling", "Daily safety limit", "energy", "Most the team can use in one day"],
  ["addOnWeeklyEnergy", "Add-on employee adds, per week", "energy", "Added to the team pool"],
  ["specialistStandardWeeklyEnergy", "Specialist (standard) adds, per week", "energy", "Added to the team pool"],
  ["specialistPremiumWeeklyEnergy", "Specialist (premium) adds, per week", "energy", "Added to the team pool"],
];

function demo(): Book {
  // Demo copy of the launch defaults (src/modules/pricing DEFAULT_GENERAL); importing that module would pull server code in.
  const general: GeneralPrices = {
    basicPackageMonthlyGbp: 100, addOnEmployeeMonthlyGbp: 20, specialistStandardMonthlyGbp: 30, specialistPremiumMonthlyGbp: 30, overageGbpPer100Energy: 1,
    trialDays: 7, trialTeamEnergy: 3_000, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000, addOnWeeklyEnergy: 2_000, specialistStandardWeeklyEnergy: 2_000, specialistPremiumWeeklyEnergy: 2_000,
  };
  return {
    general,
    items: CATALOGUE.map((i) => ({ ...i, available: true })),
    agents: EMPLOYEE_TEMPLATES.map((t) => ({ key: t.key, title: t.title, dailyEnergy: null, custom: false })),
    history: [],
  };
}

let book: Book;
let live = false;
let kind: "employee" | "specialist" | "consultant" = "consultant";
/** Pending edits, keyed by the input's data-k (for example "general.trialDays", "items.x.priceGbp", "agents.y"). */
const edits = new Map<string, number | boolean | null>();

const numIn = (k: string, value: number | string, label: string, step = "1") =>
  `<input class="input" type="number" min="0" step="${step}" inputmode="decimal" data-k="${esc(k)}" value="${esc(String(value))}" aria-label="${esc(label)}">`;

function renderGeneral(): void {
  $("pr-general").innerHTML = GENERAL.map(([k, label, unit, hint]) => {
    const id = `pr-g-${k}`;
    return `<div class="field"><label for="${id}">${esc(label)}${unit === "£" ? " (£)" : unit === "days" ? " (days)" : ""}</label><input class="input" id="${id}" type="number" min="0" step="${unit === "£" ? "0.01" : "1"}" inputmode="decimal" data-k="general.${k}" value="${book.general[k]}"><span class="hint">${esc(hint)}</span></div>`;
  }).join("");
}

function renderAgents(): void {
  const rows = book.agents.map((a) => `<tr><td class="ow-title"><b>${esc(a.title)}</b><span>${a.custom ? "Own daily cap" : "Draws from the team pool"}</span></td>
    <td class="num">${a.dailyEnergy === null ? "No cap" : a.dailyEnergy.toLocaleString("en-GB")}</td>
    <td><input class="input" type="number" min="0" step="1" inputmode="numeric" data-k="agents.${esc(a.key)}" value="${a.custom && a.dailyEnergy !== null ? a.dailyEnergy : ""}" placeholder="No cap" aria-label="Daily energy cap for ${esc(a.title)}"></td></tr>`).join("");
  $("pr-agents").innerHTML = `<thead><tr><th scope="col">Agent</th><th scope="col" class="num">Daily cap now</th><th scope="col">New daily cap</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderItems(): void {
  const kinds = [["consultant", "Consultant passes"], ["employee", "Add-on employees"], ["specialist", "Specialists"]] as const;
  $("pr-kind").innerHTML = kinds.map(([k, l]) => `<button type="button" class="chip" aria-pressed="${k === kind}" data-kind="${k}">${l} (${book.items.filter((i) => i.kind === k).length})</button>`).join("");
  const pass = kind === "consultant";
  const rows = book.items.filter((i) => i.kind === kind).map((i) => {
    const k = `items.${i.key}`;
    return `<tr><td class="ow-title"><b>${esc(i.title)}</b><span>${esc(i.group)} · ${i.billing === "monthly" ? "monthly" : "paid once"}</span></td>
      <td>${numIn(`${k}.priceGbp`, i.priceGbp, `Price of ${i.title} in pounds`, "0.01")}</td>
      ${pass ? `<td>${numIn(`${k}.energy`, i.energy ?? 0, `Energy included with ${i.title}`)}</td><td>${numIn(`${k}.days`, i.days ?? 0, `Days in ${i.title}`)}</td>` : ""}
      <td><label class="ow-check"><input type="checkbox" data-k="${esc(k)}.available"${i.available ? " checked" : ""}>In the store</label></td></tr>`;
  }).join("");
  $("pr-items").innerHTML = `<thead><tr><th scope="col">Item</th><th scope="col">Price (£)</th>${pass ? '<th scope="col">Energy included</th><th scope="col">Days</th>' : ""}<th scope="col">Shown</th></tr></thead><tbody>${rows}</tbody>`;
  // Keep pending edits visible after switching tabs.
  for (const [k, v] of edits) {
    const el = document.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(k)}"]`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(v); else el.value = v === null ? "" : String(v);
  }
}

const label = (path: string): string => {
  const [scope, a, b] = path.split(".");
  if (scope === "general") return GENERAL.find(([k]) => k === a)?.[1] ?? a!;
  if (scope === "agents") return `${book.agents.find((x) => x.key === a)?.title ?? a} daily cap`;
  const item = book.items.find((x) => x.key === a)?.title ?? a;
  return `${item}: ${b === "priceGbp" ? "price" : b === "available" ? "in the store" : b}`;
};
const show = (path: string, v: unknown): string => {
  if (v === null || v === undefined) return "no cap";
  if (typeof v === "boolean") return v ? "on" : "off";
  return path.endsWith("Gbp") || path.endsWith("priceGbp") || path.includes("Gbp") ? gbp(Number(v)) : Number(v).toLocaleString("en-GB");
};

function renderHistory(): void {
  $("pr-history").innerHTML = book.history.map((c) => {
    const lines = Object.entries(flatten(c.set)).map(([k, v]) => `<li>${esc(label(k))}: ${esc(show(k, c.from[k]))} to <b>${esc(show(k, v))}</b></li>`).join("");
    const when = new Date(c.effectiveFrom).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<li><span>${c.upcoming ? `<span class="status warn"><span class="dot"></span>Starts ${esc(when)}</span>` : `Since ${esc(when)}`}${c.note ? ` · ${esc(c.note)}` : ""}</span><ul>${lines}</ul>${c.upcoming && live ? `<span><button type="button" class="btn btn-quiet btn-sm" data-cancel="${esc(c.id)}">Call off this change</button></span>` : ""}</li>`;
  }).join("") || `<li class="muted">No changes yet. Launch prices are in force.</li>`;
}

function flatten(set: PriceChangeSet): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set.general ?? {})) out[`general.${k}`] = v;
  for (const [key, s] of Object.entries(set.items ?? {})) for (const [f, v] of Object.entries(s)) out[`items.${key}.${f}`] = v;
  for (const [k, v] of Object.entries(set.agents ?? {})) out[`agents.${k}`] = v;
  return out;
}

/** Turns pending edits into the change the API expects. */
function changeSet(): PriceChangeSet {
  const set: { general: Record<string, number>; items: Record<string, Record<string, number | boolean>>; agents: Record<string, number | null> } = { general: {}, items: {}, agents: {} };
  for (const [path, v] of edits) {
    const [scope, a, b] = path.split(".") as [string, string, string?];
    if (scope === "general") set.general[a] = v as number;
    else if (scope === "agents") set.agents[a] = v as number | null;
    else (set.items[a] ??= {})[b!] = v as number | boolean;
  }
  return {
    ...(Object.keys(set.general).length ? { general: set.general as Partial<GeneralPrices> } : {}),
    ...(Object.keys(set.items).length ? { items: set.items } : {}),
    ...(Object.keys(set.agents).length ? { agents: set.agents } : {}),
  };
}

function current(path: string): unknown {
  const [scope, a, b] = path.split(".");
  if (scope === "general") return book.general[a as keyof GeneralPrices];
  if (scope === "agents") { const ag = book.agents.find((x) => x.key === a); return ag?.custom ? ag.dailyEnergy : null; }
  const it = book.items.find((x) => x.key === a) as Record<string, unknown> | undefined;
  return it?.[b!];
}

function track(el: HTMLInputElement): void {
  const k = el.dataset.k!;
  const v = el.type === "checkbox" ? el.checked : el.value.trim() === "" ? (k.startsWith("agents.") ? null : NaN) : Number(el.value);
  el.toggleAttribute("aria-invalid", typeof v === "number" && (!Number.isFinite(v) || v < 0));
  if (v === current(k) || (typeof v === "number" && !Number.isFinite(v))) edits.delete(k);
  else edits.set(k, v);
  $("pr-changed").textContent = edits.size ? `${edits.size} change${edits.size === 1 ? "" : "s"} to save` : "No changes yet";
  $<HTMLButtonElement>("pr-save").disabled = edits.size === 0;
}

function renderAll(): void {
  edits.clear();
  renderGeneral(); renderAgents(); renderItems(); renderHistory();
  $("pr-changed").textContent = "No changes yet";
  $<HTMLButtonElement>("pr-save").disabled = true;
}

const form = $<HTMLFormElement>("pr-form");
form.addEventListener("input", (e) => { const el = e.target as HTMLInputElement; if (el.dataset.k) track(el); });
form.addEventListener("change", (e) => { const el = e.target as HTMLInputElement; if (el.dataset.k) track(el); });
$("pr-when").addEventListener("change", () => { $("pr-date-f").hidden = $<HTMLSelectElement>("pr-when").value !== "date"; });
$("pr-kind").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!b) return;
  kind = b.dataset.kind as typeof kind;
  renderItems();
  $("pr-kind").querySelector<HTMLElement>(`[data-kind="${kind}"]`)?.focus();
});
$("pr-history").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cancel]");
  if (!b) return;
  const r = await api<Book & { error?: string }>(`/owner/prices/changes/${encodeURIComponent(b.dataset.cancel!)}`, { method: "DELETE" });
  if (!r.ok || !r.data) { toast(r.data?.error ?? "Could not call it off. Try again."); return; }
  book = r.data; renderAll(); toast("Called off. Nothing changes on that date.");
});
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!edits.size) return;
  const dated = $<HTMLSelectElement>("pr-when").value === "date";
  const date = $<HTMLInputElement>("pr-date").value;
  if (dated && !date) { toast("Pick the start date"); $("pr-date").focus(); return; }
  const body = { ...changeSet(), ...(dated ? { effectiveFrom: `${date}T00:00:00Z` } : {}), note: $<HTMLInputElement>("pr-note").value.trim() };
  if (!live) { toast("Example data: connect the API to save prices."); return; }
  $<HTMLButtonElement>("pr-save").disabled = true;
  const r = await api<Book & { error?: string }>("/owner/prices/changes", { body });
  if (!r.ok || !r.data) { $<HTMLButtonElement>("pr-save").disabled = false; toast(r.data?.error ? `${r.data.error[0]!.toUpperCase()}${r.data.error.slice(1)}` : "Could not save. Try again."); return; }
  book = r.data; $<HTMLInputElement>("pr-note").value = "";
  renderAll();
  toast(dated ? `Saved. The change starts on ${date}.` : "Saved. New quotes and trials use these prices now.");
});

void (async () => {
  const r = await ownerLoad<Book>("/owner/prices");
  if (!r) return;
  if (r === "demo") { book = demo(); markDemo(); } else { book = r; live = true; }
  renderAll();
})();
