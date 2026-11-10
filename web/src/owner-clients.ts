// Clients (owner-clients.html): every business on MAIZ for the platform owner. Without an API the
// page shows three example clients, labelled as examples.
import "./styles.css";
import { initNav } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Client {
  id: string; name: string; ownerEmail: string | null; createdAt: string | null; trialEndsAt: string | null;
  status: "trial" | "trial_ended" | "active"; setup: string; employees: number;
  energyToday: number; energyMonth: number; aiCostUsdMonth: number; openReviews: number; specialistsToReview: number;
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const DEMO: Client[] = [
  { id: "eg1", name: "Kestrel Coffee", ownerEmail: "ann@kestrel.example", createdAt: day(-2), trialEndsAt: day(5), status: "trial", setup: "ready", employees: 6, energyToday: 412, energyMonth: 5210, aiCostUsdMonth: 5.21, openReviews: 2, specialistsToReview: 1 },
  { id: "eg2", name: "Northside Bikes", ownerEmail: "sam@northside.example", createdAt: day(-6), trialEndsAt: day(1), status: "trial", setup: "needs_attention", employees: 6, energyToday: 96, energyMonth: 2380, aiCostUsdMonth: 2.38, openReviews: 1, specialistsToReview: 0 },
  { id: "eg3", name: "Harbour Dental", ownerEmail: "lee@harbour.example", createdAt: day(-12), trialEndsAt: day(-5), status: "trial_ended", setup: "ready", employees: 7, energyToday: 0, energyMonth: 640, aiCostUsdMonth: 0.64, openReviews: 0, specialistsToReview: 0 },
];

const SETUP: Record<string, [string, string]> = {
  ready: ["good", "Set up"], awaiting_form: ["", "Waiting for setup form"], setting_up: ["info", "Setting up"],
  needs_attention: ["warn", "Needs you: setup stuck"], not_started: ["", "Not started"],
};
const STATUS: Record<Client["status"], [string, string]> = { trial: ["info", "On trial"], trial_ended: ["warn", "Trial ended"], active: ["good", "Paying"] };
const pill = ([tone, text]: [string, string]) => `<span class="status ${tone}"><span class="dot"></span>${esc(text)}</span>`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "–");
const needsYou = (c: Client) => c.setup === "needs_attention" || c.openReviews > 0 || c.specialistsToReview > 0;

type Filter = "all" | "needs" | "trial" | "ended";
const FILTERS: [Filter, string, (c: Client) => boolean][] = [
  ["all", "All", () => true], ["needs", "Needs you", needsYou], ["trial", "On trial", (c) => c.status === "trial"], ["ended", "Trial ended", (c) => c.status === "trial_ended"],
];
let clients: Client[] = [];
let filter: Filter = "all";

function render(): void {
  const sum = (f: (c: Client) => number) => clients.reduce((n, c) => n + f(c), 0);
  const tile = (label: string, value: string, note: string) => `<div class="tile-kpi"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span><span class="dl">${esc(note)}</span></div>`;
  $("cl-kpis").innerHTML = [
    tile("Clients", String(clients.length), `${clients.filter((c) => c.status === "trial").length} on trial`),
    tile("Needs you", String(clients.filter(needsYou).length), `${clients.filter((c) => c.setup === "needs_attention").length} stuck setups`),
    tile("Tasks to review", String(sum((c) => c.openReviews)), "Across all clients"),
    tile("Energy today", sum((c) => c.energyToday).toLocaleString("en-GB"), `${sum((c) => c.energyMonth).toLocaleString("en-GB")} this month`),
    tile("AI cost this month", `$${sum((c) => c.aiCostUsdMonth).toFixed(2)}`, "What you paid model providers"),
  ].join("");
  $("cl-filter").innerHTML = FILTERS.map(([k, label, f]) => `<button type="button" class="chip" aria-pressed="${k === filter}" data-cl="${k}">${label} (${clients.filter(f).length})</button>`).join("");
  const shown = clients.filter(FILTERS.find(([k]) => k === filter)![2]);
  const rows = shown.map((c) => `<tr>
      <td class="ow-title"><b>${esc(c.name)}</b><span>${c.ownerEmail ? `<a class="link" href="mailto:${esc(c.ownerEmail)}">${esc(c.ownerEmail)}</a>` : "No email on file"}</span></td>
      <td>${date(c.createdAt)}</td>
      <td>${pill(STATUS[c.status])}<span class="xs muted" style="display:block">${c.trialEndsAt ? `${c.status === "trial_ended" ? "Ended" : "Ends"} ${date(c.trialEndsAt)}` : ""}</span></td>
      <td>${pill(SETUP[c.setup] ?? ["", c.setup])}</td>
      <td class="num">${c.employees}</td>
      <td class="num">${c.energyToday.toLocaleString("en-GB")}</td>
      <td class="num">${c.energyMonth.toLocaleString("en-GB")}</td>
      <td class="num">$${c.aiCostUsdMonth.toFixed(2)}</td>
      <td>${c.openReviews ? `<a class="link" href="/review.html">${c.openReviews} task${c.openReviews === 1 ? "" : "s"}</a>` : ""}${c.specialistsToReview ? `${c.openReviews ? "<br>" : ""}<a class="link" href="/owner-specialists.html">${c.specialistsToReview} specialist${c.specialistsToReview === 1 ? "" : "s"}</a>` : ""}${!c.openReviews && !c.specialistsToReview ? '<span class="muted">Nothing</span>' : ""}</td>
    </tr>`).join("");
  $("cl-table").innerHTML = `<thead><tr><th scope="col">Client</th><th scope="col">Signed up</th><th scope="col">Trial</th><th scope="col">Setup</th><th scope="col" class="num">Team</th><th scope="col" class="num">Energy today</th><th scope="col" class="num">This month</th><th scope="col" class="num">AI cost</th><th scope="col">Waiting for you</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="9" class="muted">No clients here.</td></tr>`}</tbody>`;
}

$("cl-filter").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cl]");
  if (!b) return;
  filter = b.dataset.cl as Filter;
  render();
  $("cl-filter").querySelector<HTMLElement>(`[data-cl="${filter}"]`)?.focus();
});

void (async () => {
  const r = await ownerLoad<{ clients: Client[] }>("/owner/clients");
  if (!r) return;
  if (r === "demo") { clients = DEMO; markDemo(); } else clients = r.clients;
  render();
})();
