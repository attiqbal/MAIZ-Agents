import "./styles.css";
import { toast } from "./common";
import { initSetup } from "./setup";
import { initApps } from "./apps";
import { initDash } from "./dash";
import { initRoleDesigner } from "./role-designer";
import { initPeople, setPeopleBusiness } from "./people";
import { initDesk, showDesk } from "./desk";
import { api, getToken, clearSession, type Org } from "./api";
import { JOB_DESCRIPTIONS, getJobDescription, jdHtml } from "./jd";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");

// Profile from onboarding (falls back to the example business).
let profile: { biz?: string; email?: string; slack?: boolean; contact?: string } = {};
try { profile = JSON.parse(localStorage.getItem("maiz.profile") ?? "{}"); } catch { /* ignore */ }
const biz = profile.biz || "Kestrel Coffee";
let orgName = biz;
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "MA";
$("org-name").textContent = biz;
$("org-av").textContent = initials(biz);
const owner = profile.email ? profile.email.split("@")[0]! : "You";
$("owner-name").textContent = owner;
$("me-av").textContent = $("owner-av").textContent = initials(owner);
const h = new Date().getHours();
$("greet").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${biz}`;
if (profile.slack) $("slack-state").textContent = "Slack on";


// Routing
const screens = Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"));
function route(): void {
  // "#desk/finance-manager" opens one employee's dashboard; every other hash is a screen.
  const [key = "home", sub = ""] = (location.hash.slice(1) || "home").split("/");
  const valid = screens.some((s) => s.dataset.screen === key) ? key : "home";
  if (valid === "desk") showDesk(sub);
  screens.forEach((s) => s.toggleAttribute("hidden", s.dataset.screen !== valid));
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => {
    if (a.dataset.nav === (valid === "desk" ? "team" : valid)) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  app.classList.remove("menu-open"); $("menu-btn").setAttribute("aria-expanded", "false");
  const title = screens.find((x) => x.dataset.screen === valid)?.querySelector("h1")?.textContent ?? "Control centre";
  document.title = `${valid === "home" ? "Overview" : title} · ${orgName} · MAIZ Agents`;
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);
// The store opens inside the control centre, so hiring never leaves the app. Loaded on first visit.
let storeReady = false;
function openStoreIfShown(): void {
  if (storeReady || location.hash !== "#store") return;
  storeReady = true;
  void import("./store").then((m) => m.initStore({ onPaid: () => { void loadOrg(); } }));
}
window.addEventListener("hashchange", openStoreIfShown);
openStoreIfShown();
// The skip link must not change the hash: the hash picks the screen.
$("skip-main").addEventListener("click", (e) => { e.preventDefault(); $("main").focus(); });

// Mobile menu: say whether it is open, move focus in on open, Escape closes and returns focus.
const menuBtn = $("menu-btn");
menuBtn.setAttribute("aria-controls", "rail");
menuBtn.setAttribute("aria-expanded", "false");
const setMenu = (open: boolean): void => {
  app.classList.toggle("menu-open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector<HTMLElement>("#rail a.ni")?.focus();
};
menuBtn.addEventListener("click", () => setMenu(!app.classList.contains("menu-open")));
$("scrim").addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && app.classList.contains("menu-open")) { setMenu(false); menuBtn.focus(); } });

// Toasts
document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-toast]");
  if (t) toast(t.dataset.toast ?? "");
});

// A signed-in client should not glimpse the example count while their own data loads.
if (getToken()) $("need-count").textContent = "Checking…";
// Needs-you + approvals share one list of pending items.
const pending = new Set(["posts", "vat", "pack"]);
const details: Record<string, { title: string; cost: string; leaves: string; prev: string; why: string; ok: string }> = {
  posts: { title: "Schedule 3 Instagram posts", cost: "Cost so far: 9 energy", leaves: "<b>What will leave the company:</b> 3 posts with images, Thu 18:00, Fri 12:00, Sat 10:00.", prev: "<b>Post 1 of 3</b>Our autumn blend is here: toffee, baked apple and a little spice. Subscribers get it first on Thursday.", why: "Why these days: past posts get the most saves on Thursday evenings and Saturday mornings.", ok: "Approve and schedule" },
  vat: { title: "Are you VAT registered?", cost: "No energy", leaves: "<b>Nothing leaves the company.</b> Your answer is stored in your profile.", prev: "<b>Why we ask</b>October's profit and loss depends on whether VAT applies to your sales.", why: "You can change this later in Settings.", ok: "Yes, registered" },
  pack: { title: "Request quotes from 2 suppliers", cost: "Cost so far: 30 energy", leaves: "<b>What will leave the company:</b> 2 emails asking for quotes on your current packaging spec.", prev: "<b>Email 1 of 2</b>Hello, we are a small coffee roaster looking for a quote on 5,000 mailer boxes per quarter…", why: "Estimated saving: about £140 a month.", ok: "Send requests" },
};
let selected = "posts";

function refresh(): void {
  document.querySelectorAll<HTMLElement>("[data-need]").forEach((el) => el.toggleAttribute("hidden", !pending.has(el.dataset.need!)));
  document.querySelectorAll<HTMLElement>("#alist [data-a]").forEach((el) => el.toggleAttribute("hidden", !pending.has(el.dataset.a!)));
  const n = pending.size;
  $("appr-count").textContent = String(n);
  $("appr-count").toggleAttribute("hidden", n === 0);
  $("need-count").textContent = n === 0 ? "All clear" : `${n} need${n === 1 ? "s" : ""} you`;
  const needs = $("needs");
  let clear = needs.querySelector(".all-clear");
  // The setup card counts too: never say "nothing needs you" right under it.
  const setupOpen = !!document.getElementById("setup-need") && !$("setup-need").hidden;
  $("need-count").textContent = n + (setupOpen ? 1 : 0) === 0 ? "All clear" : `${n + (setupOpen ? 1 : 0)} need${n + (setupOpen ? 1 : 0) === 1 ? "s" : ""} you`;
  if (setupOpen && clear) { clear.remove(); clear = null; }
  if (n === 0 && !clear && !setupOpen) { clear = document.createElement("p"); clear.className = "all-clear"; clear.textContent = "Nothing needs you right now. Your team is working."; needs.style.display = "block"; needs.appendChild(clear); }
  if (!pending.has(selected)) selected = [...pending][0] ?? "";
  $("adetail").toggleAttribute("hidden", !selected);
  $("appr-empty").toggleAttribute("hidden", n > 0);
  document.querySelectorAll<HTMLElement>("#alist [data-a]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.a === selected)));
  const d = details[selected];
  if (d) {
    $("a-title").textContent = d.title; $("a-cost").textContent = d.cost;
    $("a-leaves").innerHTML = d.leaves; $("a-prev").innerHTML = d.prev; $("a-why").textContent = d.why; $("a-ok").textContent = d.ok;
  }
}
// When the setup form is sent (setup.ts hides its card), recount what needs the owner.
const setupCard = document.getElementById("setup-need");
if (setupCard) new MutationObserver(() => refresh()).observe(setupCard, { attributes: true, attributeFilter: ["hidden"] });
function resolve(id: string, msg: string): void {
  const card = document.querySelector<HTMLElement>(`[data-need="${id}"]`);
  card?.classList.add("gone");
  window.setTimeout(() => { pending.delete(id); refresh(); }, 220);
  toast(msg);
}
document.addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-resolve]");
  if (r) resolve(r.dataset.resolve!, r.dataset.msg ?? "Done");
  const a = (e.target as HTMLElement).closest<HTMLElement>("#alist [data-a]");
  if (a) { selected = a.dataset.a!; refresh(); }
});
$("a-ok").addEventListener("click", () => resolve(selected, "Approved"));
$("a-redo").addEventListener("click", () => toast("Redo requested, energy returned"));
$("a-edit").addEventListener("click", () => toast("Editing opens in the web editor (demo)"));

// Real data: when signed in and the API is running, replace the demo team with the real one.
let realOrg: Org | undefined;
const ROLE: Record<string, [string, string]> = { "finance-manager": ["FM", "av-fm"], "marketing-manager": ["MM", "av-mm"], "business-consultant": ["BC", "av-bc"], "hr-manager": ["HR", "av-hr"], "compliance-manager": ["CM", "av-cm"], "supply-chain-manager": ["SC", "av-sc"], "admin-manager": ["AM", "av-tl"] };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** The sidebar trial box from the real trial end; hidden once the client is on a paid plan. */
function showTrial(endsAt: string | undefined): void {
  if (!endsAt) { $("trial-box").hidden = true; return; }
  const DAY = 86_400_000, TRIAL_DAYS = 7;
  const left = Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / DAY));
  $("trial-left").textContent = left === 0 ? "Trial ends today" : `Trial: ${left} day${left === 1 ? "" : "s"} left`;
  $("trial-note").textContent = `Ends ${new Date(endsAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}. No card needed until then.`;
  $("trial-bar").style.width = `${Math.min(100, Math.round(((TRIAL_DAYS - left) / TRIAL_DAYS) * 100))}%`;
}

async function loadOrg(): Promise<void> {
  // Visitors without a login see the example business: the "Explore the demo" links land here.
  if (!getToken()) { $("demo-banner").hidden = false; return; }
  const r = await api<Org>("/org");
  // Guard: this device's login has expired -> log-in page.
  if (r.status === 401) { clearSession(); location.replace("/signin.html"); return; }
  // API unreachable (or not set up yet) -> keep the page usable as a demo, and say so.
  if (!r.ok || !r.data) { $("demo-banner").hidden = false; return; }
  realOrg = r.data;
  $("org-name").textContent = realOrg.name;
  $("org-av").textContent = initials(realOrg.name);
  $("greet").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${realOrg.name}`;
  orgName = realOrg.name;
  $("set-biz").textContent = realOrg.name; // Settings shows the signed-in company, not this device's last signup.
  setPeopleBusiness(realOrg.name);
  showTrial(realOrg.trialEndsAt);
  app.classList.add("is-live");
  // A real client never sees the example business's requests, and example-only panels say so.
  document.querySelectorAll<HTMLElement>("[data-need]").forEach((el) => el.remove());
  pending.clear();
  refresh();
  document.querySelectorAll<HTMLElement>("[data-example] .panel-h").forEach((h) => h.insertAdjacentHTML("beforeend", '<span class="badge badge-dark">Example until your apps are connected</span>'));
  route();
  const quota = realOrg.dailyQuotaPerEmployee;
  const pool = realOrg.teamEnergy;
  const n = (x: number) => x.toLocaleString("en-GB");
  const bar = (left: number, of: number) => {
    const pct = of > 0 ? Math.round((left / of) * 100) : 0;
    return `<div class="energy${pct < 25 ? " low" : ""}" style="margin-top:6px"><i style="width:${pct}%"></i></div>`;
  };
  // One shared pool: show it once, with when it refills, so a limit is never a surprise.
  const poolCard = pool
    ? `<div class="ecard"><div class="who"><span class="av av-tl">EN</span><div><b>Team energy</b><span>${pool.refillsAt ? `Refills ${esc(new Date(pool.refillsAt).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }))}` : "For the whole trial"}</span></div></div><div class="doing">${pool.percentUsed}% of ${pool.refillsAt ? "this week's" : "the trial's"} energy used${pool.topUpLeft > 0 ? ` · ${n(pool.topUpLeft)} top-up energy saved` : ""}</div><div><div class="e-lab"><span>Left</span><span>${100 - pool.percentUsed}%</span></div>${bar(pool.left, pool.pool)}</div></div>`
    : "";
  document.querySelector(".team")!.innerHTML = poolCard + realOrg.team.map((e) => {
    const [abbr, cls] = ROLE[e.templateKey] ?? ["AI", "av-tl"];
    const energy = pool
      ? `<div class="e-lab"><span>Uses the team energy</span></div>`
      : `<div><div class="e-lab"><span>Energy</span><span>${e.energyLeft} / ${quota}</span></div>${bar(e.energyLeft, quota)}</div>`;
    return `<div class="ecard"><div class="who"><span class="av ${cls}">${abbr}</span><div><b><a class="desk-a" href="#desk/${esc(e.templateKey)}">${esc(e.name)}</a></b><span>Standard</span></div></div><span class="status good"><span class="dot"></span>Ready</span><div class="doing">Waiting for your first request</div>${energy}</div>`;
  }).join("");
  if (realOrg.trialEndsAt) toast(`Free trial until ${new Date(realOrg.trialEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`);
}
void loadOrg();

// Settings: auto-reload for top-ups. Off by default; it never spends more than the monthly cap the owner sets.
type EnergyView = { team: Org["teamEnergy"] & { autoReload: { enabled: boolean; packGbp: number; monthlyCapGbp: number } | null; topUpLeft: number } | null };
async function loadTopUps(): Promise<void> {
  if (!getToken()) return;
  const r = await api<EnergyView>("/energy");
  const t = r.ok ? r.data?.team : null;
  if (!t) return;
  $("tu-left").textContent = `Top-up energy left: ${t.topUpLeft.toLocaleString("en-GB")}`;
  if (t.autoReload) {
    $<HTMLInputElement>("tu-on").checked = t.autoReload.enabled;
    $<HTMLSelectElement>("tu-pack").value = String(t.autoReload.packGbp);
    $<HTMLInputElement>("tu-cap").value = String(t.autoReload.monthlyCapGbp);
  }
}
$("tu-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!getToken()) { toast("Example only: log in to change auto-reload"); return; }
  const r = await api<EnergyView & { error?: string }>("/energy/auto-reload", { body: {
    enabled: $<HTMLInputElement>("tu-on").checked, packGbp: Number($<HTMLSelectElement>("tu-pack").value), monthlyCapGbp: Number($<HTMLInputElement>("tu-cap").value),
  } });
  $("tu-msg").textContent = r.ok ? "Saved." : (r.data as { error?: string } | undefined)?.error ?? "Could not save. Please try again.";
});
void loadTopUps();

// Account menu: sign out, and the Settings screen's account details.
function signOut(): void { clearSession(); location.href = "/signin.html"; }
document.querySelectorAll("[data-signout]").forEach((b) => b.addEventListener("click", signOut));
$("me-av").addEventListener("click", () => { location.hash = "#settings"; });
$("set-biz").textContent = biz;
$("set-email").textContent = profile.email || "The address you log in with";

// Ask bar: "finance: ..." / "marketing: ..." / "consultant: ..." / "hr: ..." / "compliance: ..." picks the employee; otherwise the consultant answers.
$<HTMLFormElement>("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("ask-in");
  const text = input.value.trim();
  if (!text) return;
  if (!realOrg) { toast("Admin manager got it and will route it (demo)"); input.value = ""; return; }
  const m = /^(finance|marketing|consultant|hr|compliance|supply)\s*[:,-]\s*(.+)$/is.exec(text);
  const key = m ? { finance: "finance-manager", marketing: "marketing-manager", consultant: "business-consultant", hr: "hr-manager", compliance: "compliance-manager", supply: "supply-chain-manager" }[m[1]!.toLowerCase() as "finance"] : "business-consultant";
  const emp = realOrg.team.find((x) => x.templateKey === key) ?? realOrg.team[0]!;
  toast(`${emp.name} is on it…`);
  const u = /^urgent\s*[:,-]\s*(.+)$/is.exec(m ? m[2]! : text);
  const r = await api<{ status: string; reason?: string; answer?: string; runsAt?: string; message?: string }>("/ask", { body: { text: u ? u[1] : m ? m[2] : text, employeeId: emp.id, urgent: !!u } });
  input.value = "";
  if (!r.ok || !r.data) { toast("Could not reach your team. Try again."); return; }
  // The server explains why in plain words (weekly pool, daily limit, full queue, trial ended, AI unavailable).
  if (r.data.status === "no_energy") { toast(r.data.message ?? (r.data.reason === "trial_ended" ? "Your free trial has ended" : "Your team is out of energy for now")); return; }
  if (r.data.status === "queued") { toast(`Queued with your next batch${r.data.runsAt ? `, runs ${new Date(r.data.runsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}. Start with "urgent:" to skip the wait.`); return; }
  if (r.data.status === "failed" || !r.data.answer) { toast(r.data.message ?? `${emp.name} couldn't answer just now. Try again in a few minutes.`); return; }
  showAnswer(emp.name, r.data.answer ?? "");
  void loadOrg();

// Settings: auto-reload for top-ups. Off by default; it never spends more than the monthly cap the owner sets.
type EnergyView = { team: Org["teamEnergy"] & { autoReload: { enabled: boolean; packGbp: number; monthlyCapGbp: number } | null; topUpLeft: number } | null };
async function loadTopUps(): Promise<void> {
  if (!getToken()) return;
  const r = await api<EnergyView>("/energy");
  const t = r.ok ? r.data?.team : null;
  if (!t) return;
  $("tu-left").textContent = `Top-up energy left: ${t.topUpLeft.toLocaleString("en-GB")}`;
  if (t.autoReload) {
    $<HTMLInputElement>("tu-on").checked = t.autoReload.enabled;
    $<HTMLSelectElement>("tu-pack").value = String(t.autoReload.packGbp);
    $<HTMLInputElement>("tu-cap").value = String(t.autoReload.monthlyCapGbp);
  }
}
$("tu-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!getToken()) { toast("Example only: log in to change auto-reload"); return; }
  const r = await api<EnergyView & { error?: string }>("/energy/auto-reload", { body: {
    enabled: $<HTMLInputElement>("tu-on").checked, packGbp: Number($<HTMLSelectElement>("tu-pack").value), monthlyCapGbp: Number($<HTMLInputElement>("tu-cap").value),
  } });
  $("tu-msg").textContent = r.ok ? "Saved." : (r.data as { error?: string } | undefined)?.error ?? "Could not save. Please try again.";
});
void loadTopUps();
});

function showAnswer(who: string, text: string): void {
  let box = document.getElementById("answer");
  if (!box) {
    box = document.createElement("section");
    box.id = "answer"; box.className = "panel";
    document.querySelector('[data-screen="home"]')?.prepend(box);
  }
  box.innerHTML = `<div class="panel-h"><h2>${esc(who)} says</h2><span class="r">Draft for you to review</span></div><div class="preview" style="white-space:pre-wrap">${esc(text)}</div>`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); $("ask-in").focus(); }
});

// Job descriptions in the team builder, from the same data the employees work to.
{
  const pick = $("jd-pick");
  pick.innerHTML = JOB_DESCRIPTIONS.map((j, i) => `<button class="chip" aria-pressed="${i === 0}" data-key="${j.key}">${esc(j.jobTitle)}</button>`).join("");
  const show = (key: string) => {
    const jd = getJobDescription(key);
    if (jd) $("jd-out").innerHTML = jdHtml(jd, 3);
    pick.querySelectorAll<HTMLElement>(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.key === key)));
  };
  pick.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
    if (b?.dataset.key) show(b.dataset.key);
  });
  show(JOB_DESCRIPTIONS[0]!.key);
}

// Skill tuning


initDash();
initRoleDesigner();
initDesk();
void initPeople(biz);
refresh();
initSetup(biz, profile.contact === "slack" ? "slack" : "dashboard");
initApps();
route();
