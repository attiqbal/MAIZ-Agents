// The first day: the team arrives as people. Each introduces themselves, asks the owner for what
// they need (details only the owner knows, then read-only access to the apps they work from), and
// tests every connection for real. It uses the same backend as the old setup form: the answers go
// to the Admin manager's /api/setup in one go, so nothing here is a second source of truth.
//
// The conversation is a script of named steps. Finished steps are remembered in this browser, so
// leaving and coming back picks up where it stopped, and a person hired later from the store gets
// their own introduction the same way.
import { validateAnswers, formFor, type Answers, type FormField } from "../../src/modules/admin-manager/form";
import { SETUP_STEPS } from "../../src/modules/admin-manager/messages";
import { planSignup, readSignupAnswers } from "../../src/modules/onboarding/recommend";
import { PERSONAS, connectOptions, introLines, personaFor, type Persona } from "../../src/modules/onboarding/people";
import { api, getToken } from "./api";
import { offerApps, testConnection, type CatalogueItem, type Connection } from "./firstday-connect";
import { chips, clearLog, drawRoster, note, paint, pause, reply, setPeople, showWho, speak, who, esc, type LogEntry } from "./firstday-ui";

const KEY = "maiz.firstday";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DEMO_TEAM = ["finance-manager", "marketing-manager", "business-consultant", "hr-manager", "compliance-manager"];

interface Saved { log: LogEntry[]; done: string[]; answers: Answers; met: string[]; version: 1 }
interface Prefill { answers: Answers; source: Record<string, "you" | "guess"> }
interface SetupStatus { state: "awaiting_form" | "setting_up" | "ready" | "needs_attention"; form: FormField[]; prefill?: Prefill; runs: { status: string; steps: { title: string; status: string }[] }[] }
interface OrgInfo { name: string; team: { templateKey: string; name: string; blurb?: string }[] }

function load(): Saved {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "null"); if (v?.version === 1) return v; } catch { /* storage unavailable */ }
  return { log: [], done: [], answers: {}, met: [], version: 1 };
}
let saved: Saved = load();
const persist = (): void => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* ignore */ } };
const isDone = (id: string): boolean => saved.done.includes(id);
const finish = (id: string): void => { if (!isDone(id)) saved = { ...saved, done: [...saved.done, id] }; persist(); };
async function say(key: string, text: string): Promise<void> {
  const entry = { who: key, text };
  saved = { ...saved, log: [...saved.log, entry] };
  persist();
  showWho(key);
  await speak(entry);
}
const onSaid = (text: string): void => { saved = { ...saved, log: [...saved.log, { who: "you", text }] }; persist(); };

let started = false;
let running = false;

export function showFirstDay(): void {
  if (started) return;
  started = true;
  saved = load();
  clearLog();
  saved.log.forEach(paint);
  void run();
}

/** After a purchase: is there anyone on the team the owner has not met yet? If so, the first-day conversation introduces them. */
export async function introduceNewHires(): Promise<boolean> {
  if (!getToken()) return false;
  const org = await api<OrgInfo>("/org");
  const met = new Set(load().met);
  const fresh = (org.data?.team ?? []).some((t) => t.templateKey !== "admin-manager" && !met.has(t.templateKey));
  if (fresh) { started = false; running = false; }
  return fresh;
}

async function context(): Promise<{ biz: string; team: string[]; status: SetupStatus; catalogue: CatalogueItem[]; connections: Connection[]; live: boolean; owned: string[] }> {
  let profile: { biz?: string; apps?: string[] } = {};
  try { profile = JSON.parse(localStorage.getItem("maiz.profile") ?? "{}"); } catch { /* ignore */ }
  const live = !!getToken();
  const org = live ? await api<OrgInfo>("/org") : undefined;
  const team = org?.ok && org.data ? org.data.team.map((t) => t.templateKey).filter((k) => k !== "admin-manager") : DEMO_TEAM;
  const st = live ? await api<SetupStatus>("/setup") : undefined;
  let status: SetupStatus;
  if (st?.ok && st.data) status = st.data;
  else {
    let prefill: Prefill | undefined;
    if (profile.biz) { try { prefill = planSignup(readSignupAnswers({ businessName: profile.biz, sector: (profile as any).sector, needs: (profile as any).needs, apps: profile.apps, size: (profile as any).size, country: (profile as any).country, sells: (profile as any).sells })).prefill; } catch { /* no guess */ } }
    status = { state: "awaiting_form", form: formFor(team), prefill, runs: [] };
  }
  const apps = live ? await api<{ catalogue: CatalogueItem[]; connections: Connection[] }>("/integrations") : undefined;
  return { biz: org?.data?.name ?? profile.biz ?? "your business", team, status, catalogue: apps?.data?.catalogue ?? [], connections: apps?.data?.connections ?? [], live, owned: profile.apps ?? [] };
}

/** One question, in the voice of the person who needs the answer. Returns the clean answer, or undefined when skipped. */
async function askField(f: FormField, prefill: Prefill | undefined): Promise<Answers[string] | undefined> {
  const speaker = f.for === "all" ? "admin-manager" : f.for;
  const guess = prefill?.answers[f.key];
  const printable = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
  if (guess !== undefined && guess !== "") {
    await say(speaker, `${f.label}\nFrom what you told us at sign-up I've put: "${printable(guess)}". ${prefill?.source[f.key] === "guess" ? "That's our guess, so please check it." : "Is that still right?"}`);
    const keep = await reply<boolean>((host, done) => chips(host, "Is this right?", [{ v: "y", label: "Yes, that's right" }, { v: "n", label: "Let me change it" }], (v, l) => done(v === "y", l)), onSaid);
    if (keep) return guess as Answers[string];
  } else {
    await say(speaker, f.help ? `${f.label}\n${f.help}` : f.label);
  }
  for (;;) {
    const raw = await reply<Answers[string] | null>((host, done) => answerControl(host, f, done), onSaid);
    if (raw === null) return undefined;
    const check = validateAnswers([f], { [f.key]: raw });
    if (check.ok) return check.clean[f.key];
    await say(speaker, check.errors[f.key] ?? "I couldn't use that one. Could you try again?");
  }
}

function answerControl(host: HTMLElement, f: FormField, done: (v: Answers[string] | null, said: string) => void): void {
  const skip = f.required ? [] : [{ v: "__skip", label: "Skip, I don't know", quiet: true }];
  const say = (v: Answers[string], shown?: string) => done(v, shown ?? (Array.isArray(v) ? v.join(", ") || "None of these" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)));
  if (f.type === "yesno") { chips(host, f.label, [{ v: "y", label: "Yes" }, { v: "n", label: "No" }, ...skip], (v, l) => (v === "__skip" ? done(null, l) : say(v === "y"))); return; }
  if (f.type === "choice" || f.type === "month") { chips(host, f.label, [...(f.options ?? []).map((o) => ({ v: o, label: o })), ...skip], (v, l) => (v === "__skip" ? done(null, l) : say(v))); return; }
  if (f.type === "multi") {
    const wrap = document.createElement("div");
    wrap.className = "fd-opts";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", f.label);
    wrap.innerHTML = (f.options ?? []).map((o) => `<button type="button" class="chip" aria-pressed="false">${esc(o)}</button>`).join("");
    wrap.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip"); if (b) b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); });
    const acts = document.createElement("div");
    acts.className = "acts";
    acts.innerHTML = `<button class="btn btn-primary btn-sm" type="button">Done</button><button class="btn btn-quiet btn-sm" type="button">Skip</button>`;
    const [ok, no] = Array.from(acts.querySelectorAll("button"));
    ok!.addEventListener("click", () => say(Array.from(wrap.querySelectorAll<HTMLElement>("[aria-pressed='true']")).map((b) => b.textContent ?? "")));
    no!.addEventListener("click", () => done(null, "Skip."));
    host.append(wrap, acts);
    return;
  }
  const form = document.createElement("form");
  form.className = "fd-form fd-inline";
  const long = f.type === "longtext";
  form.innerHTML = `${long ? `<textarea class="input" rows="3" aria-label="${esc(f.label)}"></textarea>` : `<input class="input" aria-label="${esc(f.label)}"${f.type === "number" ? ' inputmode="numeric"' : ""}>`}<button class="btn btn-primary btn-sm" type="submit">Send</button>${f.required ? "" : `<button class="btn btn-quiet btn-sm" type="button" data-skip>Skip</button>`}`;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (form.querySelector("input, textarea") as HTMLInputElement).value.trim();
    if (!v) { if (!form.querySelector(".err")) note(form, f.required ? "I need an answer to this one." : "Type an answer, or skip.", "err"); return; }
    say(v);
  });
  form.querySelector("[data-skip]")?.addEventListener("click", () => done(null, "Skip, I don't know."));
  host.appendChild(form);
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  const c = await context();
  const everyone = ["admin-manager", ...c.team];
  setPeople(everyone.map((k) => personaFor(k, PERSONAS.find((p) => p.key === k)?.role)));
  const roster = () => drawRoster(everyone, new Set(saved.met));
  roster();
  const newcomers = c.team.filter((k) => !saved.met.includes(k));
  const firstTime = !saved.met.includes("admin-manager");
  $("fd-reply").setAttribute("hidden", "");

  // 1. Arrivals: Maya first, then everyone else introduces themselves.
  if (firstTime) {
    await say("admin-manager", `Welcome to ${c.biz}. Your team is here and they'd like to meet you before they start.`);
  } else if (newcomers.length) {
    await say("admin-manager", `Good news: ${newcomers.map((k) => who(k).name).join(" and ")} just joined ${c.biz}. Let me introduce ${newcomers.length === 1 ? "them" : "them one at a time"}.`);
  }
  for (const key of firstTime ? everyone : newcomers) {
    const p = who(key);
    if (isDone(`met:${key}`)) continue;
    for (const line of introLines(p, c.biz)) await say(key, line);
    saved = { ...saved, met: [...saved.met, key] };
    finish(`met:${key}`);
    roster();
    await pause(250);
  }

  // 2. Details only the owner knows, each asked by the person who needs it.
  const missing = c.status.form.filter((f) => saved.answers[f.key] === undefined && !isDone(`skip:${f.key}`));
  const settingUp = c.status.state === "awaiting_form" || c.status.state === "needs_attention";
  if (settingUp && missing.length) {
    if (!isDone("details-intro")) {
      await say("admin-manager", `Now the part only you can do. Each of them has a question or two about ${c.biz}. Skip anything you don't know: I'll mark anything we guess as a guess.`);
      finish("details-intro");
    }
    for (const f of missing) {
      const v = await askField(f, c.status.prefill);
      if (v === undefined) finish(`skip:${f.key}`); else saved = { ...saved, answers: { ...saved.answers, [f.key]: v } };
      persist();
    }
  }

  // 3. Hand the answers to the Admin manager, who sets everything up.
  if (settingUp && !isDone("submitted")) await submit(c);

  // 4. Access: the people who work from an app ask for it, and test it.
  for (const key of c.team) {
    const p = who(key);
    if (isDone(`access:${key}`) || !p.accessWhy) continue;
    await access(p, c);
    finish(`access:${key}`);
  }

  // 5. Slack, where the Admin manager can reach the owner.
  if (!isDone("slack") && c.live) {
    await say("admin-manager", "One last thing, if you use Slack. I can send my briefing and your approvals there so you don't have to open this page. Want that?");
    const yes = await reply<boolean>((host, done) => chips(host, "Connect Slack?", [{ v: "y", label: "Yes, connect Slack" }, { v: "n", label: "No thanks, keep it here", quiet: true }], (v, l) => done(v === "y", l)), onSaid);
    finish("slack");
    if (yes) {
      const r = await api<{ url?: string; error?: string }>("/slack/install?returnTo=firstday");
      if (r.ok && r.data?.url) { await say("admin-manager", "Opening Slack so you can approve me. I can't see the result from here, so if Slack shows its approval screen you're done and my next message will appear there."); location.assign(r.data.url); return; }
      await say("admin-manager", "Slack isn't switched on for this site yet, so I'll keep everything here in your control centre. Nothing is lost.");
    }
  }

  // 6. Close: what happens next, honestly.
  if (!isDone("close")) {
    const lead = c.team.map((k) => who(k)).filter((p) => !!p).slice(0, 3);
    await say("admin-manager", `That's the introductions done. ${lead.length ? `${lead.map((p) => p.name).join(", ")} will start on the first jobs we agreed; ` : ""}anything that needs your OK shows up under Needs you on your overview. Nothing is sent or published without it.`);
    finish("close");
  }
  showWho(undefined);
  await endActions(c.team);
  running = false;
}

async function submit(c: Awaited<ReturnType<typeof context>>): Promise<void> {
  await say("admin-manager", "Thank you. That's everything I need. Setting up your team now…");
  if (!c.live) {
    for (const s of SETUP_STEPS) { await say("admin-manager", `✓ ${s.title}`); }
    await say("admin-manager", "That's a preview of the steps. Sign up for real and each one actually runs, and every step can be undone.");
    finish("submitted");
    return;
  }
  const res = await api<SetupStatus & { run?: { status: string; steps: { title: string; status: string }[] }; error?: string }>("/setup", { body: { answers: saved.answers } });
  if (!res.ok || !res.data) {
    await say("admin-manager", `Setup couldn't start${res.data?.error ? ` (${res.data.error})` : ""}. Nothing was created. You can try again from the Setup form.`);
    return;
  }
  for (const s of res.data.run?.steps ?? []) await say("admin-manager", `${s.status === "done" ? "✓" : "•"} ${s.title}`);
  finish("submitted");
  window.dispatchEvent(new Event("maiz:setup-changed"));
  await say("admin-manager", res.data.state === "ready" ? "Done. Your team is set up. Each step can be undone from Setup if you ever want to start again." : "That didn't finish. I've kept your answers; open Setup to see where it stopped.");
}

async function access(p: Persona, c: Awaited<ReturnType<typeof context>>): Promise<void> {
  const options = connectOptions(p, c.catalogue.length ? c.catalogue : demoCatalogue(), c.owned);
  if (!options.length) return;
  const existing = c.connections.find((k) => options.some((o) => o.key === k.connectorKey) && k.status !== "disconnected");
  let pendingKey: string | null = null;
  try { pendingKey = sessionStorage.getItem("maiz.fd.pending"); sessionStorage.removeItem("maiz.fd.pending"); } catch { /* ignore */ }
  const failed = location.search.includes("connect=failed");
  if (failed && pendingKey) await say(p.key, `It looks like the approval on ${options.find((o) => o.key === pendingKey)?.name ?? "the app"} didn't go through. Nothing was connected. We can try again.`);
  else if (existing) {
    const item = options.find((o) => o.key === existing.connectorKey)!;
    await say(p.key, pendingKey ? `Welcome back. Let me see if ${item.name} really let me in.` : `I can see ${item.name} is already connected.`);
    await testConnection(p.key, item, existing);
    return;
  }
  await say(p.key, p.accessWhy ?? "");
  await offerApps(p.key, options);
}

/** Preview mode has no API to ask, so the picker shows the common ones. */
function demoCatalogue(): CatalogueItem[] {
  return [
    { key: "xero", name: "Xero", category: "accounting", summary: "", availability: "live", connect: "oauth", acceptsFiles: false },
    { key: "stripe", name: "Stripe", category: "payments", summary: "", availability: "live", connect: "api_key", acceptsFiles: false },
    { key: "square", name: "Square", category: "till", summary: "", availability: "live", connect: "oauth", acceptsFiles: true },
    { key: "brightpay", name: "BrightPay", category: "payroll", summary: "", availability: "file", connect: "file", acceptsFiles: true },
  ];
}

async function endActions(team: string[]): Promise<void> {
  const first = team[0] ? who(team[0]) : undefined;
  await reply<void>((host, done) => {
    chips(host, "What next?", [{ v: "home", label: "Go to my overview" }, ...(first ? [{ v: "desk", label: `See ${first.name}'s desk` }] : []), { v: "apps", label: "Connect more apps", quiet: true }],
      (v) => { done(undefined as void, ""); location.hash = v === "home" ? "#home" : v === "desk" ? `#desk/${first!.key}` : "#apps"; });
  });
}
