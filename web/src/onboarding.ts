import "./styles.css";
import { drawPseudoQr, toast } from "./common";
import { api, getToken, setToken } from "./api";

const TOTAL = 6;
const KEY = "vn.profile";
type Profile = { email?: string; biz?: string; site?: string; sells?: string; size?: string; goal?: string; country?: string; type?: string; slack?: boolean; contact?: "dashboard" | "slack" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
let current = 1;
let profile: Profile = {};
try { profile = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { /* storage unavailable */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* ignore */ } };

function show(n: number): void {
  current = Math.min(Math.max(n, 1), TOTAL);
  steps.forEach((s) => s.toggleAttribute("hidden", Number(s.dataset.step) !== current));
  document.querySelectorAll("#progress i").forEach((el, i) => el.classList.toggle("on", i < current));
  $("step-label").textContent = `Step ${current} of ${TOTAL}`;
  window.scrollTo({ top: 0 });
  if (current === 5) { drawPseudoQr($("qr") as HTMLCanvasElement, 7); $("qr-biz").textContent = profile.biz ?? "your"; }
  if (current === 6) provision();
}

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-next],[data-back]");
  if (!t || t.id === "email-go" || t.id === "biz-go") return;
  if (t.hasAttribute("data-back")) show(current - 1); else show(current + 1);
});

// Step 1: a real sign-in link by email. Without the API (demo) or with dev sign-in on, this step just moves on.
$("email-go").addEventListener("click", async () => {
  const v = $<HTMLInputElement>("email").value.trim();
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  $("email-err").toggleAttribute("hidden", ok);
  $("email").setAttribute("aria-invalid", String(!ok));
  if (!ok) { $("email").focus(); return; }
  profile.email = v; save();
  const r = await api<{ dev?: boolean }>("/signin/start", { body: { email: v } });
  if (r.status === 429) { $("email-sent").textContent = "Too many emails for this address. Please try again in an hour."; $("email-sent").removeAttribute("hidden"); return; }
  if (r.ok && !r.data?.dev) {
    $("email-sent").textContent = `We sent a sign-in link to ${v}. Open it on this device to continue. It works once and expires in 15 minutes.`;
    $("email-sent").removeAttribute("hidden");
    return;
  }
  show(2);
});

// Step 2: simulated website read (no network; derives plausible hints from the domain)
let readTimer: number | undefined;
$<HTMLInputElement>("site").addEventListener("input", (e) => {
  const v = (e.target as HTMLInputElement).value.trim();
  window.clearTimeout(readTimer);
  const learn = $("learn");
  if (!/\w\.\w/.test(v)) { learn.setAttribute("hidden", ""); return; }
  learn.removeAttribute("hidden");
  $("learn-text").textContent = "";
  readTimer = window.setTimeout(() => {
    $("learn-text").textContent = "Found your pages. Tone, customers and goals will be suggested on the next screen.";
  }, 700);
});
$("size").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!b) return;
  $("size").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
});
$("biz-go").addEventListener("click", () => {
  const biz = $<HTMLInputElement>("biz").value.trim();
  $("biz-err").toggleAttribute("hidden", !!biz);
  $("biz").setAttribute("aria-invalid", String(!biz));
  if (!biz) { $("biz").focus(); return; }
  profile.biz = biz;
  profile.site = $<HTMLInputElement>("site").value.trim();
  profile.sells = $<HTMLInputElement>("sells").value.trim();
  profile.size = $("size").querySelector(".chip[aria-pressed='true']")?.textContent ?? "2–10";
  $<HTMLInputElement>("c-type").value = profile.sells || "Small business";
  save(); show(3);
});

// Step 3
$("goal").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!b) return;
  $("goal").querySelectorAll(".chip").forEach((c) => { c.setAttribute("aria-pressed", String(c === b)); c.classList.remove("guess"); });
  profile.goal = b.textContent ?? ""; save();
});

// Step 5
$("slack-sim").addEventListener("click", async () => {
  // With the API and a Slack app configured this opens Slack's real install page.
  const r = await api<{ url: string }>("/slack/install");
  if (r.ok && r.data?.url) { window.location.href = r.data.url; return; }
  profile.slack = true; save();
  $("slack-ds").textContent = `Connected to ${profile.biz ?? "your"} workspace`;
  $("slack-sim").setAttribute("hidden", "");
  $("connect-go").textContent = "Continue";
});

$("contact").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!b) return;
  $("contact").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
  profile.contact = b.dataset.v === "slack" ? "slack" : "dashboard"; save();
});

// Step 6
async function createOrganisation(): Promise<void> {
  // Real set-up when the API is running; otherwise the page stays a demo.
  const r = await api<{ token: string }>("/signup", {
    body: { email: profile.email, businessName: profile.biz, website: profile.site, sells: profile.sells, size: profile.size, goal: profile.goal, contact: profile.contact },
  });
  if (r.ok && r.data?.token) setToken(r.data.token);
  else if (r.status === 409) {
    // This email already has a team. Without a login on this device, the owner has to log in to reach it.
    $("prov-h").textContent = getToken() ? "You already have a team. Open your control center." : "You already have a team. Log in to open it.";
    if (!getToken()) { const open = $<HTMLAnchorElement>("open-app"); open.href = "/signin.html"; open.textContent = "Log in"; }
  }
}

function provision(): void {
  void createOrganisation();
  $("prov-h").textContent = `Setting up ${profile.biz ?? "your company"}`;
  const items = Array.from(document.querySelectorAll<HTMLElement>("#prov li"));
  items.forEach((li) => li.classList.remove("run", "done"));
  $("open-app").setAttribute("hidden", "");
  items.forEach((li, i) => {
    window.setTimeout(() => { li.classList.add("run"); }, i * 700);
    window.setTimeout(() => { li.classList.remove("run"); li.classList.add("done"); if (i === items.length - 1) $("open-app").removeAttribute("hidden"); }, i * 700 + 650);
  });
}

if (profile.biz) $<HTMLInputElement>("biz").value = profile.biz;
if (profile.email) $<HTMLInputElement>("email").value = profile.email;
// Coming back from the emailed link with a verified session: skip straight past the email step.
show(getToken() && profile.email ? 2 : 1);
