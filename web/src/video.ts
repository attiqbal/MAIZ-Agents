// Videos: make a short video from a template and the business's brand. Cost is shown first, the answer is checked by the
// server, and a finished video waits for approval. Nothing is posted anywhere.
import { api, getToken, type Org } from "./api";
import { toast } from "./common";

interface Quote { energy: number; baseEnergy: number; multiplier: number; simulated: boolean; charge: number }
interface Service { key: string; name: string; summary: string; note?: string; connected: boolean; quote?: Quote; link?: { href: string; label: string } }
interface Draft { id: string; title: string; service: string; status: "rendering" | "ready" | "failed" | "approved" | "rejected"; url?: string; energy: number; simulated: boolean; createdAt: string; note?: string }
interface Brand { name?: string; colour?: string; logoUrl?: string; tagline?: string }
interface View { brand: Brand; videos: Draft[]; services: Service[]; listed: { key: string; name: string; note?: string }[]; error?: string; quote?: Quote }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const STATUS: Record<Draft["status"], string> = { rendering: "Being made", ready: "Ready to check", failed: "Failed", approved: "Approved", rejected: "Not approved" };
const BRAND_CHOICES: [string, string][] = [["", "Type my own text"], ["name", "My business name"], ["colour", "My brand colour"], ["logo", "My logo"], ["tagline", "My tagline"]];

let view: View | undefined;
/** The video whose "not right" note box is open. */
let rejecting: string | undefined;
/** The figure the person has seen and not yet confirmed. The next press of the button sends it back. */
let shown: { service: string; charge: number } | undefined;

const slotRow = (slot = "", brand = ""): string =>
  `<div class="slot-row"><label class="sr-only">Slot name</label><input class="input" data-slot-name maxlength="64" placeholder="Slot name, for example Title" value="${esc(slot)}"><label class="sr-only">Fill with</label><span><select class="input" data-slot-brand>${BRAND_CHOICES.map(([v, t]) => `<option value="${v}"${v === brand ? " selected" : ""}>${t}</option>`).join("")}</select><input class="input" data-slot-text maxlength="1000" placeholder="Text, or a public https picture address" style="margin-top:6px"></span><button type="button" class="btn btn-sm btn-quiet" data-slot-del>Remove</button></div>`;

function selected(): Service | undefined { return view?.services.find((s) => s.key === $<HTMLSelectElement>("video-service").value); }

function showCost(): void {
  const s = selected();
  const q = s?.quote;
  shown = undefined;
  $("video-go").textContent = "See the cost";
  $("video-cost").textContent = q ? (q.simulated
    ? `${s!.name} is not connected yet, so this makes a practice video: no energy is used and no real video is made. Once it is connected, one video uses ${q.energy} energy (${q.multiplier} times its plain cost of ${q.baseEnergy}), because it is a paid service.`
    : `One video uses ${q.energy} energy from your team's weekly pool (${q.multiplier} times its plain cost of ${q.baseEnergy}), because ${s!.name} is a paid service.`) : "";
}

function cardHtml(d: Draft): string {
  const media = d.simulated ? `<p class="small muted">Practice video: no service ran, so there is nothing to watch.</p>` : d.url ? `<video controls preload="none" src="${esc(d.url)}"></video><p class="small"><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Open the video</a></p>` : `<p class="small muted">Still being made. Check again in a moment.</p>`;
  const acts = d.status === "ready" && rejecting === d.id
    ? `<form class="fb-form" data-v-form="${esc(d.id)}"><label class="small"><span class="muted">What was not right? (optional, it helps your team next time)</span><input class="input" maxlength="200" data-v-note></label><span class="fb-row"><button type="submit" class="btn btn-sm btn-primary">Send</button><button type="button" class="btn btn-sm btn-quiet" data-v-cancel>Cancel</button></span></form>`
    : d.status === "ready"
    ? `<span class="fb-row"><button class="btn btn-sm btn-primary" data-v-approve="${esc(d.id)}">Approve</button><button class="btn btn-sm btn-ghost" data-v-reject="${esc(d.id)}">Not right</button></span>`
    : d.status === "rendering" ? `<span class="fb-row"><button class="btn btn-sm btn-ghost" data-v-refresh="${esc(d.id)}">Check now</button></span>` : "";
  return `<article class="video-card"><b>${esc(d.title)}</b><span class="small muted">${esc(STATUS[d.status])} · ${d.energy ? `${d.energy} energy` : "no energy used"}${d.note ? ` · ${esc(d.note)}` : ""}</span>${media}${acts}<span class="fb-row"><button class="btn btn-sm btn-quiet" data-v-del="${esc(d.id)}">Remove from list</button></span></article>`;
}

function render(v: View): void {
  view = v;
  const f = $<HTMLFormElement>("video-brand");
  for (const k of ["name", "colour", "logoUrl", "tagline"] as const) (f.elements.namedItem(k) as HTMLInputElement).value = v.brand[k] ?? "";
  const svc = $<HTMLSelectElement>("video-service");
  const keep = svc.value;
  svc.innerHTML = v.services.map((s) => `<option value="${esc(s.key)}">${esc(s.name)}${s.connected ? "" : " (practice)"}</option>`).join("");
  if (keep) svc.value = keep;
  $("video-listed").innerHTML = v.listed.length ? `<p>Also listed, not built yet: ${v.listed.map((l) => esc(l.name)).join(", ")}. For these, make the video there and upload the file where you use it.</p>` : "";
  $("video-list").innerHTML = v.videos.length ? v.videos.map(cardHtml).join("") : `<p class="small muted">No videos yet.</p>`;
  if ($("video-slots").children.length === 0) $("video-slots").innerHTML = slotRow("Title", "name") + slotRow("Subtitle", "");
  showCost();
}

async function load(): Promise<void> {
  const [r, o] = await Promise.all([api<View>("/video"), api<Org>("/org")]);
  if (o.data) $("video-emp").innerHTML = o.data.team.map((e) => `<option value="${esc(e.id)}"${e.templateKey === "marketing-manager" ? " selected" : ""}>${esc(e.name)}</option>`).join("");
  if (r.data) render(r.data);
}

export async function showVideo(): Promise<void> {
  const signedIn = !!getToken();
  $("video-body").hidden = !signedIn; $("video-empty").hidden = signedIn;
  if (signedIn) await load();
}

function collect(): { fields: Record<string, string>; brandSlots: Record<string, string> } {
  const fields: Record<string, string> = {}; const brandSlots: Record<string, string> = {};
  document.querySelectorAll<HTMLElement>("#video-slots .slot-row").forEach((row) => {
    const name = row.querySelector<HTMLInputElement>("[data-slot-name]")!.value.trim();
    if (!name) return;
    const b = row.querySelector<HTMLSelectElement>("[data-slot-brand]")!.value;
    const t = row.querySelector<HTMLInputElement>("[data-slot-text]")!.value.trim();
    if (b) brandSlots[name] = b; else if (t) fields[name] = t;
  });
  return { fields, brandSlots };
}

async function act(path: string, method = "POST", body: unknown = {}): Promise<void> {
  const r = await api<View>(path, { method, body: method === "DELETE" ? undefined : body });
  if (!r.ok || !r.data) { toast(r.data?.error ?? "That did not work. Try again."); return; }
  rejecting = undefined;
  render(r.data);
}

export function initVideo(): void {
  $("video-brand").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const v = (k: string) => (f.elements.namedItem(k) as HTMLInputElement).value;
    await act("/video/brand", "POST", { name: v("name"), colour: v("colour"), logoUrl: v("logoUrl"), tagline: v("tagline") });
    toast("Brand saved");
  });
  $("video-service").addEventListener("change", showCost);
  $("video-add-slot").addEventListener("click", () => $("video-slots").insertAdjacentHTML("beforeend", slotRow()));
  $("video-slots").addEventListener("click", (e) => { (e.target as HTMLElement).closest("[data-slot-del]")?.closest(".slot-row")?.remove(); });
  $("video-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = selected();
    if (!s?.quote) return;
    // First press shows the cost; the second sends it back as the confirmed figure.
    if (!shown || shown.service !== s.key) {
      shown = { service: s.key, charge: s.quote.charge };
      $("video-go").textContent = s.quote.simulated ? "Make a practice video (no energy)" : `Confirm and use ${s.quote.charge} energy`;
      $("video-msg").textContent = "Check the cost above, then press again to confirm.";
      return;
    }
    $<HTMLButtonElement>("video-go").disabled = true;
    const { fields, brandSlots } = collect();
    const r = await api<View & { quote?: Quote }>("/video", { body: { employeeId: $<HTMLSelectElement>("video-emp").value, title: $<HTMLInputElement>("video-title").value, service: s.key, templateId: $<HTMLInputElement>("video-template").value, fields, brandSlots, confirmEnergy: shown.charge } });
    $<HTMLButtonElement>("video-go").disabled = false;
    if (!r.ok || !r.data) { $("video-msg").textContent = r.data?.error ?? "That did not work. Try again."; if (r.status === 409) { await load(); } return; }
    $("video-msg").textContent = "Made. Check it below, then approve or say what is not right.";
    render(r.data);
  });
  $("video-list").addEventListener("submit", async (e) => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>("[data-v-form]");
    if (!f) return;
    e.preventDefault();
    const id = f.dataset.vForm!;
    rejecting = undefined;
    await act(`/video/${id}/decide`, "POST", { approve: false, note: f.querySelector<HTMLInputElement>("[data-v-note]")!.value });
  });
  $("video-list").addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const pick = (k: string) => t.closest<HTMLElement>(`[data-${k}]`)?.dataset[k.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())];
    const ok = pick("v-approve"); if (ok) { await act(`/video/${ok}/decide`, "POST", { approve: true }); return; }
    const no = pick("v-reject");
    if (no) { rejecting = no; if (view) render(view); document.querySelector<HTMLElement>("[data-v-note]")?.focus(); return; }
    if (t.closest("[data-v-cancel]")) { rejecting = undefined; if (view) render(view); return; }
    const re = pick("v-refresh"); if (re) { await act(`/video/${re}/refresh`); return; }
    const del = pick("v-del"); if (del) await act(`/video/${del}`, "DELETE");
  });
}
