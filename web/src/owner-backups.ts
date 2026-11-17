// Backups (owner-backups.html): the platform owner sees in words whether the site's data is safely copied away,
// types in where backups are kept, gets the recovery key (shown once), and can press "Back up now" or
// "Test a restore now". Nothing here needs a server login. See docs/BACKUPS.md.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { isBusy, setBusy } from "./keep-focus";
import type { BackupView, JobKind } from "../../src/modules/backup/types";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type View = BackupView & { nightlyTime: string; manualKeep: number; persistent: boolean };
type Answer = View & { error?: string };
type Tone = "good" | "warn" | "crit" | "idle";

const POLL_MS = 3000;
const DEMO_NOTE = "Example data: connect the API to use this.";

let view: View;
let live = false;
/** The recovery key just made. Held only while it is on screen; the server never sends it again. */
let shownKey: string | null = null;
let replacedKey = false;
/** The job this page started, so it can say how it ended. */
let watching: JobKind | null = null;
let pollTimer: number | undefined;
let shownStatus = "";

const DEMO: View = {
  available: true, configured: true, running: null, fresh: true, timezone: "Europe/London", nightlyTime: "03:10", manualKeep: 5, persistent: true,
  storage: { address: "https://example-account.r2.cloudflarestorage.com", bucket: "maiz-backups", region: "auto", folder: "", keyId: "EXAMPLEKEYID", keep: 30, savedAt: "2026-11-10T10:00:00.000Z" },
  recoveryKey: { id: "ab12cd34", createdAt: "2026-11-10T10:02:00.000Z", saved: true, olderKeys: 0 },
  lastBackup: { at: "2026-11-16T03:10:20.000Z", bytes: 18_400_000, name: "maiz-nightly-20261116T031020Z.backup", kind: "nightly", keyId: "ab12cd34" },
  lastRestoreTest: { at: "2026-11-15T04:10:40.000Z", ok: true, backupName: "maiz-nightly-20261115T031018Z.backup", backupAt: "2026-11-15T03:10:18.000Z", bytes: 18_300_000, clients: 12, records: 4810 },
  nextBackupAt: "2026-11-17T03:10:00.000Z",
};

// ---- words ----
const zoneName = (): string => `${(view.timezone.split("/").pop() ?? view.timezone).replace(/_/g, " ")} time`;
function when(iso: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try { return new Date(iso).toLocaleString("en-GB", { ...opts, timeZone: view.timezone }); } catch { return new Date(iso).toLocaleString("en-GB", opts); }
}
const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  return `${n.toLocaleString("en-GB", { maximumFractionDigits: u === 0 ? 0 : 1 })} ${units[u]}`;
}
const count = (n: number | undefined, one: string, many: string): string => `${(n ?? 0).toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const detail = (text?: string): string => (text ? `<details class="bk-detail"><summary>Technical detail for whoever helps you</summary><code>${esc(text)}</code></details>` : "");

// ---- the status panel ----
interface Summary { tone: Tone; badge: string; h: string; p: string }

function summary(v: View): Summary {
  if (!v.available) return { tone: "idle", badge: "Not available", h: "Backups are not available on this server", p: `${v.unavailable ?? ""} Nothing on this page can switch them on. Whoever looks after the server has to fix this first.` };
  if (!v.configured) {
    const todo = [v.storage ? "" : "say where backups are kept", v.recoveryKey ? "" : "make your recovery key"].filter(Boolean).join(", then ");
    return { tone: "warn", badge: "Not set up", h: "Backups are not set up yet", p: `No backups are being made. To start them, ${todo}. Both are on this page.` };
  }
  if (v.running === "backup") return { tone: "idle", badge: "Working", h: "A backup is being made right now", p: "This can take a few minutes. You can leave this page; it carries on by itself." };
  if (v.running === "restore_test") return { tone: "idle", badge: "Working", h: "A restore test is running right now", p: "This can take a few minutes. Your live data is not touched. You can leave this page." };
  const failed = v.lastFailure?.what === "backup" ? ` The last try did not work: ${v.lastFailure.reason}` : "";
  if (!v.lastBackup) {
    return v.fresh
      ? { tone: failed ? "warn" : "idle", badge: failed ? "Needs attention" : "Ready", h: "Set up, and waiting for the first backup", p: `The first backup is made tonight at ${v.nightlyTime} (${zoneName()}). Press "Back up now" if you would rather not wait.${failed}` }
      : { tone: "crit", badge: "Needs attention", h: "No backup has been made", p: `Backups were set up more than 36 hours ago and none has been made.${failed}` };
  }
  if (!v.fresh) return { tone: "crit", badge: "Needs attention", h: "The newest backup is more than 36 hours old", p: `The last good backup was made on ${when(v.lastBackup.at)}.${failed} Press "Back up now" to try again.` };
  if (failed) return { tone: "warn", badge: "Needs attention", h: "You have a recent backup, but the last try failed", p: `The newest good backup was made on ${when(v.lastBackup.at)}.${failed}` };
  if (v.lastRestoreTest && !v.lastRestoreTest.ok) return { tone: "warn", badge: "Needs attention", h: "Backups are being made, but the last restore test did not pass", p: v.lastRestoreTest.problem ?? "The newest backup could not be loaded in a test." };
  return { tone: "good", badge: "Protected", h: "Your data is backed up", p: `The newest backup was made on ${when(v.lastBackup.at)} and is in your storage.` };
}

function restoreLine(v: View): string {
  const t = v.lastRestoreTest;
  if (!t) return "Not run yet. The site runs the first one by itself after the first nightly backup.";
  if (!t.ok) return `Did not pass on ${esc(when(t.at))}. ${esc(t.problem ?? "")}${detail(t.detail)}`;
  const from = t.backupAt ? ` The backup from ${esc(when(t.backupAt))} opened and loaded.` : "";
  return `Passed on ${esc(when(t.at))}.${from} The copy held ${esc(count(t.clients, "client", "clients"))} and ${esc(count(t.records, "saved record", "saved records"))}.`;
}

function facts(v: View): string {
  const rows: [string, string][] = [];
  const b = v.lastBackup;
  rows.push(["Newest backup", b ? `${esc(when(b.at))} · <span class="bk-num">${esc(size(b.bytes))}</span> · ${b.kind === "nightly" ? "made by the nightly run" : "made with Back up now"}${b.note ? `<span class="bk-warn">${esc(b.note)}</span>` : ""}` : "None yet."]);
  if (v.lastFailure?.what === "backup") rows.push(["Last try", `Did not work on ${esc(when(v.lastFailure.at))}. ${esc(v.lastFailure.reason)}${detail(v.lastFailure.detail)}`]);
  rows.push(["Last restore test", restoreLine(v)]);
  if (v.nextBackupAt) rows.push(["Next nightly backup", `${esc(when(v.nextBackupAt))} (${esc(zoneName())})`]);
  if (v.storage) rows.push(["Kept in", `<span class="mono">${esc(v.storage.bucket)}${v.storage.folder ? `/${esc(v.storage.folder)}` : ""}</span> at ${esc(v.storage.address.replace(/^https:\/\//, ""))}. The last ${esc(String(v.storage.keep))} nightly backups are kept, and the last ${esc(String(v.manualKeep))} made with Back up now.`]);
  return rows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`).join("");
}

const BADGE: Record<Tone, string> = { good: "cx-connected", warn: "cx-not_connected", crit: "cx-error", idle: "bk-idle" };

function renderNow(): void {
  const s = summary(view);
  $("bk-now").dataset.tone = s.tone;
  $("bk-now-h").textContent = s.h;
  $("bk-badge").innerHTML = `<span class="cx-badge ${BADGE[s.tone]}"><span class="dot"></span>${esc(s.badge)}</span>`;
  const showFacts = view.available && (view.configured || !!view.lastBackup);
  // Redrawn only when the words change, so a screen reader is not read the same status every few seconds.
  const html = `<p class="bk-lead">${esc(s.p)}</p>${showFacts ? `<dl class="bk-facts">${facts(view)}</dl>` : ""}`;
  if (html !== shownStatus) { $("bk-now-body").innerHTML = html; shownStatus = html; }
  $("bk-run-box").hidden = !view.available || !view.configured;
  $("bk-setup").hidden = !view.available;
  $("bk-temp").hidden = !view.available || view.persistent;
  for (const id of ["bk-run", "bk-test"]) setBusy($(id), !!view.running);
}

// ---- storage ----
const stepState = (done: boolean): string => `<span class="status ${done ? "good" : "warn"}"><span class="dot"></span>${done ? "Done" : "To do"}</span>`;
const field = (id: string) => $<HTMLInputElement>(id);
const STORE_FIELDS = ["bk-address", "bk-bucket", "bk-keyid", "bk-secret", "bk-region", "bk-folder", "bk-keep"];

function fillStoreForm(): void {
  const s = view.storage;
  field("bk-address").value = s?.address ?? "";
  field("bk-bucket").value = s?.bucket ?? "";
  field("bk-keyid").value = s?.keyId ?? "";
  field("bk-secret").value = "";
  field("bk-region").value = s?.region ?? "";
  field("bk-folder").value = s?.folder ?? "";
  field("bk-keep").value = String(s?.keep ?? 30);
}

function renderStore(): void {
  const s = view.storage;
  $("bk-store-state").innerHTML = stepState(!!s);
  $("bk-secret-saved").hidden = !s;
  field("bk-secret").placeholder = s ? "Leave empty to keep the saved secret" : "";
  $("bk-store-save").textContent = s ? "Check and save changes" : "Check and save";
  $("bk-store-off").hidden = !s;
  if (!s) $("bk-off-sure").hidden = true;
}

/** Which box a server message is about, so focus can go there. */
function fieldFor(message: string): string | undefined {
  const m = message.toLowerCase();
  const hit = ([["address", "bk-address"], ["bucket name", "bk-bucket"], ["key id", "bk-keyid"], ["secret", "bk-secret"], ["region", "bk-region"], ["folder", "bk-folder"], ["how many", "bk-keep"]] as const).find(([word]) => m.includes(word));
  return hit?.[1];
}

async function saveStore(e: Event): Promise<void> {
  e.preventDefault();
  const btn = $("bk-store-save");
  if (isBusy(btn)) return;
  if (!live) { toast(DEMO_NOTE); return; }
  STORE_FIELDS.forEach((id) => field(id).removeAttribute("aria-invalid"));
  const v = (id: string) => field(id).value.trim();
  const body = { address: v("bk-address"), bucket: v("bk-bucket"), keyId: v("bk-keyid"), secret: field("bk-secret").value.trim(), region: v("bk-region"), folder: v("bk-folder"), keep: v("bk-keep") === "" ? "" : Number(v("bk-keep")) };
  setBusy(btn, true);
  $("bk-store-msg").textContent = "Checking your storage. This takes a few seconds.";
  const r = await api<Answer>("/owner/backups/storage", { method: "PUT", body });
  setBusy(btn, false);
  if (!r.ok || !r.data || r.data.error) {
    const message = r.data?.error ?? (r.status === 429 ? "Too many tries. Wait a few minutes, then try again." : "Could not save. Nothing was changed. Try again.");
    $("bk-store-msg").textContent = message;
    const bad = fieldFor(message);
    if (bad) { field(bad).setAttribute("aria-invalid", "true"); field(bad).focus(); }
    return;
  }
  view = r.data;
  fillStoreForm();
  renderAll();
  $("bk-store-msg").textContent = `Saved. Your storage took a test file and gave it back.${view.recoveryKey ? "" : " Now make your recovery key below."}`;
}

async function turnOff(): Promise<void> {
  if (!live) { toast(DEMO_NOTE); return; }
  const r = await api<Answer>("/owner/backups/storage/remove", { body: {} });
  if (!r.ok || !r.data) { $("bk-store-msg").textContent = "Could not turn backups off. Try again."; return; }
  view = r.data;
  $("bk-off-sure").hidden = true;
  fillStoreForm();
  renderAll();
  $("bk-store-msg").textContent = "Backups are turned off. The backups already in your storage were not touched.";
  $("bk-store-h").focus();
}

// ---- the recovery key ----
function keyOnShow(key: string): string {
  return `<div class="bk-keybox">
    <h3 class="bk-h3" id="bk-key-new-h" tabindex="-1">This is your recovery key. It is shown this once.</h3>
    <code class="bk-keytext" id="bk-key-text">${esc(key)}</code>
    <div class="acts bk-acts"><button type="button" class="btn btn-ghost" data-key="copy">Copy the key</button><span class="small bk-msg" id="bk-key-msg" role="status"></span></div>
    <ul class="ow-list">
      <li>Save it in a password manager, or print it and lock it away. Better still, do both.</li>
      <li>Keep it somewhere that is not this server and not only this one computer.</li>
      <li>Anyone who has this key and a backup file can read all of your data. Do not email it or paste it into a chat.</li>
      ${replacedKey ? "<li>Keep your old key as well. The backups already in your storage still need it until they have aged out.</li>" : ""}
    </ul>
    <div class="acts bk-acts"><button type="button" class="btn btn-primary" data-key="saved">I have saved it somewhere safe</button></div>
    <p class="muted small bk-note">After you press this the key is hidden for good.</p>
  </div>`;
}

function keyOnFile(k: NonNullable<View["recoveryKey"]>): string {
  const older = k.olderKeys ? `<p class="muted small bk-note">The server also remembers ${count(k.olderKeys, "older key", "older keys")}, so it can still test backups made with ${k.olderKeys === 1 ? "it" : "them"}.</p>` : "";
  const unsaved = k.saved ? "" : `<div class="cx-result cx-bad"><p><b>You have not said that you saved this key.</b></p><p>It cannot be shown again. If you saved it, say so. If you did not, make a new one now, while nothing depends on it.</p>
    <div class="acts bk-acts"><button type="button" class="btn btn-ghost btn-sm" data-key="saved">I did save it</button></div></div>`;
  const nights = view.storage?.keep ?? 30;
  return `<p class="bk-lead">Made on ${esc(day(k.createdAt))}.${k.saved ? " You said you have saved it." : ""} Its label is <span class="mono">${esc(k.id)}</span>. The label is written on each backup so you can tell which key opens it. The label is not the key.</p>
    ${unsaved}${older}
    <div class="acts bk-acts"><button type="button" class="btn btn-quiet" data-key="ask-new" aria-expanded="false" aria-controls="bk-new-sure">Make a new recovery key</button></div>
    <div class="bk-sure" id="bk-new-sure" hidden>
      <p><b>Make a new recovery key?</b> New backups will be locked with the new key. Backups already in your storage still need the old key, so keep the old one until they have aged out (${esc(String(nights))} nights).</p>
      <div class="acts bk-acts"><button type="button" class="btn btn-primary" data-key="new">Yes, make a new key</button><button type="button" class="btn btn-quiet" data-key="cancel-new">Cancel</button></div>
    </div>`;
}

function renderKey(): void {
  const k = view.recoveryKey;
  $("bk-key-state").innerHTML = stepState(!!k && k.saved && !shownKey);
  if (shownKey) $("bk-key-body").innerHTML = keyOnShow(shownKey);
  else if (k) $("bk-key-body").innerHTML = keyOnFile(k);
  else $("bk-key-body").innerHTML = `<p class="bk-lead">No recovery key yet.</p><div class="acts bk-acts"><button type="button" class="btn btn-primary" data-key="make">Make my recovery key</button><span class="small bk-msg" id="bk-key-msg" role="status"></span></div>`;
}

async function makeKey(replace: boolean): Promise<void> {
  if (!live) { toast(DEMO_NOTE); return; }
  const r = await api<{ recoveryKey?: string; view?: View; error?: string }>("/owner/backups/recovery-key", { body: { replace } });
  if (!r.ok || !r.data?.recoveryKey || !r.data.view) { toast(r.data?.error ?? "Could not make the key. Try again."); return; }
  view = r.data.view;
  shownKey = r.data.recoveryKey;
  replacedKey = replace;
  renderAll();
  $("bk-key-new-h").focus();
}

async function keySaved(): Promise<void> {
  if (!live) { toast(DEMO_NOTE); return; }
  const r = await api<Answer>("/owner/backups/recovery-key/saved", { body: {} });
  if (!r.ok || !r.data) { toast("Could not record that. Try again."); return; }
  view = r.data;
  shownKey = null;
  renderAll();
  $("bk-key-h").focus();
}

async function copyKey(): Promise<void> {
  const note = $("bk-key-msg");
  try {
    await navigator.clipboard.writeText(shownKey ?? "");
    note.textContent = "Copied. Paste it into your password manager now.";
  } catch {
    note.textContent = "Could not copy. Select the key and copy it by hand.";
  }
}

function onKeyClick(e: Event): void {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!b || isBusy(b)) return;
  const act = b.dataset.key;
  if (act === "copy") void copyKey();
  else if (act === "make") void makeKey(false);
  else if (act === "new") void makeKey(true);
  else if (act === "saved") void keySaved();
  else if (act === "ask-new" || act === "cancel-new") {
    const open = act === "ask-new";
    $("bk-new-sure").hidden = !open;
    const ask = $("bk-key-body").querySelector<HTMLElement>('[data-key="ask-new"]')!;
    ask.setAttribute("aria-expanded", String(open));
    (open ? $("bk-key-body").querySelector<HTMLElement>('[data-key="new"]')! : ask).focus();
  }
}

// ---- running a job ----
function outcome(what: JobKind): string {
  if (what === "backup") return view.lastFailure?.what === "backup" ? `The backup did not work. ${view.lastFailure.reason}` : "Backup finished. It is in your storage.";
  const t = view.lastRestoreTest;
  return t?.ok ? "The restore test passed." : `The restore test did not pass. ${t?.problem ?? ""}`;
}

function afterPoll(): void {
  window.clearTimeout(pollTimer);
  if (view.running) { pollTimer = window.setTimeout(() => void poll(), POLL_MS); return; }
  if (watching) { $("bk-msg").textContent = outcome(watching); watching = null; }
}

async function poll(): Promise<void> {
  const r = await api<Answer>("/owner/backups");
  if (r.ok && r.data) { view = r.data; renderNow(); renderStore(); if (!shownKey) $("bk-key-state").innerHTML = stepState(!!view.recoveryKey?.saved); }
  afterPoll();
}

async function start(what: JobKind): Promise<void> {
  if (isBusy($("bk-run")) || isBusy($("bk-test"))) return;
  if (!live) { toast(DEMO_NOTE); return; }
  for (const id of ["bk-run", "bk-test"]) setBusy($(id), true);
  $("bk-msg").textContent = what === "backup" ? "Starting the backup." : "Starting the restore test.";
  const r = await api<Answer>(what === "backup" ? "/owner/backups/run" : "/owner/backups/restore-test", { body: {} });
  if (!r.ok || !r.data || r.data.error) {
    for (const id of ["bk-run", "bk-test"]) setBusy($(id), !!view.running);
    $("bk-msg").textContent = r.data?.error ?? (r.status === 429 ? "Too many tries. Wait a few minutes, then try again." : "Could not start. Try again.");
    return;
  }
  view = r.data;
  watching = what;
  renderNow();
  $("bk-msg").textContent = what === "backup" ? "The backup has started." : "The restore test has started.";
  afterPoll();
}

function renderAll(): void { renderNow(); renderStore(); renderKey(); }

$("bk-run").addEventListener("click", () => void start("backup"));
$("bk-test").addEventListener("click", () => void start("restore_test"));
$("bk-store-form").addEventListener("submit", (e) => void saveStore(e));
$("bk-store-off").addEventListener("click", () => { $("bk-off-sure").hidden = false; $("bk-off-no").focus(); });
$("bk-off-no").addEventListener("click", () => { $("bk-off-sure").hidden = true; $("bk-store-off").focus(); });
$("bk-off-yes").addEventListener("click", () => void turnOff());
$("bk-key-body").addEventListener("click", onKeyClick);
// Leaving while the key is on screen would lose it for good, so the browser asks first.
window.addEventListener("beforeunload", (e) => { if (shownKey) e.preventDefault(); });

void (async () => {
  const r = await ownerLoad<View>("/owner/backups");
  if (!r) return;
  if (r === "demo") { view = DEMO; markDemo(); } else { view = r; live = true; }
  fillStoreForm();
  renderAll();
  afterPoll();
})();
