// A member of staff's own form, opened from the link their employer sent. No account: the link (in the
// URL fragment, so it never reaches server logs) is the key, and it shows only their own answers.
import "./styles.css";
import { api } from "./api";
import { profileFieldsHtml, readProfileFields, wireProfileFields } from "./staff-fields";
import type { SectorQuestion, StaffProfile } from "../../src/modules/people/browser";

interface FormView {
  businessName: string;
  firstName: string;
  jobTitle: string;
  questions: SectorQuestion[];
  phone?: string;
  email?: string;
  profile: StaffProfile;
  pending: { from: string; to: string; days: number }[];
  expiresOn: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

const hash = new URLSearchParams(location.hash.slice(1));
const demo = location.hash === "#demo";
const token = hash.get("t") ?? "";

/** The preview the HR desk's example business links to. */
const DEMO: FormView = {
  businessName: "Kestrel Coffee", firstName: "Tom", jobTitle: "Barista", phone: "07700 900123",
  questions: [
    { key: "allergen_trained", label: "Trained in allergens", kind: "yesno" },
    { key: "can_open_close", label: "Happy to open or close up", kind: "yesno" },
    { key: "languages", label: "Languages spoken", kind: "text" },
  ],
  profile: { availability: [{ day: 0, off: true }, { day: 2, from: "08:00", to: "15:00" }], prefers: ["early"], hoursMin: 16, hoursMax: 24 },
  pending: [], expiresOn: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
};

function fail(message: string): void {
  $("sf-intro").textContent = "";
  $("sf-form").hidden = true;
  const box = $("sf-error");
  box.hidden = false;
  box.innerHTML = `<p><b>${esc(message)}</b></p><p class="small muted">Ask your manager to send you a new link.</p>`;
}

function show(v: FormView): void {
  document.title = `Your details for ${v.businessName} · MAIZ agents`;
  $("sf-h").textContent = `Hi ${v.firstName}, your details for ${v.businessName}`;
  $("sf-intro").textContent = `This helps ${v.businessName} plan shifts around you and reach someone if anything happens at work. It takes about 5 minutes. The link works until ${fmt(v.expiresOn)}, and you can come back to change your answers.`;
  $("sf-biz-2").textContent = v.businessName;
  $("sf-fields").innerHTML = profileFieldsHtml(v.profile, v.questions, { self: true, contact: { ...(v.phone ? { phone: v.phone } : {}), ...(v.email ? { email: v.email } : {}) }, timeOff: true });
  $("sf-form").hidden = false;
}

function done(v: FormView): void {
  const pending = v.pending.length
    ? `<p class="small">Time off waiting for a decision: ${v.pending.map((p) => `${esc(fmt(p.from))} to ${esc(fmt(p.to))} (${p.days} day${p.days === 1 ? "" : "s"})`).join("; ")}.</p>`
    : "";
  const box = $("sf-done");
  box.hidden = false;
  box.innerHTML = `<h2 class="sf-done-h">Thank you, ${esc(v.firstName)}. Your details are saved.</h2>
    <p class="small">${esc(v.businessName)} can see them now, and the rota will follow the hours you gave.</p>${pending}
    <button type="button" class="btn btn-ghost btn-sm" id="sf-again">Change my answers</button>`;
  $("sf-form").hidden = true;
  box.focus();
}

async function load(): Promise<void> {
  if (demo) { $("sf-demo").hidden = false; show(DEMO); return; }
  if (!/^[\w-]{20,64}$/.test(token)) return fail("This link is not complete. Open it again from the message you were sent.");
  const r = await api<FormView & { error?: string }>("/staff-form/open", { body: { token } });
  if (!r.ok || !r.data || r.data.error) return fail(r.status === 0 ? "We could not reach the server. Check your connection and try again." : r.data?.error ?? "This link has expired or been stopped.");
  current = r.data;
  show(r.data);
}

let current: FormView | undefined;
wireProfileFields($("sf-form"));

$("sf-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("sf-err");
  err.hidden = true;
  const v = current ?? DEMO;
  const answers = readProfileFields($<HTMLFormElement>("sf-form"), v.questions);
  if (answers.timeOff && !(answers.timeOff.days > 0)) { err.textContent = "Say how many working days the time off covers."; err.hidden = false; $("sf-off-days").focus(); return; }
  if (demo) { done({ ...DEMO, pending: answers.timeOff ? [answers.timeOff] : [] }); return; }
  const btn = $<HTMLButtonElement>("sf-save");
  btn.disabled = true;
  const r = await api<FormView & { error?: string }>("/staff-form/save", { body: { token, ...answers } });
  btn.disabled = false;
  if (!r.ok || !r.data || r.data.error) {
    err.textContent = r.status === 0 ? "That did not send. Check your connection and try again." : r.data?.error ?? "That did not save. Try again.";
    err.hidden = false;
    return;
  }
  current = r.data;
  done(r.data);
});

document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id !== "sf-again" || !current && !demo) return;
  $("sf-done").hidden = true;
  show(current ?? DEMO);
  $("sf-h").focus();
});

void load();
