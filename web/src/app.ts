import "./styles.css";
import { toast } from "./common";
import { initSetup } from "./setup";
import { initApps } from "./apps";
import { initDash } from "./dash";
import { api, getToken, clearSession, type Org } from "./api";
import { JOB_DESCRIPTIONS, getJobDescription, jdHtml } from "./jd";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");

// Profile from onboarding (falls back to the example business).
let profile: { biz?: string; email?: string; slack?: boolean; contact?: string } = {};
try { profile = JSON.parse(localStorage.getItem("vn.profile") ?? "{}"); } catch { /* ignore */ }
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
  const key = location.hash.slice(1) || "home";
  const valid = screens.some((s) => s.dataset.screen === key) ? key : "home";
  screens.forEach((s) => s.toggleAttribute("hidden", s.dataset.screen !== valid));
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => {
    if (a.dataset.nav === valid) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  app.classList.remove("menu-open");
  const title = screens.find((x) => x.dataset.screen === valid)?.querySelector("h1")?.textContent ?? "Control center";
  document.title = `${valid === "home" ? "Overview" : title} · ${orgName} · MAIZ agents`;
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);

$("menu-btn").addEventListener("click", () => app.classList.toggle("menu-open"));
$("scrim").addEventListener("click", () => app.classList.remove("menu-open"));

// Toasts
document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-toast]");
  if (t) toast(t.dataset.toast ?? "");
});

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
  if (n === 0 && !clear) { clear = document.createElement("p"); clear.className = "all-clear"; clear.textContent = "Nothing needs you right now. Your team is working."; needs.style.display = "block"; needs.appendChild(clear); }
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
  app.classList.add("is-live");
  route();
  const quota = realOrg.dailyQuotaPerEmployee;
  document.querySelector(".team")!.innerHTML = realOrg.team.map((e) => {
    const [abbr, cls] = ROLE[e.templateKey] ?? ["AI", "av-tl"];
    const pct = Math.round((e.energyLeft / quota) * 100);
    return `<div class="ecard"><div class="who"><span class="av ${cls}">${abbr}</span><div><b>${esc(e.name)}</b><span>Standard</span></div></div><span class="status good"><span class="dot"></span>Ready</span><div class="doing">Waiting for your first request</div><div><div class="e-lab"><span>Energy</span><span>${e.energyLeft} / ${quota}</span></div><div class="energy${pct < 25 ? " low" : ""}" style="margin-top:6px"><i style="width:${pct}%"></i></div></div></div>`;
  }).join("");
  if (realOrg.trialEndsAt) toast(`Free trial until ${new Date(realOrg.trialEndsAt).toLocaleDateString()}`);
}
void loadOrg();

// Account menu: sign out, and the Settings screen's account details.
function signOut(): void { clearSession(); location.href = "/signin.html"; }
document.querySelectorAll("[data-signout]").forEach((b) => b.addEventListener("click", signOut));
$("me-av").addEventListener("click", () => { location.hash = "#settings"; });
$("set-biz").textContent = biz;
$("set-email").textContent = profile.email || "Not set";

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
  const r = await api<{ status: string; reason?: string; answer?: string }>("/ask", { body: { text: m ? m[2] : text, employeeId: emp.id } });
  input.value = "";
  if (!r.ok || !r.data) { toast("Could not reach your team. Try again."); return; }
  if (r.data.status === "no_energy") { toast(r.data.reason === "trial_ended" ? "Your free trial has ended" : `${emp.name} has used today's energy`); return; }
  showAnswer(emp.name, r.data.answer ?? "");
  void loadOrg();
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
const skills: Record<string, string> = { Standard: "100 · £12.30/mo", Pro: "200 · £21.40/mo", Expert: "400 · £38.00/mo" };
$("skill").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!b) return;
  $("skill").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
  $("skill-out").textContent = skills[b.textContent ?? "Standard"] ?? "";
});

initDash();
refresh();
initSetup(biz, profile.contact === "slack" ? "slack" : "dashboard");
initApps();
route();
