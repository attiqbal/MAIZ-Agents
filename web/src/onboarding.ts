// Signup: three tapped answers (kind of business, what you want help with, apps you use),
// then the plan built from them, then the email that saves it. The plan comes from the same
// pure rules the server uses, so what is shown here is what gets set up.
import "./styles.css";
import { drawPseudoQr } from "./common";
import { api, getToken, setToken } from "./api";
import { MAX_NEEDS, planSignup, resolveSector, type SignupPlan, type SignupSize } from "../../src/modules/onboarding/recommend";
import { APPS, COUNTRIES, NEEDS, OTHER_SECTOR, SECTORS, countryFacts, getSector, type AppHow } from "../../src/modules/onboarding/sectors";

const TOTAL = 6;
const PLAN_STEP = 4;
const KEY = "vn.profile";
interface Profile {
  email?: string; biz?: string; sector?: string; sells?: string; country?: string; needs?: string[]; size?: string;
  apps?: string[]; site?: string; addOns?: string[]; slack?: boolean; contact?: "dashboard" | "slack";
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-step]"));
let current = 1;
let profile: Profile = {};
try { profile = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { /* storage unavailable */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* ignore */ } };

const SIZES: Record<string, SignupSize> = { "Just me": "solo", "2–10": "2-10", "11–50": "11-50", "50+": "51+" };
const AVATAR: Record<string, [string, string]> = {
  "admin-manager": ["AM", "av-tl"], "finance-manager": ["FM", "av-fm"], "marketing-manager": ["MM", "av-mm"], "business-consultant": ["BC", "av-bc"],
  "hr-manager": ["HR", "av-hr"], "compliance-manager": ["CM", "av-cm"], "supply-chain-manager": ["SC", "av-sc"],
};
const HOW: Record<AppHow, string> = { direct: "Connects directly", file: "Upload an export", bridge: "Through Zapier or Make", chat: "One scan" };

function show(n: number, moveFocus = true): void {
  current = Math.min(Math.max(n, 1), TOTAL);
  steps.forEach((s) => s.toggleAttribute("hidden", Number(s.dataset.step) !== current));
  document.querySelectorAll("#progress i").forEach((el, i) => el.classList.toggle("on", i < current));
  $("step-label").textContent = `Step ${current} of ${TOTAL}`;
  window.scrollTo({ top: 0 });
  if (current === 2) renderNeeds();
  if (current === 3) renderApps();
  if (current === PLAN_STEP) renderPlan();
  if (current === 5) { drawPseudoQr($("qr") as HTMLCanvasElement, 7); $("qr-biz").textContent = profile.biz ?? "your"; }
  if (current === 6) provision();
  if (moveFocus) {
    const h = steps[current - 1]?.querySelector<HTMLElement>("h1");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
}

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-next],[data-back]");
  if (!t) return;
  if (t.hasAttribute("data-back")) show(current - 1); else show(current + 1);
});

/** One-of-many chips: pressing one releases the others. */
function single(group: HTMLElement, onPick: (b: HTMLButtonElement) => void): void {
  group.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    group.querySelectorAll("button").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    onPick(b);
  });
}
const pressed = (group: HTMLElement): string[] => Array.from(group.querySelectorAll<HTMLElement>("button[aria-pressed='true']")).map((b) => b.dataset.v ?? "");

// ---- Step 1: kind of business, name, country ----
function guessCountry(): string {
  let region = "";
  try { region = new Intl.Locale(navigator.language).region ?? ""; } catch { /* old browser */ }
  return countryFacts(region)?.code ?? "";
}
$("sectors").innerHTML = SECTORS.map((s) => `<button type="button" class="sector" data-v="${s.key}" aria-pressed="${s.key === profile.sector}"><b>${esc(s.label)}</b><span>${esc(s.examples)}</span></button>`).join("");
single($("sectors"), (b) => {
  $("sells-f").toggleAttribute("hidden", b.dataset.v !== OTHER_SECTOR);
  if (b.dataset.v !== profile.sector) { profile.needs = undefined; profile.apps = undefined; }
  profile.sector = b.dataset.v;
  save();
});
$("sells-f").toggleAttribute("hidden", profile.sector !== OTHER_SECTOR);
const preferred = profile.country ?? guessCountry();
$("country").innerHTML = `${COUNTRIES.map((c) => `<option value="${c.code}"${c.code === preferred ? " selected" : ""}>${esc(c.name)}</option>`).join("")}<option value=""${preferred ? "" : " selected"}>Somewhere else</option>`;
$("biz-go").addEventListener("click", () => {
  const biz = $<HTMLInputElement>("biz").value.trim();
  const ok = !!biz && !!profile.sector;
  $("biz-err").toggleAttribute("hidden", ok);
  $("biz").setAttribute("aria-invalid", String(!biz));
  if (!ok) { if (!biz) $("biz").focus(); return; }
  profile.biz = biz;
  profile.sells = $<HTMLInputElement>("sells").value.trim() || undefined;
  profile.country = $<HTMLSelectElement>("country").value || undefined;
  save(); show(2);
});

// ---- Step 2: needs (ticked for the sector) and team size ----
/** The tapped sector, or the one guessed from the few words typed under "Something else". */
const sectorNow = () => getSector(resolveSector(profile.sector, profile.sells));

function renderNeeds(): void {
  const sector = sectorNow();
  const usual = new Set<string>(sector.needs);
  const on = new Set<string>(profile.needs ?? sector.needs);
  // The sector's usual needs come first, so the owner's eye lands on what is already ticked.
  const ordered = [...NEEDS].sort((a, b) => Number(usual.has(b.key)) - Number(usual.has(a.key)));
  $("needs").innerHTML = ordered.map((n) => `<button type="button" class="chip${usual.has(n.key) && !profile.needs ? " guess" : ""}" data-v="${n.key}" aria-pressed="${on.has(n.key)}">${esc(n.label)}</button>`).join("");
}
$("needs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!b) return;
  const turnOn = b.getAttribute("aria-pressed") !== "true";
  if (turnOn && pressed($("needs")).length >= MAX_NEEDS) { $("needs-err").removeAttribute("hidden"); return; }
  b.setAttribute("aria-pressed", String(turnOn));
  $("needs").querySelectorAll(".chip").forEach((c) => c.classList.remove("guess"));
  $("needs-err").setAttribute("hidden", "");
  profile.needs = pressed($("needs")); save();
});
single($("size"), (b) => { profile.size = b.textContent ?? ""; save(); });
$("needs-go").addEventListener("click", () => {
  const picked = pressed($("needs"));
  $("needs-err").toggleAttribute("hidden", picked.length > 0);
  if (!picked.length) return;
  profile.needs = picked;
  profile.size = $("size").querySelector(".chip[aria-pressed='true']")?.textContent ?? "2–10";
  save(); show(3);
});

// ---- Step 3: apps already in use ----
function renderApps(): void {
  const sector = sectorNow();
  const facts = countryFacts(profile.country);
  const offered = APPS.filter((a) => !a.regions?.length || !facts || a.regions.includes(facts.code));
  const on = new Set(profile.apps ?? []);
  const chip = (key: string) => {
    const a = offered.find((x) => x.key === key);
    return a ? `<button type="button" class="chip" data-v="${a.key}" aria-pressed="${on.has(a.key)}">${esc(a.name)}</button>` : "";
  };
  $("apps").innerHTML = sector.apps.map(chip).join("");
  $("apps-more").innerHTML = offered.filter((a) => !sector.apps.includes(a.key)).map((a) => chip(a.key)).join("");
}
for (const id of ["apps", "apps-more"]) {
  $(id).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
    if (!b) return;
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    profile.apps = [...pressed($("apps")), ...pressed($("apps-more"))]; save();
  });
}
$("apps-go").addEventListener("click", () => {
  profile.apps = [...pressed($("apps")), ...pressed($("apps-more"))];
  profile.site = $<HTMLInputElement>("site").value.trim() || undefined;
  save(); show(PLAN_STEP);
});

// ---- Step 4: the plan, then the email that saves it ----
function currentPlan(): SignupPlan | undefined {
  if (!profile.biz) return undefined;
  return planSignup({
    businessName: profile.biz, sector: profile.sector, needs: profile.needs, apps: profile.apps, size: SIZES[profile.size ?? ""],
    country: profile.country, sells: profile.sells, website: profile.site, addOns: profile.addOns,
  });
}

function renderPlan(): void {
  const plan = currentPlan();
  if (!plan) { show(1); return; }
  $("plan-h").textContent = `${profile.biz}: your team and what happens first`;
  const row = (m: SignupPlan["team"][number]) => {
    const [initials, cls] = AVATAR[m.key] ?? ["AI", "av-tl"];
    return `<div class="team-row"><span class="av ${cls}" aria-hidden="true">${initials}</span><div><b>${esc(m.title)}</b><div class="first">First: ${esc(m.firstJob)}</div><div class="why">${esc(m.why)}</div></div></div>`;
  };
  const focus = plan.team.filter((m) => m.focus);
  const standby = plan.team.filter((m) => !m.focus);
  $("plan-focus").className = "plan-list";
  $("plan-focus").innerHTML = (focus.length ? focus : standby.slice(0, 1)).map(row).join("");
  $("plan-standby").textContent = `Also on your team, ready when you ask: ${standby.slice(focus.length ? 0 : 1).map((m) => m.title).join(", ")}.`;
  $("plan-offers").innerHTML =
    plan.addOns.concat(plan.team.filter((m) => (profile.addOns ?? []).includes(m.key)).map((m) => ({ key: m.key, title: m.title, reason: "Added to your team. Untick to remove." })))
      .map((o) => `<label class="offer"><input type="checkbox" data-addon="${o.key}"${(profile.addOns ?? []).includes(o.key) ? " checked" : ""}><span><b>Add a ${esc(o.title)}</b> (a paid extra after the trial, on the <a href="/pricing.html">Pricing</a> page). ${esc(o.reason)}</span></label>`).join("") +
    plan.later.map((o) => `<p class="later">Later, if you want it: <b>${esc(o.title)}</b>. ${esc(o.reason)}</p>`).join("");
  const apps = plan.apps.length ? plan.apps : plan.suggestedApps;
  $("plan-apps-h").textContent = plan.apps.length ? "Apps to connect" : "Apps worth connecting";
  $("plan-apps").className = "plan-apps";
  $("plan-apps").innerHTML = apps.map((a) => `<div class="plan-app"><span>${esc(a.name)}</span><span class="how">${HOW[a.how]}</span><span class="ds">${esc(a.gives)}</span></div>`).join("") +
    `<p class="hint">You connect these from your control center after setup. Skipping is fine: your team can start from what you tell it.</p>`;
  const facts = countryFacts(plan.country);
  const fact = (label: string, value: string, src: string) => `<div class="prow"><span>${label}<span class="src">${src}</span></span><span class="val">${esc(value)}</span></div>`;
  const rows = [
    facts ? fact("Country and currency", `${facts.name} · ${facts.currency}`, "your device") : "",
    facts ? fact("Financial year starts", facts.yearStart, "our guess") : "",
    plan.prefill.answers.customers ? fact("Customers", String(plan.prefill.answers.customers), "our guess") : "",
    fact("Kind of business", getSector(plan.sector).label, plan.sector === profile.sector ? "you told us" : "our guess"),
  ].filter(Boolean);
  $("plan-facts-h").textContent = `${rows.length} things we filled in for you`;
  $("plan-facts").innerHTML = rows.join("") + `<p class="hint">You can correct any of these on the setup form. Guesses are always labelled.</p>`;
  const signedIn = !!getToken();
  $("email-f").toggleAttribute("hidden", signedIn);
  $("email-go").textContent = signedIn ? "Start my team" : "Start my free week";
}
$("plan-offers").addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.dataset.addon) return;
  const rest = (profile.addOns ?? []).filter((k) => k !== box.dataset.addon);
  profile.addOns = box.checked ? [...rest, box.dataset.addon] : rest;
  save(); renderPlan();
});

// A real sign-in link by email. Without the API (demo) or with dev sign-in on, this step just moves on.
$("email-go").addEventListener("click", async () => {
  if (getToken()) { show(5); return; }
  const v = $<HTMLInputElement>("email").value.trim();
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  $("email-err").toggleAttribute("hidden", ok);
  $("email").setAttribute("aria-invalid", String(!ok));
  if (!ok) { $("email").focus(); return; }
  profile.email = v; save();
  const r = await api<{ dev?: boolean }>("/signin/start", { body: { email: v } });
  if (r.status === 429) { $("email-sent").textContent = "Too many emails for this address. Please try again in an hour."; $("email-sent").removeAttribute("hidden"); return; }
  if (r.ok && !r.data?.dev) {
    $("email-sent").textContent = `We sent a sign-in link to ${v}. Open it on this device and your plan will be waiting. It works once and expires in 15 minutes.`;
    $("email-sent").removeAttribute("hidden");
    return;
  }
  show(5);
});

// ---- Step 5: chat app ----
$("slack-sim").addEventListener("click", async () => {
  // With the API and a Slack app configured this opens Slack's real install page.
  const r = await api<{ url: string }>("/slack/install");
  if (r.ok && r.data?.url) { window.location.href = r.data.url; return; }
  profile.slack = true; save();
  $("slack-ds").textContent = `Connected to ${profile.biz ?? "your"} workspace`;
  $("slack-sim").setAttribute("hidden", "");
  $("connect-go").textContent = "Continue";
});
single($("contact"), (b) => { profile.contact = b.dataset.v === "slack" ? "slack" : "dashboard"; save(); });

// ---- Step 6: create the organisation ----
async function createOrganisation(): Promise<void> {
  // Real set-up when the API is running; otherwise the page stays a demo.
  const r = await api<{ token: string }>("/signup", {
    body: {
      email: profile.email, businessName: profile.biz, sector: profile.sector, sells: profile.sells, needs: profile.needs, apps: profile.apps,
      addOns: profile.addOns, size: profile.size, country: profile.country, website: profile.site, contact: profile.contact,
    },
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
  const plan = currentPlan();
  $("prov-h").textContent = `Setting up ${profile.biz ?? "your company"}`;
  if (plan) {
    $("prov-team").textContent = `Admin manager and ${plan.team.length - 1} employees hired`;
    const first = plan.team.find((m) => m.focus);
    if (first) $("prov-next").textContent = `Your Admin manager will show you the setup form, already filled in from your answers. Check it, press send, and your ${first.title} starts on: ${first.firstJob.charAt(0).toLowerCase()}${first.firstJob.slice(1)}. Each step can be undone.`;
  }
  const items = Array.from(document.querySelectorAll<HTMLElement>("#prov li"));
  items.forEach((li) => li.classList.remove("run", "done"));
  $("open-app").setAttribute("hidden", "");
  items.forEach((li, i) => {
    window.setTimeout(() => { li.classList.add("run"); }, i * 700);
    window.setTimeout(() => { li.classList.remove("run"); li.classList.add("done"); if (i === items.length - 1) $("open-app").removeAttribute("hidden"); }, i * 700 + 650);
  });
}

if (profile.biz) $<HTMLInputElement>("biz").value = profile.biz;
if (profile.sells) $<HTMLInputElement>("sells").value = profile.sells;
if (profile.site) $<HTMLInputElement>("site").value = profile.site;
if (profile.email) $<HTMLInputElement>("email").value = profile.email;
if (profile.size) $("size").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === profile.size)));
// Coming back from the emailed link with a verified session: the plan is waiting, one tap from done.
show(getToken() && profile.biz ? PLAN_STEP : 1, false);
