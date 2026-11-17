// Interest list (owner-interest.html): the people who registered their interest before launch. Without an API the page
// shows two labelled examples.
import "./styles.css";
import { initNav } from "./common";
import { api } from "./api";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Person { id: string; name: string; email: string; business: string; need: string; source: string; createdAt: string }

const DEMO: Person[] = [
  { id: "eg-1", name: "Example Person", email: "example@example.com", business: "Example Bakery", need: "Help with invoices and a weekly sales report", source: "/pricing.html", createdAt: "2026-11-17T09:00:00Z" },
  { id: "eg-2", name: "Another Example", email: "another@example.com", business: "", need: "", source: "/", createdAt: "2026-11-16T15:30:00Z" },
];

/** A spreadsheet program runs text that starts with = + - or @, so those cells are prefixed with a quote. */
const csvCell = (v: string): string => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

function render(people: Person[]): void {
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  $("in-kpis").innerHTML = `<div class="tile-kpi"><span class="l">On the list</span><span class="v">${people.length}</span><span class="dl">${people.length ? `Latest ${esc(day(people[0]!.createdAt))}` : "Nobody yet"}</span></div>`;
  $("in-table").innerHTML = people.length
    ? `<thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Business</th><th scope="col">What they need</th><th scope="col">Joined</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody>${people.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.email)}</td><td>${esc(p.business || "-")}</td><td>${esc(p.need || "-")}</td><td>${esc(day(p.createdAt))}</td><td><button class="btn btn-sm btn-quiet" type="button" data-remove="${esc(p.email)}">Remove</button></td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="muted">Nobody has registered yet.</td></tr></tbody>`;
  const rows = [["Name", "Email", "Business", "What they need", "Joined"], ...people.map((p) => [p.name, p.email, p.business, p.need, p.createdAt])];
  $<HTMLAnchorElement>("in-csv").href = `data:text/csv;charset=utf-8,${encodeURIComponent(rows.map((r) => r.map(csvCell).join(",")).join("\n"))}`;
}

let current: Person[] = [];
$("in-table").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-remove]");
  if (!btn || !confirm(`Remove ${btn.dataset.remove} from the list? Do this when they have asked you to.`)) return;
  const r = await api("/owner/interest/remove", { body: { email: btn.dataset.remove } });
  if (r.ok) { current = current.filter((p) => p.email !== btn.dataset.remove); render(current); }
});

void (async () => {
  const data = await ownerLoad<{ people: Person[] }>("/owner/interest");
  if (!data) return;
  if (data === "demo") { markDemo(); render(DEMO); return; }
  current = data.people;
  render(current);
})();
