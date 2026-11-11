// Setup screen: Admin manager messages, the setup form and the step-by-step run.
// The questions, step names and message wording come from the backend's pure
// modules, so the demo and the real product say exactly the same thing.
// Until the API is wired in, the run itself is simulated in the browser.
import { formFor, validateAnswers, type Answers, type FormField } from "../../src/modules/admin-manager/form";
import { SETUP_STEPS, formInviteText, readyText, welcomeText } from "../../src/modules/admin-manager/messages";
import { getTemplate } from "../../src/modules/workforce/templates";
import { planSignup, readSignupAnswers } from "../../src/modules/onboarding/recommend";
import { toast } from "./common";
import { api, getToken } from "./api";

const TEAM = ["finance-manager", "marketing-manager", "business-consultant", "hr-manager", "compliance-manager"];
const KEY = "vn.setup";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Saved = { state: "awaiting_form" | "ready"; answers?: Answers; messages: { text: string; at: string }[] };

function load(): Saved | undefined {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") ?? undefined; } catch { return undefined; }
}
function store(s: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function fieldHtml(f: FormField): string {
  const id = `f-${f.key}`;
  const label = `<label for="${id}">${esc(f.label)}${f.required ? "" : ' <span class="hint">(optional)</span>'}</label>`;
  const help = f.help ? `<span class="hint">${esc(f.help)}</span>` : "";
  let input = "";
  switch (f.type) {
    case "longtext":
      input = `<textarea class="input" id="${id}" name="${f.key}" rows="3"></textarea>`;
      break;
    case "choice":
    case "month":
      input = `<select class="input" id="${id}" name="${f.key}"><option value="">Choose…</option>${(f.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
      break;
    case "yesno":
      input = `<select class="input" id="${id}" name="${f.key}"><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select>`;
      break;
    case "multi":
      return `<div class="field"><span class="label">${esc(f.label)} <span class="hint">(optional)</span></span><div class="chips" data-multi="${f.key}">${(f.options ?? [])
        .map((o) => `<button type="button" class="chip" aria-pressed="false">${esc(o)}</button>`)
        .join("")}</div>${help}</div>`;
    case "number":
      input = `<input class="input" id="${id}" name="${f.key}" inputmode="numeric">`;
      break;
    default:
      input = `<input class="input" id="${id}" name="${f.key}">`;
  }
  return `<div class="field">${label}${input}${help}<span class="err" data-err="${f.key}" hidden></span></div>`;
}

function readAnswers(form: HTMLFormElement, fields: FormField[]): Answers {
  const a: Answers = {};
  for (const f of fields) {
    if (f.type === "multi") {
      a[f.key] = Array.from(form.querySelectorAll<HTMLElement>(`[data-multi="${f.key}"] .chip[aria-pressed="true"]`)).map((c) => c.textContent ?? "");
      continue;
    }
    const el = form.elements.namedItem(f.key) as HTMLInputElement | null;
    const v = el?.value.trim() ?? "";
    if (f.type === "yesno") { if (v) a[f.key] = v === "yes"; } else if (v) a[f.key] = v;
  }
  return a;
}

type Prefill = { answers: Answers; source: Record<string, "you" | "guess"> };

/** Puts the answers worked out at signup into the form, each labelled with where it came from. Returns how many were filled. */
function fillAnswers(form: HTMLFormElement, fields: FormField[], prefill: Prefill | undefined): number {
  if (!prefill) return 0;
  let filled = 0;
  for (const f of fields) {
    const v = prefill.answers[f.key];
    if (v === undefined) continue;
    if (f.type === "multi") {
      if (!Array.isArray(v)) continue;
      form.querySelectorAll<HTMLElement>(`[data-multi="${f.key}"] .chip`).forEach((c) => c.setAttribute("aria-pressed", String(v.includes(c.textContent ?? ""))));
    } else {
      const el = form.elements.namedItem(f.key) as HTMLInputElement | null;
      if (!el) continue;
      el.value = typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
      const note = document.createElement("span");
      note.className = "hint";
      note.textContent = prefill.source[f.key] === "guess" ? "Our guess. Change it if it is wrong." : "From your signup answers.";
      el.after(note);
    }
    filled++;
  }
  return filled;
}

/** The demo (no API) works the same plan out in the browser from what was typed at signup. */
function demoPrefill(): Prefill | undefined {
  try {
    const p = JSON.parse(localStorage.getItem("vn.profile") ?? "{}");
    if (typeof p.biz !== "string" || !p.biz) return undefined;
    return planSignup(readSignupAnswers({ businessName: p.biz, sector: p.sector, needs: p.needs, apps: p.apps, size: p.size, country: p.country, sells: p.sells })).prefill;
  } catch { return undefined; }
}

const countText = (fields: FormField[], filled: number): string =>
  `${fields.length} questions · ${fields.filter((f) => f.required).length} required${filled ? ` · ${filled} already filled in from signup` : ""}`;

type LiveStatus = {
  state: "awaiting_form" | "setting_up" | "ready" | "needs_attention";
  contact: "dashboard" | "slack" | "teams";
  form: FormField[];
  prefill?: Prefill;
  runs: { status: string; steps: { key: string; title: string; status: string }[] }[];
  messages: { text: string; at: string }[];
};

/** Real mode: the Admin manager on the server sends the messages, owns the form and runs the steps. */
async function initSetupLive(): Promise<boolean> {
  if (!getToken()) return false;
  const r = await api<LiveStatus>("/setup");
  if (!r.ok || !r.data) return false;
  let st = r.data;
  const form = $<HTMLFormElement>("setup-form");
  const fields = st.form;
  const groups = new Map<string, FormField[]>();
  for (const f of fields) groups.set(f.for, [...(groups.get(f.for) ?? []), f]);
  form.innerHTML =
    [...groups].map(([who, fs]) => `<fieldset class="sf-group"><legend>${who === "all" ? "About your business" : `For your ${esc(getTemplate(who)?.title ?? who)}`}</legend>${fs.map(fieldHtml).join("")}</fieldset>`).join("") +
    `<div class="ob-actions"><button class="btn btn-primary" type="submit">Send to Admin manager</button></div>`;
  $("setup-count").textContent = countText(fields, fillAnswers(form, fields, st.prefill));
  form.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-multi] .chip");
    if (chip) chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
  });
  const time = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const draw = (lastRun?: LiveStatus["runs"][number]) => {
    $("setup-via").textContent = st.contact === "slack" ? "Also sent to you in Slack" : "In your dashboard";
    $("am-msgs").innerHTML = (st.messages as unknown as { text: string; at: string }[])
      .map((m) => `<div class="msg"><span class="av av-sm av-tl">AM</span><div><b>Admin manager</b><span class="t">${esc(time(m.at))}</span><br>${esc(m.text).replace(/\n/g, "<br>")}</div></div>`)
      .join("");
    const ready = st.state === "ready";
    $("setup-form-panel").toggleAttribute("hidden", ready || st.state === "setting_up");
    $("setup-need").toggleAttribute("hidden", ready);
    $("setup-badge").toggleAttribute("hidden", ready);
    const run = lastRun ?? st.runs.at(-1);
    $("setup-run").toggleAttribute("hidden", !run || st.state === "awaiting_form");
    if (run) {
      $("setup-steps").innerHTML = run.steps.map((x) => `<li class="${x.status === "done" ? "done" : x.status === "running" ? "run" : x.status === "undone" ? "undone" : ""}"><span class="pdot"></span>${esc(x.title)}${x.status === "undone" ? ' <span class="hint">undone</span>' : x.status === "failed" ? ' <span class="hint">stopped here</span>' : ""}</li>`).join("");
    }
    $("setup-state").textContent = ready ? "Ready" : st.state === "needs_attention" ? "Needs our help" : "Waiting for your answers";
    $("setup-undo").toggleAttribute("hidden", !ready);
  };
  const apply = (d: Partial<LiveStatus> & { run?: LiveStatus["runs"][number] }) => { st = { ...st, ...d } as LiveStatus; draw(d.run); };
  draw();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = validateAnswers(fields, readAnswers(form, fields));
    form.querySelectorAll<HTMLElement>("[data-err]").forEach((el) => { const msg = v.errors[el.dataset.err!]; el.textContent = msg ?? ""; el.toggleAttribute("hidden", !msg); });
    if (!v.ok) { toast("A couple of answers need a look"); return; }
    $("setup-run").removeAttribute("hidden");
    $("setup-run-h").textContent = "Setting up your team";
    const res = await api<LiveStatus & { run: LiveStatus["runs"][number] }>("/setup", { body: { answers: v.clean } });
    if (!res.ok || !res.data) { toast("Setup could not start. Try again."); return; }
    apply(res.data);
  });
  $("setup-undo").addEventListener("click", async () => {
    $("setup-run-h").textContent = "Undoing setup";
    const res = await api<LiveStatus & { run: LiveStatus["runs"][number] }>("/setup/rollback", { body: {} });
    if (!res.ok || !res.data) { toast("Could not undo. Try again."); return; }
    apply(res.data);
  });
  return true;
}

export async function initSetup(biz: string, contact: "dashboard" | "slack"): Promise<void> {
  if (await initSetupLive()) return;
  initSetupDemo(biz, contact);
}

function initSetupDemo(biz: string, contact: "dashboard" | "slack"): void {
  const fields = formFor(TEAM);
  const form = $<HTMLFormElement>("setup-form");
  let saved = load() ?? {
    state: "awaiting_form",
    messages: [
      { text: welcomeText(biz, TEAM, 7), at: "09:00" },
      { text: formInviteText(TEAM, "shared"), at: "09:00" },
    ],
  };
  store(saved);
  $("setup-via").textContent = contact === "slack" ? "Also sent to you in Slack" : "In your dashboard";

  // Group questions: shared ones first, then one group per employee.
  const groups = new Map<string, FormField[]>();
  for (const f of fields) groups.set(f.for, [...(groups.get(f.for) ?? []), f]);
  form.innerHTML =
    [...groups]
      .map(([who, fs]) => `<fieldset class="sf-group"><legend>${who === "all" ? "About your business" : `For your ${esc(getTemplate(who)?.title ?? who)}`}</legend>${fs.map(fieldHtml).join("")}</fieldset>`)
      .join("") + `<div class="ob-actions"><button class="btn btn-primary" type="submit">Send to Admin manager</button></div>`;
  $("setup-count").textContent = countText(fields, fillAnswers(form, fields, demoPrefill()));

  form.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-multi] .chip");
    if (chip) chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
  });

  const renderMessages = () => {
    $("am-msgs").innerHTML = saved.messages
      .map((m) => `<div class="msg"><span class="av av-sm av-tl">AM</span><div><b>Admin manager</b><span class="t">${esc(m.at)}</span><br>${esc(m.text).replace(/\n/g, "<br>")}</div></div>`)
      .join("");
  };
  const say = (text: string) => {
    const d = new Date();
    saved.messages.push({ text, at: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` });
    store(saved);
    renderMessages();
  };
  const setReady = (ready: boolean) => {
    $("setup-form-panel").toggleAttribute("hidden", ready);
    $("setup-need").toggleAttribute("hidden", ready);
    $("setup-badge").toggleAttribute("hidden", ready);
  };
  const drawSteps = (status: (i: number) => "" | "run" | "done" | "undone") => {
    $("setup-steps").innerHTML = SETUP_STEPS.map((s, i) => `<li class="${status(i)}"><span class="pdot"></span>${esc(s.title)}${status(i) === "undone" ? ' <span class="hint">undone</span>' : ""}</li>`).join("");
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = validateAnswers(fields, readAnswers(form, fields));
    form.querySelectorAll<HTMLElement>("[data-err]").forEach((el) => {
      const msg = v.errors[el.dataset.err!];
      el.textContent = msg ?? "";
      el.toggleAttribute("hidden", !msg);
    });
    if (!v.ok) { toast("A couple of answers need a look"); return; }
    saved.answers = v.clean;
    say("Thanks, got your answers. Setting up your team now.");
    $("setup-form-panel").setAttribute("hidden", "");
    $("setup-run").removeAttribute("hidden");
    $("setup-run-h").textContent = "Setting up your team";
    $("setup-undo").setAttribute("hidden", "");
    let i = 0;
    const tick = () => {
      drawSteps((k) => (k < i ? "done" : k === i ? "run" : ""));
      if (i++ < SETUP_STEPS.length) { window.setTimeout(tick, 650); return; }
      saved.state = "ready";
      say(readyText(TEAM));
      $("setup-state").textContent = "Ready";
      $("setup-undo").removeAttribute("hidden");
      setReady(true);
    };
    tick();
  });

  $("setup-undo").addEventListener("click", () => {
    $("setup-undo").setAttribute("hidden", "");
    $("setup-run-h").textContent = "Undoing setup";
    let i = SETUP_STEPS.length - 1;
    const tick = () => {
      drawSteps((k) => (k >= i + 1 ? "undone" : "done"));
      if (i-- >= 0) { window.setTimeout(tick, 400); return; }
      saved.state = "awaiting_form";
      say("Done: I undid the setup. Your storage, models and training are removed and your profile is back as it was. Send the form again whenever you're ready.");
      $("setup-state").textContent = "Undone";
      setReady(false);
    };
    tick();
  });

  renderMessages();
  if (saved.state === "ready") {
    $("setup-run").removeAttribute("hidden");
    drawSteps(() => "done");
    $("setup-state").textContent = "Ready";
    $("setup-undo").removeAttribute("hidden");
  }
  setReady(saved.state === "ready");
}
