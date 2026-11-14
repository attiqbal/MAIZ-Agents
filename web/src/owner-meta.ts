// Meta approval (owner-meta.html): what Meta has approved and what is pending, per permission; whether the server is
// ready to go live; and the addresses to paste into the Meta dashboard. Statuses are recorded by the owner from Meta's
// emails: MAIZ cannot read App Review's result from Meta, and this page says so rather than guessing.
import "./styles.css";
import { api } from "./api";
import { initNav } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type State = "not_submitted" | "in_review" | "approved" | "rejected";
interface Perm { key: string; plain: string; kinds: string[]; state: State; note?: string; updatedAt: string }
interface Overview {
  mode: "sandbox" | "live"; businesses: number; deletions: number;
  connections: Record<"facebook" | "instagram" | "whatsapp", { connected: number; needsReconnect: number }>;
  posts: { waiting: number; posted: number; failed: number; retrying: number };
  permissions: Perm[]; readiness: { key: string; label: string; ok: boolean; how: string; detail?: string }[]; urls: Record<string, string>;
}
const LABEL: Record<State, [string, string]> = { not_submitted: ["", "Not submitted"], in_review: ["info", "In review at Meta"], approved: ["good", "Approved"], rejected: ["warn", "Rejected"] };
const URL_LABEL: Record<string, string> = {
  privacyPolicy: "Privacy policy URL", termsOfService: "Terms of service URL", dataDeletionInstructions: "Data deletion instructions URL (use this OR the callback)",
  dataDeletionCallback: "Data deletion request callback URL", deauthorizeCallback: "Deauthorize callback URL", oauthRedirect: "Valid OAuth redirect URI", webhook: "Webhooks callback URL (WhatsApp)",
};

const DEMO: Overview = {
  mode: "sandbox", businesses: 3, deletions: 0,
  connections: { facebook: { connected: 3, needsReconnect: 0 }, instagram: { connected: 2, needsReconnect: 0 }, whatsapp: { connected: 1, needsReconnect: 0 } },
  posts: { waiting: 2, posted: 7, failed: 0, retrying: 0 },
  permissions: [{ key: "pages_manage_posts", plain: "Publish posts to your Facebook Page", kinds: ["facebook"], state: "in_review", updatedAt: "" }],
  readiness: [{ key: "live", label: "Live mode is switched on (META_MODE=live)", ok: false, how: "config" }], urls: { privacyPolicy: "https://maizagents.com/privacy.html" },
};

function render(o: Overview): void {
  const k = (l: string, v: string, n: string) => `<div class="tile-kpi"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span><span class="dl">${esc(n)}</span></div>`;
  const approved = o.permissions.filter((p) => p.state === "approved").length;
  $("om-kpis").innerHTML = [
    k("Mode", o.mode === "live" ? "Live" : "Test", o.mode === "live" ? "Talking to Meta" : "Pretend Meta, nothing posted"),
    k("Permissions approved", `${approved} of ${o.permissions.length}`, `${o.permissions.filter((p) => p.state === "in_review").length} in review`),
    k("Businesses connected", String(o.businesses), `${o.connections.facebook.connected} Facebook · ${o.connections.instagram.connected} Instagram · ${o.connections.whatsapp.connected} WhatsApp`),
    k("Posts", `${o.posts.posted} posted`, `${o.posts.waiting} waiting · ${o.posts.retrying} retrying · ${o.posts.failed} failed`),
    k("Deletion requests", String(o.deletions), "Handled automatically"),
  ].join("");
  $("om-perm-count").textContent = `${approved} of ${o.permissions.length} approved`;
  $("om-perms").innerHTML = `<thead><tr><th scope="col">Permission</th><th scope="col">What it is for</th><th scope="col">Status</th><th scope="col">Record Meta's decision</th></tr></thead><tbody>${o.permissions.map((p) => `<tr>
    <td class="ow-title"><b class="mono">${esc(p.key)}</b><span>${esc(p.kinds.join(", "))}</span></td><td>${esc(p.plain)}</td>
    <td><span class="status ${LABEL[p.state][0]}"><span class="dot"></span>${LABEL[p.state][1]}</span>${p.note ? `<span class="xs muted" style="display:block">${esc(p.note)}</span>` : ""}</td>
    <td><div class="acts"><label class="sr-only" for="st-${esc(p.key)}">Status of ${esc(p.key)}</label><select class="input" id="st-${esc(p.key)}" data-key="${esc(p.key)}" style="min-width:150px">${(Object.keys(LABEL) as State[]).map((s) => `<option value="${s}"${s === p.state ? " selected" : ""}>${LABEL[s][1]}</option>`).join("")}</select>
      <label class="sr-only" for="nt-${esc(p.key)}">Note for ${esc(p.key)}</label><input class="input" id="nt-${esc(p.key)}" maxlength="500" placeholder="Note (optional)" value="${esc(p.note ?? "")}" style="min-width:150px"><button type="button" class="btn btn-quiet btn-sm" data-save="${esc(p.key)}">Save</button></div></td></tr>`).join("")}</tbody>`;
  const ok = o.readiness.filter((r) => r.ok).length;
  $("om-ready-count").textContent = `${ok} of ${o.readiness.length} ready`;
  $("om-ready").innerHTML = o.readiness.map((r) => `<li><span class="status ${r.ok ? "good" : "warn"}"><span class="dot"></span>${r.ok ? "Ready" : "Not yet"}</span> ${esc(r.label)}${r.detail ? ` <span class="muted small">(${esc(r.detail)})</span>` : ""} <span class="xs muted">${r.how === "fetched" ? "checked just now" : "from settings"}</span></li>`).join("");
  $("om-urls").innerHTML = `<tbody>${Object.entries(o.urls).map(([k2, v]) => `<tr><th scope="row">${esc(URL_LABEL[k2] ?? k2)}</th><td class="mono">${esc(v)}</td></tr>`).join("")}</tbody>`;
}

$("om-perms").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-save]");
  if (!b) return;
  const key = b.dataset.save!;
  const r = await api("/owner/meta/permissions", { body: { key, state: $<HTMLSelectElement>(`st-${key}`).value, note: $<HTMLInputElement>(`nt-${key}`).value.trim() || undefined } });
  $("om-msg").textContent = r.ok ? `Saved ${key}.` : String((r.data as any)?.error ?? "That did not save.");
  if (r.ok) { const d = await ownerLoad<Overview>("/owner/meta"); if (d && d !== "demo") render(d); }
});

void (async () => {
  const d = await ownerLoad<Overview>("/owner/meta");
  if (!d) return;
  if (d === "demo") { markDemo(); render(DEMO); return; }
  render(d);
})();
