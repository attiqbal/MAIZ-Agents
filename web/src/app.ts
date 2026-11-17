import "./styles.css";
import { toast } from "./common";
import { startWorking } from "./ask-status";
import { askStream, describeOutcome } from "./stream";
import { initChat, showChat } from "./chat";
import { initBell } from "./notify";
import { initSuggestions } from "./suggest";
import { initSetup } from "./setup";
import { initApps } from "./apps";
import { initDash } from "./dash";
import { initRoleDesigner } from "./role-designer";
import { initPeople, setPeopleBusiness } from "./people";
import { initDesk, showDesk } from "./desk";
import { renderDeptBar } from "./dept";
import { api, getToken, clearSession, type Org } from "./api";
import { startNeeds, loadNeeds } from "./needs";
import { JOB_DESCRIPTIONS, getJobDescription, jdHtml } from "./jd";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
// A signed-in client never sees the example rows of Approvals, Books and cash or the calendar, not even while
// their own records load: the examples are hidden at once and the real screens draw in their place (needs.ts,
// approvals-live.ts, books-live.ts, calendar-live.ts).
const signedIn = !!getToken();
app.classList.toggle("signed-in", signedIn);

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
$("slack-state").textContent = profile.slack ? "On" : "Off";


// Routing
const screens = Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"));
function route(): void {
  // "#desk/finance-manager" opens one employee's dashboard; every other hash is a screen.
  const [key = "home", sub = ""] = (location.hash.slice(1) || "home").split("/");
  const valid = screens.some((s) => s.dataset.screen === key) ? key : "home";
  // The Data mining agent has its own working screen, not an example dashboard.
  if (valid === "desk" && sub === "data-mining-agent") { location.replace("#mining"); return; }
  if (valid === "desk") showDesk(sub);
  if (valid === "mining") void import("./mining").then((m) => m.showMining());
  if (valid === "chat") void showChat(sub);
  if (valid === "firstday") void import("./firstday").then((m) => m.showFirstDay());
  if (valid === "apps") void import("./apps").then((m) => m.setAppsView(sub));
  if (valid === "apps") void import("./agents").then((m) => m.showAgents());
  if (valid === "slack") void import("./apps").then((m) => m.initSlackTab(Boolean(profile.slack)));
  if (signedIn && valid === "approvals") void import("./approvals-live").then((m) => m.showApprovals());
  if (signedIn && valid === "finance") void import("./books-live").then((m) => m.showBooks());
  if (signedIn && valid === "compliance") void import("./calendar-live").then((m) => m.showCalendar());
  screens.forEach((s) => s.toggleAttribute("hidden", s.dataset.screen !== valid));
  // Slack lives inside Apps and connections, so the rail marks that entry for it.
  const here = valid === "desk" ? `desk/${sub}` : valid === "slack" ? "apps" : valid;
  // Inside a department, the rail marks the department for every one of its tabs.
  const dept = renderDeptBar(here);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-nav]"));
  const exact = links.some((a) => a.dataset.nav === here);
  links.forEach((a) => {
    const on = exact ? a.dataset.nav === here : dept !== undefined && a.dataset.dept === dept.key;
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  app.classList.remove("menu-open"); $("menu-btn").setAttribute("aria-expanded", "false");
  const title = screens.find((x) => x.dataset.screen === valid)?.querySelector("h1")?.textContent ?? "Control centre";
  document.title = `${valid === "home" ? "Overview" : title} · ${orgName} · MAIZ Agents`;
  if (dept && valid !== "desk") document.title = `${dept.name}: ${title} · ${orgName} · MAIZ Agents`;
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);
// The store opens inside the control centre, so hiring never leaves the app. Loaded on first visit.
let storeReady = false;
function openStoreIfShown(): void {
  if (storeReady || location.hash !== "#store") return;
  storeReady = true;
  void import("./store").then((m) => m.initStore({ onPaid: () => { void loadOrg(); void meetNewHires(); } }));
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
  // A signed-in client's counts and "Needs you" list come from their real records, never from the example items.
  if (signedIn) { startNeeds(); void loadNeeds(); return; }
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
const ROLE: Record<string, [string, string]> = { "finance-manager": ["FM", "av-fm"], "marketing-manager": ["MM", "av-mm"], "business-consultant": ["BC", "av-bc"], "hr-manager": ["HR", "av-hr"], "compliance-manager": ["CM", "av-cm"], "supply-chain-manager": ["SC", "av-sc"], "data-mining-agent": ["DM", "av-dm"], "admin-manager": ["AM", "av-tl"] };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** The sidebar trial box and the Overview chip, from the real end date; hidden once the client is on a paid plan. */
function showTrial(endsAt: string | undefined, planEnded = false): void {
  const chip = $("trial-chip");
  if (!endsAt) { $("trial-box").hidden = true; chip.hidden = true; return; }
  const DAY = 86_400_000;
  const over = new Date(endsAt).getTime() <= Date.now();
  const left = Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / DAY));
  const what = planEnded ? "Plan" : "Trial";
  const headline = over ? `${planEnded ? "Your plan" : "Your trial"} has ended` : left <= 1 ? `${what} ends ${left === 0 ? "today" : "tomorrow"}` : `${what}: ${left} days left`;
  const date = new Date(endsAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  $("trial-box").hidden = false;
  $("trial-left").textContent = headline;
  $("trial-note").textContent = over ? "Your team is paused and your work is kept. Start the Team package to carry on." : planEnded ? `Your team works until ${date}.` : "";
  $("trial-cta").textContent = planEnded ? "Start your plan again" : "Choose your plan";
  chip.hidden = false;
  chip.textContent = `${headline}. ${planEnded ? "Start again" : "Choose your plan"}`;
}

const LOCAL_PREVIEW = ["localhost", "127.0.0.1"].includes(location.hostname);

/** Someone just joined the team: take the owner to meet them, as people, instead of a bare "paid" message. */
async function meetNewHires(): Promise<void> {
  const { introduceNewHires } = await import("./firstday");
  if (await introduceNewHires()) location.hash = "#firstday";
}
if (new URLSearchParams(location.search).has("order")) {
  // Back from the payment page after paying: the cart is emptied once, and the address is tidied so a reload does not empty it again.
  try { localStorage.removeItem("maiz.cart"); } catch { /* storage unavailable */ }
  history.replaceState(null, "", location.pathname + location.hash);
  void meetNewHires();
}

async function loadOrg(): Promise<void> {
  // The control centre is for signed-in customers only; there is no public demo. Logged-out visitors
  // go to the log-in page. Only local development and the QA run (localhost) keep the example business.
  if (!getToken()) {
    if (!LOCAL_PREVIEW) { location.replace("/signin.html"); return; }
    $("demo-banner").hidden = false; return;
  }
  const [r, me] = await Promise.all([api<Org>("/org"), api<{ platformOwner?: boolean; hasOrganisation?: boolean }>("/me")]);
  // Guard: this device's login has expired -> log-in page.
  if (r.status === 401 || me.status === 401) { clearSession(); location.replace("/signin.html"); return; }
  if (me.data?.platformOwner) $("owner-admin-link").hidden = false;
  if (!r.ok || !r.data) {
    // Signed in but no team: the platform owner goes to the owner admin, a new client to setup. Sample data never shows to a signed-in person.
    if (!LOCAL_PREVIEW) {
      if (me.data?.platformOwner) { location.replace("/owner-decisions.html"); return; }
      if (r.status === 404) { location.replace("/onboarding.html"); return; }
      toast("We can't load your control centre right now. Please reload in a moment.");
      return;
    }
    $("demo-banner").hidden = false; return;
  }
  realOrg = r.data;
  $("ask-when").hidden = false;
  warmUp();
  $("org-name").textContent = realOrg.name;
  $("org-av").textContent = initials(realOrg.name);
  $("greet").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${realOrg.name}`;
  orgName = realOrg.name;
  $("set-biz").textContent = realOrg.name; // Settings shows the signed-in company, not this device's last signup.
  setPeopleBusiness(realOrg.name);
  showTrial(realOrg.trialEndsAt, realOrg.planEnded === true);
  void loadBilling();
  app.classList.add("is-live");
  const hasDataAgent = realOrg.team.some((e) => e.templateKey === "data-mining-agent");
  $("mining-link").hidden = !hasDataAgent;
  app.classList.toggle("has-dm", hasDataAgent);
  // A real client never sees the example business's requests, and example-only panels say so.
  document.querySelectorAll<HTMLElement>("[data-need]").forEach((el) => el.remove());
  pending.clear();
  refresh();
  document.querySelectorAll<HTMLElement>("[data-example] .panel-h").forEach((h) => { if (!h.querySelector(".badge")) h.insertAdjacentHTML("beforeend", '<span class="badge badge-dark">Example until your apps are connected</span>'); });
  // The Overview never shows a real client made-up figures: each panel says what will show there and how to get it.
  // Energy and activity are filled from their own records a moment later (dash-live.ts).
  const pulse = $("ov-pulse");
  pulse.className = "ov-empty";
  pulse.innerHTML = '<p class="muted">Your cash, revenue and customer figures show here once your accounts, till or payments are connected. Your team only reads them.</p><p><a class="btn btn-sm btn-ghost" href="#apps">Connect your apps</a></p>';
  $("ov-brief").innerHTML = '<li class="muted">Your Admin manager writes a short briefing here each morning once your team has done its first work.</li>';
  $("ov-brief-r").textContent = "Admin manager";
  if (!$("ov-activity").dataset.live) $("ov-activity").innerHTML = '<li class="muted">No work yet today. Ask your team for something with the bar at the top.</li>';
  if (!$("ov-energy").dataset.live) { $("ov-energy").innerHTML = '<p class="muted small">No energy used yet this week.</p>'; $("ov-energy-r").textContent = "Open energy"; }
  route();
  const quota = realOrg.dailyQuotaPerEmployee;
  const pool = realOrg.teamEnergy;
  $("energy-chip").textContent = pool ? `Energy ${100 - pool.percentUsed}% left` : "Energy";
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
}
void loadOrg();

// Settings: the plan, the provider's billing page (card, invoices, cancel) and what has been bought.
interface OrderRow { id: string; status: string; lines: { title: string; qty: number }[]; dueTodayMinor: number; createdAt: string; paidAt?: string; discount?: { code: string; amountOffMinor: number }; problem?: string }
const ORDER_STATE: Record<string, string> = { paid: "Paid", pending: "Waiting for payment", failed: "Not paid", cancelled: "Cancelled" };
const pounds = (minor: number) => `£${(minor / 100).toLocaleString("en-GB", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
async function loadBilling(): Promise<void> {
  if (!getToken() || !realOrg) return;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const ends = realOrg.trialEndsAt;
  const over = !!ends && new Date(ends).getTime() <= Date.now();
  $("bill-state").textContent = !ends ? "Team package" : realOrg.planEnded ? (over ? "Plan ended" : "Plan ending") : over ? "Trial ended" : "Free trial";
  $("bill-plan").textContent = !ends ? "You are on the Team package. It renews every month until you cancel, and you keep the month you paid for."
    : realOrg.planEnded ? (over ? `Your plan ended on ${day(ends)}. Your work is kept; start the Team package again to carry on.` : `Your plan was cancelled and your team works until ${day(ends)}. You can start it again any time.`)
    : over ? `Your free trial ended on ${day(ends)}. Your work is kept; choose your plan to carry on.` : `Your free trial runs until ${day(ends)}. Nothing is charged unless you choose a plan.`;
  $("bill-choose").hidden = !ends;
  const r = await api<{ enabled: boolean; orders: OrderRow[] }>("/orders");
  const orders = r.ok ? r.data?.orders ?? [] : [];
  $("bill-portal").hidden = !orders.some((o) => o.paidAt);
  $("bill-orders-wrap").hidden = orders.length === 0;
  $("bill-orders").innerHTML = orders.length ? `<thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Paid today</th><th scope="col">Status</th></tr></thead><tbody>${orders.slice(0, 12).map((o) =>
    `<tr><td>${esc(day(o.paidAt ?? o.createdAt))}</td><td>${esc(o.lines.map((l) => (l.qty > 1 ? `${l.qty} × ${l.title}` : l.title)).join(", "))}${o.discount ? `<br><span class="small muted">Code ${esc(o.discount.code)}: ${pounds(o.discount.amountOffMinor)} off</span>` : ""}</td><td class="mono">${pounds(o.dueTodayMinor)}</td><td>${esc(ORDER_STATE[o.status] ?? o.status)}${o.problem ? `<br><span class="small muted">${esc(o.problem)}</span>` : ""}</td></tr>`).join("")}</tbody>` : "";
}
$("bill-portal").addEventListener("click", async () => {
  const b = $<HTMLButtonElement>("bill-portal");
  b.disabled = true;
  $("bill-msg").textContent = "Opening your billing page…";
  const r = await api<{ url?: string; error?: string }>("/billing/portal", { body: {} });
  if (r.ok && r.data?.url) { location.assign(r.data.url); return; }
  b.disabled = false;
  $("bill-msg").textContent = r.data?.error ?? "Could not open your billing page. Please try again.";
});
if (getToken()) void import("./push").then((m) => m.mountPushControls($("set-push"), (text) => { $("set-push-msg").textContent = text; }));
else $("set-push").innerHTML = '<p class="small muted">Log in to turn alerts on for this device.</p>';

// Settings: auto-reload for top-ups. Off by default; it never spends more than the monthly cap the owner sets.
type EnergyView = { team: Org["teamEnergy"] & { autoReload: { enabled: boolean; packGbp: number; monthlyCapGbp: number } | null; topUpLeft: number } | null };
async function loadTopUps(): Promise<void> {
  if (!getToken()) return;
  const r = await api<EnergyView>("/energy");
  const t = r.ok ? r.data?.team : null;
  if (!t) return;
  $("tu-left").textContent = `Top-up energy left: ${t.topUpLeft.toLocaleString("en-GB")}`;
  $("wal-top").textContent = t.topUpLeft.toLocaleString("en-GB");
  $("wal-cap").textContent = `£${t.autoReload?.monthlyCapGbp ?? 25}`;
  $("wal-auto").textContent = t.autoReload?.enabled ? "On" : "Off";
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
  if (r.ok) void loadTopUps();
});
void loadTopUps();

// Settings: a gift or discount code. The server says in plain words why a code is refused.
async function loadCodes(): Promise<void> {
  if (!getToken()) return;
  const r = await api<{ used: { code: string; at: string; applied: string }[] }>("/coupons");
  const used = r.ok ? r.data?.used ?? [] : [];
  $("cp-used").innerHTML = used.map((u) => `<li><b>${esc(u.code)}</b>: ${esc(u.applied)} (${new Date(u.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })})</li>`).join("");
}
$("cp-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const code = $<HTMLInputElement>("cp-code").value.trim();
  const msg = $("cp-msg");
  if (!code) { msg.textContent = "Enter your code first."; $("cp-code").setAttribute("aria-invalid", "true"); $("cp-code").focus(); return; }
  if (!getToken()) { toast("Example only: log in to use a code"); return; }
  const r = await api<{ applied?: string; error?: string }>("/coupons/redeem", { body: { code } });
  $("cp-code").setAttribute("aria-invalid", String(!r.ok));
  msg.textContent = r.ok ? `Done: ${r.data?.applied}.` : r.data?.error ?? "Could not apply the code. Please try again.";
  if (r.ok) { $<HTMLInputElement>("cp-code").value = ""; void loadCodes(); void loadOrg(); void loadTopUps(); }
});
void loadCodes();

// Account menu: sign out, and the Settings screen's account details.
/** Logging out also stops this device's alerts, so the next person to use it is not sent this account's news. */
async function signOut(): Promise<void> {
  try { await (await import("./push")).turnOffPush(); } catch { /* alerts were not on */ }
  clearSession();
  location.href = "/signin.html";
}
document.querySelectorAll("[data-signout]").forEach((b) => b.addEventListener("click", () => void signOut()));
$("me-av").addEventListener("click", () => { location.hash = "#settings"; });
$("set-biz").textContent = biz;
$("set-email").textContent = profile.email || "The address you log in with";

// Ask bar: "finance: ..." / "marketing: ..." / "consultant: ..." / "hr: ..." / "compliance: ..." picks the employee; otherwise the consultant answers.
let asking = false;
// "When do you need it?": none chosen lets MAIZ decide, otherwise the choice is sent with the next question only.
let chosenWhen: "now" | "tonight" | undefined;
document.querySelectorAll<HTMLButtonElement>("#ask-when .chip").forEach((b) => b.addEventListener("click", () => {
  chosenWhen = chosenWhen === b.dataset.when ? undefined : (b.dataset.when as "now" | "tonight");
  document.querySelectorAll<HTMLButtonElement>("#ask-when .chip").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.when === chosenWhen)));
}));
function resetWhen(): void { chosenWhen = undefined; document.querySelectorAll("#ask-when .chip").forEach((x) => x.setAttribute("aria-pressed", "false")); }

// Wake the GPU while the person is still typing, so the answer does not start with a cold start. The server also
// limits this, so calling it often costs nothing; this just keeps us from asking more than every few minutes.
let lastWarm = 0;
function warmUp(): void {
  if (!getToken() || Date.now() - lastWarm < 4 * 60_000) return;
  lastWarm = Date.now();
  void api("/warm", { method: "POST", body: {} });
}
$("ask-in").addEventListener("focus", warmUp);
$<HTMLFormElement>("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("ask-in");
  const text = input.value.trim();
  if (!text) return;
  if (!realOrg) { toast("Admin manager got it and will route it (demo)"); input.value = ""; return; }
  const m = /^(finance|marketing|consultant|hr|compliance|supply|data)\s*[:,-]\s*(.+)$/is.exec(text);
  const key = m ? { finance: "finance-manager", marketing: "marketing-manager", consultant: "business-consultant", hr: "hr-manager", compliance: "compliance-manager", supply: "supply-chain-manager", data: "data-mining-agent" }[m[1]!.toLowerCase() as "finance"] : "business-consultant";
  const emp = realOrg.team.find((x) => x.templateKey === key) ?? realOrg.team[0]!;
  if (asking) { toast("Still working on your last question"); return; }
  asking = true;
  const stopWorking = startWorking(emp.name);
  const u = /^urgent\s*[:,-]\s*(.+)$/is.exec(m ? m[2]! : text);
  // The answer is written into the panel as it arrives. textContent only: streamed words are never parsed as HTML.
  const live = streamPanel(emp.name);
  const sent = u ? u[1]! : m ? m[2]! : text;
  const result = await askStream({ text: sent, employeeId: emp.id, urgent: !!u, ...(chosenWhen ? { when: chosenWhen } : {}) }, live);
  stopWorking();
  asking = false;
  if (!result.ok) { showNote(emp.name, result.message ?? "I could not reach your team. Your question is still in the box, so you can send it again.", true); return; }
  input.value = "";
  resetWhen();
  const out = describeOutcome(emp.name, result.done);
  if (out.kind === "queued") { showQueued(emp.name, result.done.runsAt); return; }
  if (out.kind === "note") { showNote(emp.name, out.text); return; }
  showAnswer(emp.name, out.text, result.done.checked === true, key);
  void loadOrg();
});

function answerBox(): HTMLElement {
  let box = document.getElementById("answer");
  box?.removeAttribute("aria-busy");
  if (!box) {
    box = document.createElement("section");
    box.id = "answer"; box.className = "panel";
    document.querySelector('[data-screen="home"]')?.prepend(box);
  }
  return box;
}
/** A plain note that stays on screen (a toast disappears before most people have read it). */
function showNote(who: string, text: string, isError = false): void {
  const box = answerBox();
  box.setAttribute("role", isError ? "alert" : "status");
  box.innerHTML = `<div class="panel-h"><h2>${esc(who)}</h2></div><div class="preview">${esc(text)}</div>`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
/** Receipt for work that waits for the batch: says when it runs and offers to run it now. */
function showQueued(who: string, runsAt?: string): void {
  const when = runsAt ? new Date(runsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "your next batch";
  const box = answerBox();
  box.setAttribute("role", "status");
  box.innerHTML = `<div class="panel-h"><h2>${esc(who)} will do this ${runsAt ? "at " + esc(when) : "with your next batch"}</h2><span class="r">Queued</span></div><div class="preview">Batching saves energy. Need it sooner?</div><p><button class="btn btn-sm btn-primary" id="run-now" type="button">Run it now</button></p>`;
  document.getElementById("run-now")?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    b.disabled = true; b.textContent = "Starting…";
    const res = await api("/queue/run-now", { method: "POST", body: {} });
    if (res.ok) showNote(who, "Started. Finished work will arrive in your inbox and on the Tasks screen.");
    else { b.disabled = false; b.textContent = "Run it now"; toast("Could not start it just now. Try again in a minute."); }
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function showAnswer(who: string, text: string, checked: boolean, key: string): void {
  const box = answerBox();
  box.setAttribute("role", "status");
  box.innerHTML = `<div class="panel-h"><h2>${esc(who)} says</h2><span class="r">${checked ? "Checked, for you to review" : "Draft for you to review"}</span></div><div class="preview" style="white-space:pre-wrap">${esc(text)}</div><p><a class="btn btn-sm btn-ghost" href="#chat/${esc(key)}">Follow up in conversation</a></p>`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
/** An answer panel that fills in word by word. Reading aloud waits for the finished answer (aria-busy), not every word. */
function streamPanel(who: string): { onDelta(piece: string): void; onReset(): void } {
  const box = answerBox();
  box.removeAttribute("role");
  box.setAttribute("aria-busy", "true");
  box.innerHTML = `<div class="panel-h"><h2>${esc(who)} says</h2><span class="r">Writing…</span></div><div class="preview" style="white-space:pre-wrap" id="answer-live"></div>`;
  const el = document.getElementById("answer-live")!;
  let shown = false;
  return {
    onDelta: (piece) => { el.textContent += piece; if (!shown) { shown = true; window.scrollTo({ top: 0, behavior: "smooth" }); } },
    onReset: () => { el.textContent = ""; },
  };
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
initChat();
initBell();
// A suggestion's question goes into the ask bar for the person to read and send, never sent for them.
void initSuggestions((employee, text) => {
  const i = $<HTMLInputElement>("ask-in");
  i.value = `${employee}: ${text}`;
  i.focus();
});
initRoleDesigner();
initDesk();
void initPeople(biz);
refresh();
initSetup(biz, profile.contact === "slack" ? "slack" : "dashboard");
initApps();
route();
