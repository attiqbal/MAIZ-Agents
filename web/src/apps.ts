// Apps screen: connect a till, payroll or any other app, upload exports, and choose which employees see the data.
import { api } from "./api";
import { toast } from "./common";

interface CatalogueItem {
  key: string; name: string; category: "till" | "payroll" | "accounting" | "payments" | "ecommerce" | "bridge"; summary: string;
  availability: "live" | "file" | "partner" | "planned"; note?: string;
  connect: "oauth" | "api_key" | "webhook" | "file" | "bridge"; howToExport?: string[]; fields?: { key: string; label: string; help?: string }[]; acceptsFiles: boolean; defaultAccess: string[];
}
interface Connection { id: string; connectorKey: string; status: string; lastSyncAt?: string; lastError?: string; access: string[] }
interface Pending { id: string; kind: "sales" | "payroll"; date: string; data: { currency: string; gross: number; net?: number; transactions?: number; headcount?: number } }
interface AppsData { catalogue: CatalogueItem[]; connections: Connection[]; pending: Pending[] }
interface ImportResult { added: number; updated: number; unchanged: number; conflicts: string[]; warnings: string[]; unmapped: string[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number, cur: string) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n / 100); } catch { return `${(n / 100).toFixed(2)} ${cur}`; } };

const EMPLOYEES: [string, string][] = [["finance-manager", "Finance"], ["business-consultant", "Consultant"], ["marketing-manager", "Marketing"], ["hr-manager", "HR"]];
const CATEGORY: Record<CatalogueItem["category"], string> = { till: "Tills", payroll: "Payroll", accounting: "Accounting", payments: "Payments", ecommerce: "Online shop", bridge: "Any other app" };
/** Filter chips: payments and online shops share one. */
const GROUP: Record<CatalogueItem["category"], string> = { till: "till", payroll: "payroll", accounting: "accounting", payments: "payments", ecommerce: "payments", bridge: "bridge" };
const BADGE: Record<CatalogueItem["availability"], [string, string]> = {
  live: ["good", "Connects directly"], file: ["info", "File upload"], planned: ["info", "Direct connection coming"], partner: ["warn", "API is partner-only"],
};

/** Shown when the API is not reachable, so the screen still explains itself. */
const DEMO: AppsData = {
  catalogue: [
    { key: "xero", name: "Xero", category: "accounting", summary: "Your books in Xero: profit and loss month by month, so your team works from real numbers.", availability: "live", connect: "oauth", acceptsFiles: false, defaultAccess: [] },
    { key: "quickbooks", name: "QuickBooks Online", category: "accounting", summary: "Your books in QuickBooks: profit and loss month by month.", availability: "planned", connect: "bridge", acceptsFiles: false, defaultAccess: [] },
    { key: "stripe", name: "Stripe", category: "payments", summary: "Online card payments, refunds and Stripe's fees, read every day.", availability: "live", connect: "api_key", acceptsFiles: false, defaultAccess: [] },
    { key: "square", name: "Square", category: "till", summary: "Card payments and till sales from Square, read every day.", availability: "live", connect: "oauth", acceptsFiles: true, defaultAccess: [] },
    { key: "brightpay", name: "BrightPay", category: "payroll", summary: "Payroll for the UK and Ireland. Upload the payroll summary after each pay run.", availability: "file", connect: "file", acceptsFiles: true, defaultAccess: [], note: "BrightPay has no public API for payroll totals yet." },
    { key: "till-file", name: "Any till (file upload)", category: "till", summary: "Upload your till's sales export (CSV). Works with any till system.", availability: "file", connect: "file", acceptsFiles: true, defaultAccess: [] },
    { key: "webhook", name: "Zapier, Make or any app (webhook)", category: "bridge", summary: "Send data from any app through Zapier, Make or n8n to a private link.", availability: "live", connect: "webhook", acceptsFiles: false, defaultAccess: [] },
  ],
  connections: [], pending: [],
};

let data: AppsData = DEMO;
let live = false;
let filter = "all";
let uploading: CatalogueItem | undefined;
let keying: CatalogueItem | undefined;

export async function loadApps(): Promise<void> {
  const r = await api<AppsData>("/integrations");
  live = r.ok && !!r.data;
  data = live ? r.data! : DEMO;
  render();
}

function render(): void {
  const byKey = new Map(data.catalogue.map((c) => [c.key, c]));
  // Waiting for the books
  $("apps-pending-panel").hidden = data.pending.length === 0;
  $("apps-pending-count").textContent = `${data.pending.length} item${data.pending.length === 1 ? "" : "s"}`;
  $("apps-pending").innerHTML = data.pending.map((p) => {
    const d = p.data;
    const what = p.kind === "sales" ? `Sales · ${d.transactions ?? 0} transactions` : `Payroll · ${d.headcount ?? 0} staff`;
    return `<div class="app-row"><span>${esc(p.date)}</span><span>${esc(what)}</span><span class="mono">${esc(money(d.gross, d.currency))}</span></div>`;
  }).join("");

  // Connected
  $("apps-connected-panel").hidden = data.connections.length === 0;
  $("apps-connected").innerHTML = data.connections.map((c) => {
    const item = byKey.get(c.connectorKey);
    const state = c.status === "error" ? `<span class="status crit"><span class="dot"></span>${esc(c.lastError ?? "Needs attention")}</span>`
      : `<span class="status good"><span class="dot"></span>${c.lastSyncAt ? `Updated ${esc(new Date(c.lastSyncAt).toLocaleString())}` : "Connected"}</span>`;
    const chips = EMPLOYEES.map(([k, label]) => `<button type="button" class="chip" aria-pressed="${c.access.includes(k)}" data-access="${esc(c.id)}" data-emp="${k}">${label}</button>`).join("");
    const actions = [
      item?.connect === "oauth" ? `<button class="btn btn-ghost btn-sm" data-sync="${esc(c.id)}">Update now</button>` : "",
      item?.acceptsFiles ? `<button class="btn btn-ghost btn-sm" data-upload="${esc(c.connectorKey)}">Upload file</button>` : "",
      `<button class="btn btn-quiet btn-sm" data-disconnect="${esc(c.id)}">Disconnect</button>`,
    ].join("");
    return `<div class="app-conn"><div class="app-conn-h"><b>${esc(item?.name ?? c.connectorKey)}</b>${state}</div>
      <div class="field"><span class="label" id="acc-${esc(c.id)}">Who on your team can see it</span><div class="chips" role="group" aria-labelledby="acc-${esc(c.id)}">${chips}</div></div>
      <div class="acts">${actions}</div></div>`;
  }).join("");

  // Store
  document.querySelectorAll<HTMLElement>("#apps-filter [data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
  const shown = data.catalogue.filter((c) => filter === "all" || GROUP[c.category] === filter);
  $("apps-grid").innerHTML = shown.map((c) => {
    // A live connector whose app keys are not set up yet is not "direct" for this owner today.
    const [tone, label] = c.availability === "live" && (c.connect === "bridge" || c.connect === "file") ? BADGE.planned : BADGE[c.availability];
    const cta = c.connect === "oauth" ? `<button class="btn btn-primary btn-sm" data-connect="${esc(c.key)}">Connect</button>`
      : c.connect === "webhook" ? `<button class="btn btn-primary btn-sm" data-connect="${esc(c.key)}">Get a private link</button>`
      : c.connect === "bridge" ? `<button class="btn btn-ghost btn-sm" data-connect="webhook">Connect through Zapier or Make</button>`
      : c.connect === "api_key" ? `<button class="btn btn-primary btn-sm" data-key="${esc(c.key)}">Connect</button>`
      : `<button class="btn btn-primary btn-sm" data-upload="${esc(c.key)}">Upload file</button>`;
    return `<article class="app-card card card-flat"><div class="app-card-h"><b>${esc(c.name)}</b><span class="xs muted">${CATEGORY[c.category]}</span></div>
      <p class="small">${esc(c.summary)}</p><span class="status ${tone}"><span class="dot"></span>${label}</span>
      ${c.note ? `<p class="xs muted">${esc(c.note)}</p>` : ""}<div class="acts">${cta}</div></article>`;
  }).join("");
}

function openUpload(key: string): void {
  const item = data.catalogue.find((c) => c.key === key);
  if (!item) return;
  uploading = item;
  $("apps-dlg-h").textContent = `Upload from ${item.name}`;
  $("apps-dlg-steps").innerHTML = (item.howToExport ?? ["Export the report as CSV from the app.", "Upload it here."]).map((s) => `<li>${esc(s)}</li>`).join("");
  $("apps-dlg-date-wrap").hidden = item.category !== "payroll";
  $("apps-dlg-result").innerHTML = "";
  $<HTMLFormElement>("apps-dlg-form").reset();
  $<HTMLDialogElement>("apps-dialog").showModal();
}

function openKey(key: string): void {
  const item = data.catalogue.find((c) => c.key === key);
  if (!item) return;
  keying = item;
  $("apps-key-h").textContent = `Connect ${item.name}`;
  $("apps-key-fields").innerHTML = (item.fields ?? [{ key: "restrictedKey", label: "Key", help: "" }]).map((f) =>
    `<div class="field"><label for="apps-key-${esc(f.key)}">${esc(f.label)}</label><input class="input mono" id="apps-key-${esc(f.key)}" name="${esc(f.key)}" autocomplete="off" spellcheck="false" required>${f.help ? `<span class="xs muted">${esc(f.help)}</span>` : ""}</div>`).join("");
  $("apps-key-result").textContent = "";
  $<HTMLDialogElement>("apps-key").showModal();
}

function showResult(r: ImportResult): void {
  const parts = [`<p><b>${r.added + r.updated} ready to add to your books</b>${r.unchanged ? `, ${r.unchanged} already here` : ""}.</p>`];
  for (const w of [...r.conflicts, ...r.warnings]) parts.push(`<p class="small status warn">${esc(w)}</p>`);
  if (r.unmapped.length) parts.push(`<p class="xs muted">Columns we did not use: ${esc(r.unmapped.join(", "))}</p>`);
  $("apps-dlg-result").innerHTML = parts.join("");
}

export function initApps(): void {
  document.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const f = t.closest<HTMLElement>("#apps-filter [data-filter]");
    if (f) { filter = f.dataset.filter as typeof filter; render(); return; }
    const kb = t.closest<HTMLElement>("[data-key]");
    if (kb) { if (live) openKey(kb.dataset.key!); else toast("Log in to connect your apps (demo)"); return; }
    const up = t.closest<HTMLElement>("[data-upload]");
    if (up) { openUpload(up.dataset.upload!); return; }
    if (!live && t.closest("[data-connect],[data-sync],[data-disconnect],[data-access],#apps-post")) { toast("Log in to connect your apps (demo)"); return; }

    const con = t.closest<HTMLElement>("[data-connect]");
    if (con) {
      const r = await api<{ url?: string }>(`/integrations/apps/${con.dataset.connect}/connect`, { body: {} });
      if (!r.ok || !r.data?.url) { toast((r.data as { error?: string } | undefined)?.error ?? "Could not start the connection"); return; }
      if (con.dataset.connect === "webhook") {
        $("apps-hook-url").textContent = r.data.url;
        $<HTMLDialogElement>("apps-hook").showModal();
        void loadApps();
      } else location.href = r.data.url;
      return;
    }
    const sync = t.closest<HTMLElement>("[data-sync]");
    if (sync) {
      toast("Updating…");
      const r = await api<ImportResult>(`/integrations/connections/${sync.dataset.sync}/sync`, { body: {} });
      toast(r.ok && r.data ? `${r.data.added + r.data.updated} new item(s)` : (r.data as { error?: string } | undefined)?.error ?? "Update failed");
      void loadApps();
      return;
    }
    const dis = t.closest<HTMLElement>("[data-disconnect]");
    if (dis) {
      await api(`/integrations/connections/${dis.dataset.disconnect}`, { method: "DELETE" });
      toast("Disconnected. Your books keep what was already added.");
      void loadApps();
      return;
    }
    const acc = t.closest<HTMLElement>("[data-access]");
    if (acc) {
      const conn = data.connections.find((c) => c.id === acc.dataset.access);
      if (!conn) return;
      const emp = acc.dataset.emp!;
      const next = conn.access.includes(emp) ? conn.access.filter((k) => k !== emp) : [...conn.access, emp];
      const r = await api(`/integrations/connections/${conn.id}/access`, { body: { employees: next } });
      if (r.ok) { conn.access = next; render(); } else toast("Could not change who can see it");
      return;
    }
    if (t.closest("#apps-post")) {
      const r = await api<{ posted: number; skipped: string[] }>("/integrations/post", { body: {} });
      if (r.ok && r.data) toast(r.data.skipped.length ? `${r.data.posted} added, ${r.data.skipped.length} need a look` : `${r.data.posted} added to your books`);
      void loadApps();
    }
  });

  $<HTMLFormElement>("apps-dlg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $<HTMLInputElement>("apps-dlg-file").files?.[0];
    if (!uploading || !file) { toast("Choose a file first"); return; }
    if (file.size > 900_000) { toast("That file is too big. Export a shorter date range."); return; }
    if (!live) { toast("Log in to upload your files (demo)"); return; }
    const date = $<HTMLInputElement>("apps-dlg-date").value || undefined;
    const r = await api<ImportResult>(`/integrations/apps/${uploading.key}/import`, { body: { csv: await file.text(), date } });
    if (!r.ok || !r.data) { $("apps-dlg-result").innerHTML = `<p class="small status crit">${esc((r.data as { error?: string } | undefined)?.error ?? "Upload failed")}</p>`; return; }
    showResult(r.data);
    void loadApps();
  });
  $<HTMLFormElement>("apps-key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!keying) return;
    const values = Object.fromEntries(new FormData(e.target as HTMLFormElement).entries());
    const r = await api(`/integrations/apps/${keying.key}/connect`, { body: { values } });
    if (!r.ok) { $("apps-key-result").textContent = (r.data as { error?: string } | undefined)?.error ?? "Could not connect"; return; }
    $<HTMLDialogElement>("apps-key").close();
    toast(`${keying.name} connected`);
    void loadApps();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((b) => b.addEventListener("click", () => b.closest("dialog")?.close()));
  $("apps-hook-copy").addEventListener("click", () => { void navigator.clipboard?.writeText($("apps-hook-url").textContent ?? "").then(() => toast("Copied")); });
  if (new URLSearchParams(location.search).get("connect") === "failed") toast("The app did not approve the connection. Try again.");
  void loadApps();
}
