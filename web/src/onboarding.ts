// Signup: three tapped answers (kind of business, what you want help with, apps you use),
// then the plan built from them, then the email that saves it. The plan comes from the same
// pure rules the server uses, so what is shown here is what gets set up.
import "./styles.css";
import { drawPseudoQr, showSocialLogin, wirePasswordToggles } from "./common";
import { api, getToken, setToken } from "./api";
import { MAX_NEEDS, cleanCountryName, planSignup, resolveSector, type SignupPlan, type SignupSize } from "../../src/modules/onboarding/recommend";
import { APPS, COUNTRIES, NEEDS, OTHER_SECTOR, SECTORS, countryFacts, getSector, type AppHow } from "../../src/modules/onboarding/sectors";

wirePasswordToggles();
const TOTAL = 6;
const PLAN_STEP = 4;
const KEY = "maiz.profile";
interface Profile {
  email?: string; biz?: string; sector?: string; sells?: string; country?: string; countryName?: string; needs?: string[]; size?: string;
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

// Where the owner is, so a refresh or the browser's Back button keeps their place.
const STEP_KEY = "maiz.obStep";
const RESUMABLE_MAX = 5; // step 6 creates the team; never re-run it on a refresh

function show(n: number, moveFocus = true, fromHistory = false): void {
  const prev = current;
  current = Math.min(Math.max(n, 1), TOTAL);
  try { sessionStorage.setItem(STEP_KEY, String(Math.min(current, RESUMABLE_MAX))); } catch { /* storage unavailable */ }
  if (!fromHistory && current !== prev) history.pushState({ obStep: current }, "", `#step-${current}`);
  else if (!fromHistory) history.replaceState({ obStep: current }, "", `#step-${current}`);
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

window.addEventListener("popstate", (e) => {
  const step = Number((e.state as { obStep?: number } | null)?.obStep);
  // Never walk back into the set-up step; Back from there returns to the start of the app.
  if (step >= 1 && step < 6) show(step, true, true);
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
const preferred = profile.countryName ? "" : (profile.country ?? guessCountry());
$("country").innerHTML = `${COUNTRIES.map((c) => `<option value="${c.code}"${c.code === preferred ? " selected" : ""}>${esc(c.name)}</option>`).join("")}<option value=""${preferred ? "" : " selected"}>Somewhere else</option>`;
// "Somewhere else" asks for the country's name, so the Admin manager can read up on its rules.
const elsewhere = () => $<HTMLSelectElement>("country").value === "";
const syncCountryName = () => $("country-name-f").toggleAttribute("hidden", !elsewhere());
$("country").addEventListener("change", syncCountryName);
if (profile.countryName) $<HTMLInputElement>("country-name").value = profile.countryName;
syncCountryName();
$("biz-go").addEventListener("click", () => {
  const biz = $<HTMLInputElement>("biz").value.trim();
  const countryName = elsewhere() ? cleanCountryName($<HTMLInputElement>("country-name").value) : undefined;
  const countryOk = !elsewhere() || !!countryName;
  const ok = !!biz && !!profile.sector;
  $("biz-err").toggleAttribute("hidden", ok);
  $("biz").setAttribute("aria-invalid", String(!biz));
  $("country-name-err").toggleAttribute("hidden", countryOk);
  $("country-name").setAttribute("aria-invalid", String(!countryOk));
  if (!ok || !countryOk) { if (!biz) $("biz").focus(); else if (!countryOk) $("country-name").focus(); return; }
  profile.biz = biz;
  profile.sells = $<HTMLInputElement>("sells").value.trim() || undefined;
  profile.country = $<HTMLSelectElement>("country").value || undefined;
  profile.countryName = countryName;
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
  const site = $<HTMLInputElement>("site");
  const raw = site.value.trim();
  // Optional, but if given it should look like a web address: a dot, no spaces (https:// is added later if missing).
  const looksLikeUrl = !raw || /^(https?:\/\/)?[^\s/]+\.[^\s/]{2,}(\/\S*)?$/i.test(raw);
  if (looksLikeUrl) site.removeAttribute("aria-invalid"); else site.setAttribute("aria-invalid", "true");
  $("site-err").toggleAttribute("hidden", looksLikeUrl);
  if (!looksLikeUrl) { site.focus(); return; }
  profile.site = raw || undefined;
  save(); show(PLAN_STEP);
});

// ---- Step 4: the plan, then the email that saves it ----
function currentPlan(): SignupPlan | undefined {
  if (!profile.biz) return undefined;
  return planSignup({
    businessName: profile.biz, sector: profile.sector, needs: profile.needs, apps: profile.apps, size: SIZES[profile.size ?? ""],
    country: profile.country, countryName: profile.countryName, sells: profile.sells, website: profile.site, addOns: profile.addOns,
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
    `<p class="hint">You connect these from your control centre after setup. Skipping is fine: your team can start from what you tell it.</p>`;
  const facts = countryFacts(plan.country);
  const fact = (label: string, value: string, src: string) => `<div class="prow"><span>${label}<span class="src">${src}</span></span><span class="val">${esc(value)}</span></div>`;
  const rows = [
    facts ? fact("Country and currency", `${facts.name} · ${facts.currency}`, "your device") : "",
    plan.countryName ? fact("Country", plan.countryName, "you told us") : "",
    plan.countryName ? fact("First job for your Admin manager", `Read up on the business rules in ${plan.countryName} and recommend the best way forward`, "automatic") : "",
    facts ? fact("Financial year starts", facts.yearStart, "our guess") : "",
    plan.prefill.answers.customers ? fact("Customers", String(plan.prefill.answers.customers), "our guess") : "",
    fact("Kind of business", getSector(plan.sector).label, plan.sector === profile.sector ? "you told us" : "our guess"),
  ].filter(Boolean);
  $("plan-facts-h").textContent = `${rows.length} things we filled in for you`;
  $("plan-facts").innerHTML = rows.join("") + `<p class="hint">You can correct any of these on the setup form. Guesses are always labelled.</p>`;
  const signedIn = !!getToken();
  $("email-f").toggleAttribute("hidden", signedIn);
  $("has-account").toggleAttribute("hidden", signedIn);
  $("agree").toggleAttribute("hidden", signedIn);
  if (signedIn) $("social").setAttribute("hidden", ""); else void showSocialLogin($("social"), $("social-btns"));
  $("email-go").textContent = signedIn ? "Start my team" : "Start my free week";
}
$("plan-offers").addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.dataset.addon) return;
  const rest = (profile.addOns ?? []).filter((k) => k !== box.dataset.addon);
  profile.addOns = box.checked ? [...rest, box.dataset.addon] : rest;
  save(); renderPlan();
});

// Create the account with an email and password. The address is confirmed by an emailed link before the password counts.
// Without the API (demo) or with dev sign-in on, this step just moves on.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function emailProblem(message: string, field: "email" | "pw" = "email"): void {
  $("email-err").textContent = message;
  $("email-err").toggleAttribute("hidden", !message);
  $("email").setAttribute("aria-invalid", String(!!message && field === "email"));
  $("pw").setAttribute("aria-invalid", String(!!message && field === "pw"));
  if (message) $(field).focus();
}
$("email-f").addEventListener("submit", (e) => { e.preventDefault(); $("email-go").click(); });
$("email-go").addEventListener("click", async () => {
  if (getToken()) { show(5); return; }
  const v = $<HTMLInputElement>("email").value.trim();
  const pw = $<HTMLInputElement>("pw").value;
  emailProblem("");
  if (!EMAIL.test(v)) { emailProblem("Enter a valid email address."); return; }
  if (pw.length < 8) { emailProblem("Use at least 8 characters for your password.", "pw"); return; }
  profile.email = v; save();
  $("email-go").setAttribute("disabled", "");
  const r = await api<{ dev?: boolean; bind?: string; devLink?: string; error?: string; field?: "email" | "pw" | "password" }>("/auth/register", { body: { email: v, password: pw } });
  $("email-go").removeAttribute("disabled");
  if (r.status === 429) { emailProblem(r.data?.error ?? "Too many tries. Please wait a few minutes and try again."); return; }
  if (r.status === 400 || r.status === 403) { emailProblem(r.data?.error ?? "Check your email and password.", r.data?.field === "password" ? "pw" : "email"); return; }
  // The link only works in this browser: it proves the person who signed up is the person who opens the email.
  try { if (r.data?.bind) localStorage.setItem("maiz.bind", r.data.bind); } catch { /* storage unavailable */ }
  if (r.data?.devLink) {
    const c = await api<{ token: string }>("/auth/confirm", { body: { token: r.data.devLink, bind: r.data.bind } });
    if (c.ok && c.data?.token) { setToken(c.data.token); show(5); return; }
  }
  if (r.ok && !r.data?.dev) {
    $("email-sent").textContent = `We sent a confirmation link to ${v}. Open it on this device and your plan will be waiting. It works once and expires in 1 hour.`;
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
  // No live Slack install yet (not signed in, or Slack not set up on the server): say so, never fake a connection.
  $("slack-ds").textContent = "You can connect Slack from Apps once your team is set up";
  $("slack-sim").setAttribute("hidden", "");
});
single($("contact"), (b) => { profile.contact = b.dataset.v === "slack" ? "slack" : "dashboard"; save(); });

// ---- Step 6: create the organisation ----
async function createOrganisation(): Promise<boolean> {
  // Real set-up when the API is running; otherwise the page stays a demo.
  const r = await api<{ token: string }>("/signup", {
    body: {
      email: profile.email, businessName: profile.biz, sector: profile.sector, sells: profile.sells, needs: profile.needs, apps: profile.apps,
      addOns: profile.addOns, size: profile.size, country: profile.country, countryName: profile.countryName, website: profile.site, contact: profile.contact,
    },
  });
  if (r.ok && r.data?.token) { setToken(r.data.token); return true; }
  if (r.status === 409) {
    // This email already has a team. Without a login on this device, the owner has to log in to reach it.
    $("prov-h").textContent = getToken() ? "You already have a team. Open your control centre." : "You already have a team. Log in to open it.";
    if (!getToken()) { const open = $<HTMLAnchorElement>("open-app"); open.href = "/signin.html"; open.textContent = "Log in"; }
    return true;
  }
  if (r.status === 0 || r.status === 404) return true; // no API running: the page is a demo
  $("prov-h").textContent = r.status === 429 ? "Too many sign-ups from this connection. Wait 10 minutes and try again." : "We couldn't finish setting up your team. Nothing was created and nothing is charged.";
  return false;
}

function provision(): void {
  const created = createOrganisation();
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
  $("prov-retry").setAttribute("hidden", "");
  items.forEach((li, i) => {
    window.setTimeout(() => { li.classList.add("run"); }, i * 700);
    window.setTimeout(() => { li.classList.remove("run"); li.classList.add("done"); if (i === items.length - 1) void created.then((ok) => { $(ok ? "open-app" : "prov-retry").removeAttribute("hidden"); }); }, i * 700 + 650);
  });
}

$("prov-retry").addEventListener("click", () => provision());
if (profile.biz) $<HTMLInputElement>("biz").value = profile.biz;
if (profile.sells) $<HTMLInputElement>("sells").value = profile.sells;
if (profile.site) $<HTMLInputElement>("site").value = profile.site;
if (profile.email) $<HTMLInputElement>("email").value = profile.email;
if (profile.size) $("size").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === profile.size)));
// Coming back from the emailed link with a verified session: the plan is waiting, one tap from done.
// Someone who already has a team goes straight to it. Otherwise resume where they were in this tab,
// or at the plan when they come back from the emailed link.
async function start(): Promise<void> {
  if (getToken()) {
    const r = await api<{ id: string }>("/org");
    if (r.ok && r.data?.id) { location.replace("/app.html"); return; }
  }
  let resume = 1;
  try { resume = Number(sessionStorage.getItem(STEP_KEY)) || 1; } catch { /* storage unavailable */ }
  if (resume > 1 && !profile.sector) resume = 1; // answers were cleared: start again
  if (getToken() && profile.biz) resume = Math.max(resume, PLAN_STEP);
  current = 0;
  history.replaceState({ obStep: resume }, "", `#step-${resume}`);
  show(resume, false, true);
}
void start();
