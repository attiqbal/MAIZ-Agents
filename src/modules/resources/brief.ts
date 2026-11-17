import { byCost, chooseResource } from "./rule.js";
import type { Resource, ResourceSuggestion } from "./types.js";

/**
 * Turns the registry's answer into words: the "what you can use" part of an employee's instructions, the hints the
 * web app shows next to an answer, and the short list a client sees on the employee's desk. All three come from the
 * same resources, so they cannot disagree.
 *
 * The instructions are paid for on every task, so they are kept short on purpose: one line per cost class, names
 * only, and a hard limit (`MAX_GUIDE_CHARS`) that drops whole items from the end, never half a word.
 */
export const MAX_GUIDE_CHARS = 800;
const MAX_MISSING_IN_GUIDE = 3;
const MAX_APPS_NAMED = 2;
const MAX_SUGGESTIONS = 2;
const MAX_MISSING_IN_SUMMARY = 6;
const MAX_WORDS_PER_GROUP = 3;

const RULE = "Resources, cheapest first. Use what is already here before spending energy. Never invent a figure.";
const CLOSING = "Claim no other tools.";

/** Words in a task that show it is about one kind of data. Deliberately simple and visible, like the batch rules. */
const TASK_WORDS: Record<string, RegExp> = {
  sales: /\b(sales|takings|revenue|turnover|till|sold|best[- ]sell\w*)\b/i,
  books: /\b(profit|loss|p&l|books|accounts|expenses|margin|spend(ing)?|costs?)\b/i,
  payroll: /\b(payroll|wages?|salar\w+)\b/i,
  "website-visits": /\b(website|web ?site|traffic|visitors?|visits|analytics)\b/i,
  search: /\b(seo|search|google|keywords?|ranking)\b/i,
  leads: /\b(leads?|deals?|pipeline|crm)\b/i,
  support: /\b(support|tickets?|complaints?)\b/i,
  bookings: /\b(bookings?|appointments?)\b/i,
  audience: /\b(newsletter|subscribers?|email list|mailing list|open rate)\b/i,
  reviews: /\b(reviews?|ratings?)\b/i,
  "public-opinion": /\b(people (are )?saying|reddit|forums?|competitors?|market research|trends?|sentiment|opinions?)\b/i,
  news: /\b(news|press coverage|headlines)\b/i,
  economy: /\b(inflation|economy|gdp|unemployment)\b/i,
  video: /\b(video|reel|clip)\b/i,
  staff: /\b(staff records?|right to work|holiday|leave|contracts?)\b/i,
  rota: /\b(rota|shifts?|cover)\b/i,
};

/** What a tag is called when talking to a client. */
const TAG_WORDS: Record<string, string> = {
  sales: "sales and takings", books: "your books (income, costs and profit)", payroll: "payroll totals", "website-visits": "website visits", search: "Google search figures",
  leads: "leads and deals", support: "support tickets", inbox: "message counts", bookings: "bookings", audience: "your email list and campaigns", tasks: "tasks and projects",
  reviews: "customer reviews", "public-opinion": "what people are saying", news: "news coverage", economy: "economy figures", "share-price": "share prices",
  "company-records": "company records", video: "video rendering", staff: "staff records", rota: "the rota", "business-profile": "your business profile",
};
const wordsFor = (tag: string): string => TAG_WORDS[tag] ?? tag.replace(/-/g, " ");

const usable = (r: Resource): boolean => r.allowed && r.state === "ready";
const tagsIn = (task: string | undefined): string[] => (task ? Object.keys(TASK_WORDS).filter((t) => TASK_WORDS[t]!.test(task)) : []);

/** One thing that is not there but the client could add: a kind of data, the apps that give it, and where to go. */
export interface MissingGroup { tags: string[]; words: string; names: string[]; fix: { label: string; href: string }; relevant: boolean }

/**
 * What would help but is not connected, grouped by what it gives, so thirty apps become "sales and takings (Square,
 * Stripe)". Only things this employee would be allowed to use and the client can fix; what the task is about comes first.
 */
export function missingFor(resources: readonly Resource[], task?: string): MissingGroup[] {
  const covered = new Set(resources.filter(usable).flatMap((r) => r.gives));
  const wanted = new Set(tagsIn(task));
  const groups = new Map<string, MissingGroup>();
  for (const r of resources) {
    if (!r.allowed || r.state === "ready" || r.fix?.by !== "client") continue;
    const open = r.gives.filter((t) => !covered.has(t));
    if (!open.length) continue;
    if (r.kind !== "app") {
      // One thing with one way to get it (a dataset, staff records): one entry, however many things it gives.
      groups.set(r.key, { tags: open, words: open.slice(0, MAX_WORDS_PER_GROUP).map(wordsFor).join(", "), names: [], fix: { label: r.fix.label, href: r.fix.href }, relevant: open.some((t) => wanted.has(t)) });
      continue;
    }
    for (const tag of open) {
      const g = groups.get(tag);
      if (g) g.names.push(r.name);
      else groups.set(tag, { tags: [tag], words: wordsFor(tag), names: [r.name], fix: { label: "Open Apps and connections", href: r.fix.href }, relevant: wanted.has(tag) });
    }
  }
  // Stable: relevant to the task first, otherwise the order the registries list them in.
  return [...groups.values()].sort((x, y) => Number(y.relevant) - Number(x.relevant));
}

const where = (href: string): string => (href === "#apps" ? "Apps and connections" : href === "#store" ? "the store" : href === "#mining" ? "Market data" : href === "#people" ? "the HR desk" : href === "#settings" ? "Settings" : "the app");
const energyOf = (r: Resource): string => (r.cost.energy !== undefined ? ` (${r.cost.energy})` : "");

/** Joins items into one line, dropping whole items from the end until it fits. */
function line(head: string, items: readonly string[], tail: string, room: number): string | undefined {
  let kept = [...items];
  while (kept.length) {
    const more = items.length - kept.length;
    const text = `${head}${kept.join("; ")}${more ? `; and ${more} more` : ""}${tail}`;
    if (text.length <= room) return text;
    kept = kept.slice(0, -1);
  }
  return undefined;
}

/**
 * The "what you can use" part of an employee's instructions for one task: only what is ready and allowed, by cost
 * class with the figure where it is known, then what is not connected but would help. Never longer than `max`.
 */
export function renderGuide(resources: readonly Resource[], task?: string, max = MAX_GUIDE_CHARS): string {
  const ready = resources.filter(usable).sort(byCost);
  const known = ready.filter((r) => r.cost.class === "known" || r.cost.class === "free").map((r) => `${r.name}${r.freshness && r.kind !== "records" ? ` (${r.freshness})` : ""}`);
  const model = ready.find((r) => r.kind === "model");
  const energy = ready.filter((r) => r.cost.class === "energy" && r.kind === "data-source").map((r) => `${r.name}${energyOf(r)}`);
  const paid = ready.filter((r) => r.cost.class === "double_energy").map((r) => `${r.name}${energyOf(r)}${r.cheaper ? `, but ${r.cheaper} gives the same for less` : ""}`);
  const missing = missingFor(resources, task).filter((g) => g.relevant).slice(0, MAX_MISSING_IN_GUIDE).map((g) => `${g.words} (${g.names.length ? `connect ${g.names.slice(0, MAX_APPS_NAMED).join(" or ")} on ${where(g.fix.href)}` : `${g.fix.label}, in ${where(g.fix.href)}`})`);

  const out = [RULE];
  let room = max - RULE.length - CLOSING.length - 2;
  const add = (text: string | undefined): void => { if (text) { out.push(text); room -= text.length + 1; } };
  add(line("- Already here, no extra cost: ", known.length ? known : ["nothing yet"], ".", room));
  if (model) add(line("- Energy: ", [`your own writing and analysis${model.cost.energy ? ` (about ${model.cost.energy} a task)` : ""}`], ". Keep answers as short as the task allows.", room));
  if (energy.length) add(line("- Energy, the owner confirms the figure first: ", energy, ".", room));
  if (paid.length) add(line("- Double energy, only when the task truly needs it and the owner has seen the cost: ", paid, ".", room));
  if (missing.length) add(line("- Not connected, would help: ", missing, '. Tell the owner "connect X and I can do this" instead of guessing.', room));
  out.push(CLOSING);
  return out.join("\n");
}

/** Keys of what the employee was actually given for a task: the data already here, and the model that did the work. */
export function usedBy(resources: readonly Resource[]): string[] {
  return resources.filter((r) => usable(r) && (r.cost.class === "known" || r.kind === "model")).map((r) => r.key);
}

/**
 * Hints for the client when a task is about something that is not connected: "Your Marketing manager could answer
 * this from your website visits". Worded from templates, so they cost no energy. At most two, only for what the
 * task mentions, and only when nothing usable already gives it (the choice rule decides).
 */
export function suggestionsForTask(resources: readonly Resource[], task: string, employeeName: string): ResourceSuggestion[] {
  const out: ResourceSuggestion[] = [];
  for (const g of missingFor(resources, task)) {
    if (!g.relevant || out.length >= MAX_SUGGESTIONS) break;
    const tag = g.tags.find((t) => TASK_WORDS[t]?.test(task)) ?? g.tags[0]!;
    const choice = chooseResource({ tag }, resources);
    if (choice.use || !choice.missing) continue;
    const names = g.names.slice(0, MAX_APPS_NAMED).join(" or ");
    out.push({
      id: `resource-${tag}`, severity: "low",
      title: `${employeeName} could use ${wordsFor(tag)} for this`,
      detail: names ? `Connect ${names} and this can be answered from your real figures, with nothing guessed.` : `${g.fix.label}, so this is answered from real data, with nothing guessed.`,
      action: { label: names ? "Open Apps and connections" : g.fix.label, href: g.fix.href },
    });
  }
  return out;
}

/** One line of the client's "What this employee can use" list. */
export interface SummaryItem { name: string; detail: string; cost: string; freshness?: string }
export interface SummaryMissing { name: string; detail: string; action: { label: string; href: string } }
export interface ClientSummary { ready: SummaryItem[]; missing: SummaryMissing[]; waiting: string[] }

/** What using something costs, in a client's words. */
export function costWords(r: Resource): string {
  switch (r.cost.class) {
    case "known": return "No extra energy";
    case "free": return "No energy";
    case "energy": return r.kind === "model" ? (r.cost.energy ? `About ${r.cost.energy} energy a task` : "Ordinary energy") : r.cost.energy !== undefined ? `${r.cost.energy} energy, you confirm first` : "Ordinary energy";
    case "double_energy": return r.cost.energy !== undefined ? `Double energy: ${r.cost.energy}, shown before it runs` : "Double energy, shown before it runs";
    case "money": return "A monthly price, shown in the store";
  }
}

/** The client's view of one employee: what it can use now, what is missing with where to add it, and what MAIZ is still switching on. */
export function clientSummary(resources: readonly Resource[]): ClientSummary {
  const ready = resources.filter(usable).sort(byCost).map((r): SummaryItem => ({ name: r.name, detail: r.goodFor, cost: costWords(r), ...(r.freshness ? { freshness: r.freshness } : {}) }));
  const missing = missingFor(resources).slice(0, MAX_MISSING_IN_SUMMARY).map((g): SummaryMissing => ({
    name: g.words.charAt(0).toUpperCase() + g.words.slice(1),
    detail: g.names.length ? `Not connected yet. Works with ${g.names.slice(0, 4).join(", ")}${g.names.length > 4 ? " and more" : ""}.` : "Not set up yet.",
    action: g.fix,
  }));
  const waiting = resources.filter((r) => r.allowed && r.state === "waiting_approval" && r.kind !== "app").map((r) => r.name);
  return { ready, missing, waiting };
}
