// "Your own AI tools" on the Apps screen: the owner gives Claude, ChatGPT, Zapier, Make or n8n a key so it can hand
// work to chosen employees, inside limits the owner sets. A key and its signing secret are shown once, held only in
// this page's memory, and gone when the box is closed. Names, briefs and results come from outside, so all are escaped.
import { api, getToken } from "./api";
import { toast } from "./common";
import { isBusy, keepFocus, setBusy } from "./keep-focus";
import { answer, draftOf, planHtml, profileHtml, restart, startPlan, type Draft, type PlanState, type Profile } from "./agents-plan";

interface Limits { dailyPercent: number; perJobPercent: number; jobsPerHour: number }
interface Connection {
  id: string; name: string; tool: string; status: "active" | "paused" | "expired"; employees: { key: string; title: string }[]; needsApproval: boolean; limits: Limits;
  energy: { dailyCeiling: number; perJobCap: number; usedToday: number; leftToday: number }; jobsThisHour: number; waiting: number; webhookUrl: string | null;
  keyPrefix: string; keyExpiresAt: string; lastUsedAt: string | null; profile: Profile | null;
}
interface Job { id: string; status: string; reason: string | null; connectionName: string; employeeTitle: string; brief: string; estimate: number; energyUsed: number | null; createdAt: string; note: string | null }
interface Overview { connections: Connection[]; jobs: Job[]; limits: { defaults: Limits; maximums: Limits; maxConnections: number }; allowedEmployees: { key: string; title: string; allowed: boolean; reason?: string }[]; canManage: boolean }
interface Secrets { name: string; key: string; signingSecret?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (iso: string | null) => { const d = iso ? new Date(iso) : undefined; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const num = (n: number) => n.toLocaleString("en-GB");
const TOOLS: [string, string][] = [["claude", "Claude"], ["chatgpt", "ChatGPT"], ["zapier", "Zapier"], ["make", "Make"], ["n8n", "n8n"], ["other", "Something else"]];
const toolName = (t: string) => TOOLS.find(([k]) => k === t)?.[1] ?? "Another tool";
const STATUS: Record<string, [tone: string, words: string]> = { queued: ["info", "Queued"], working: ["info", "Working"], waiting_for_owner: ["warn", "Waiting for you"], done: ["good", "Done"], refused: ["", "Refused"], failed: ["crit", "Failed"] };
const WHY: Record<string, string> = {
  needs_approval: "You asked to approve each job from this tool.", over_job_limit: "It may use more energy than the limit you set for one job.",
  daily_limit: "The tool reached its energy limit for today.", no_energy: "Your team had no energy left.", owner_refused: "You refused it.",
  approval_expired: "Nobody approved it within 7 days.", connection_off: "The connection was paused or removed.", employee_not_allowed: "It asked for an employee you did not allow.",
  employee_not_found: "It asked for an employee who is not on your team.", failed: "The employee could not finish it.", interrupted: "It was interrupted and stopped.",
};

let view: Overview | undefined;
let form: "" | "new" | string = "";
let secrets: Secrets | undefined;
let removing = "";
/** The Admin manager's interview while it is open, and a proposal the owner chose to change by hand. */
let planning: PlanState | undefined;
let draft: Draft | undefined;
let wired = false;
const APPROVED_RECHECK_MS = 6_000;
const body = (): HTMLElement => document.getElementById("agents-body")!;

function formHtml(v: Overview, c?: Connection, d?: Draft): string {
  const lim = d?.limits ?? c?.limits ?? v.limits.defaults;
  const max = v.limits.maximums;
  const picked = new Set(d?.employees ?? c?.employees.map((e) => e.key) ?? []);
  const name = d?.name ?? c?.name ?? "";
  const tool = d?.tool ?? c?.tool ?? "claude";
  const ask = d?.needsApproval ?? c?.needsApproval;
  const ticks = v.allowedEmployees.filter((e) => e.allowed).map((e) => `<label class="sf-check"><input type="checkbox" name="emp" value="${esc(e.key)}"${picked.has(e.key) ? " checked" : ""}> ${esc(e.title)}</label>`).join("");
  const never = v.allowedEmployees.filter((e) => !e.allowed).map((e) => e.title);
  return `<form class="ag-form" id="ag-form" data-id="${esc(c?.id ?? "")}" novalidate>
    <h3>${d ? "Check the suggestion, then save it" : c ? `Change ${esc(c.name)}` : "Connect a tool"}</h3>
    <div class="ag-two">
      <div class="field"><label for="ag-name">Name, so you recognise it</label><input class="input" id="ag-name" maxlength="60" autocomplete="off" value="${esc(name)}" placeholder="For example: Website chatbot"></div>
      <div class="field"><label for="ag-tool">What is it?</label><select class="input" id="ag-tool">${TOOLS.map(([k, l]) => `<option value="${k}"${tool === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    </div>
    <fieldset class="ag-set"><legend class="label">Which employees may it give work to?</legend>${ticks || '<p class="small muted">Nobody on your team can take outside work yet.</p>'}
      ${never.length ? `<p class="small muted">Never available to outside tools: ${esc(never.join(", "))}.</p>` : ""}</fieldset>
    <label class="sf-check"><input type="checkbox" id="ag-ask"${ask ? " checked" : ""}> Ask me before each job runs</label>
    <fieldset class="ag-set"><legend class="label">Limits, as a share of your team's weekly energy</legend>
      <div class="ag-three">
        <div class="field"><label for="ag-day">Most in one day (%)</label><input class="input" id="ag-day" type="number" inputmode="numeric" min="1" max="${max.dailyPercent}" step="1" value="${lim.dailyPercent}"></div>
        <div class="field"><label for="ag-job">Most for one job (%)</label><input class="input" id="ag-job" type="number" inputmode="numeric" min="1" max="${max.perJobPercent}" step="1" value="${lim.perJobPercent}"></div>
        <div class="field"><label for="ag-hour">Jobs an hour</label><input class="input" id="ag-hour" type="number" inputmode="numeric" min="1" max="${max.jobsPerHour}" step="1" value="${lim.jobsPerHour}"></div>
      </div>
      <p class="small muted">A job that may go over the limit for one job waits for your OK instead of running. The most you can allow is ${max.dailyPercent}% a day and ${max.perJobPercent}% a job.</p></fieldset>
    <div class="field"><label for="ag-hook">Where to send the answer (optional)</label><input class="input" id="ag-hook" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="500" value="${esc(c?.webhookUrl ?? "")}" placeholder="https://…"><span class="small muted">A web address your tool gives you for incoming messages. Leave it empty and the tool asks for the answer itself.</span></div>
    <p class="small status crit wrap" id="ag-err" role="alert" hidden></p>
    <div class="acts"><button class="btn btn-primary btn-sm" type="submit">${c ? "Save changes" : "Create the key"}</button><button class="btn btn-ghost btn-sm" type="button" data-ag="form-close">Cancel</button></div>
  </form>`;
}

function secretsHtml(s: Secrets): string {
  const row = (label: string, id: string) => `<div class="ag-secret"><span class="label">${label}</span><code id="${id}" class="mono"></code><button class="btn btn-sm btn-ghost" type="button" data-ag="copy" data-from="${id}">Copy</button></div>`;
  return `<div class="ag-secrets" role="status"><h3>Copy ${s.signingSecret ? "these" : "this"} now for ${esc(s.name)}</h3>
    <p class="small">For your safety ${s.signingSecret ? "they are" : "it is"} shown only this once. Paste ${s.signingSecret ? "them" : "it"} into your tool, then press Done.</p>
    ${row("Key", "ag-key")}${s.signingSecret ? row("Signing secret, to check answers really came from MAIZ", "ag-sign") : ""}
    <details class="ag-how"><summary>How your tool sends a job</summary>
      <p class="small">Send a POST request to <code class="mono">${esc(location.origin)}/api/agent/v1/jobs</code> with the header <code class="mono">Authorization: Bearer</code> followed by the key, and a JSON body like this:</p>
      <pre class="mono ag-pre">{ "employee": "marketing-manager", "brief": "Write three posts about our autumn menu" }</pre>
      <p class="small">The reply carries a job id. Ask for <code class="mono">/api/agent/v1/jobs/</code> plus that id to read the answer, or give an address above and MAIZ sends it to you. In Zapier, Make or n8n this is one "Webhooks: POST" step.</p></details>
    <div class="acts"><button class="btn btn-primary btn-sm" type="button" data-ag="secrets-done">Done, I have copied ${s.signingSecret ? "them" : "it"}</button></div></div>`;
}

function connectionHtml(c: Connection, canManage: boolean): string {
  const tone = c.status === "active" ? "good" : c.status === "expired" ? "crit" : "";
  const words = c.status === "active" ? "On" : c.status === "expired" ? "Key expired" : "Paused";
  const acts = canManage ? `<div class="acts">
      <button class="btn btn-sm btn-ghost" type="button" data-ag="edit">Change</button>
      <button class="btn btn-sm btn-ghost" type="button" data-ag="plan-existing">${c.profile ? "Plan again with the Admin manager" : "Plan with the Admin manager"}</button>
      <button class="btn btn-sm btn-ghost" type="button" data-ag="${c.status === "paused" ? "resume" : "pause"}">${c.status === "paused" ? "Switch on" : "Pause"}</button>
      <button class="btn btn-sm btn-ghost" type="button" data-ag="rotate">New key</button>
      ${c.webhookUrl ? '<button class="btn btn-sm btn-ghost" type="button" data-ag="test">Send a test</button>' : ""}
      <button class="btn btn-sm btn-ghost" type="button" data-ag="remove">Remove</button></div>` : "";
  const sure = removing === c.id ? `<div class="acts ag-sure"><span class="small">Remove ${esc(c.name)}? Its key stops working at once.</span><button class="btn btn-sm btn-primary" type="button" data-ag="remove-yes">Yes, remove</button><button class="btn btn-sm btn-ghost" type="button" data-ag="remove-no">Keep it</button></div>` : "";
  return `<li class="ag-conn" data-id="${esc(c.id)}">
    <div class="ag-conn-h"><b>${esc(c.name)}</b><span class="small muted">${esc(toolName(c.tool))}</span><span class="status ${tone}"><span class="dot"></span>${words}</span></div>
    <p class="small">May give work to: ${esc(c.employees.map((e) => e.title).join(", ") || "nobody yet")}.${c.needsApproval ? " You approve each job first." : ""}</p>
    <p class="small muted ag-nums">Used ${num(c.energy.usedToday)} of ${num(c.energy.dailyCeiling)} energy today · up to ${num(c.energy.perJobCap)} a job · ${c.jobsThisHour} of ${c.limits.jobsPerHour} jobs this hour</p>
    <p class="small muted">Key starts <span class="mono">${esc(c.keyPrefix)}</span>, works until ${esc(day(c.keyExpiresAt))}. ${c.lastUsedAt ? `Last used ${esc(day(c.lastUsedAt))}.` : "Not used yet."}</p>
    ${profileHtml(c.profile)}
    ${acts}${sure}${form === c.id && view ? formHtml(view, c, draft) : ""}</li>`;
}

function jobHtml(j: Job, canManage: boolean): string {
  const [tone, words] = STATUS[j.status] ?? ["", j.status];
  const waiting = j.status === "waiting_for_owner";
  const why = j.reason ? WHY[j.reason] ?? "" : "";
  const used = j.energyUsed !== null ? `used ${num(j.energyUsed)} energy` : waiting ? `may use about ${num(j.estimate)} energy` : "";
  return `<li class="ag-job" data-job="${esc(j.id)}"><div class="ag-conn-h"><b>${esc(j.employeeTitle)}</b><span class="small muted">from ${esc(j.connectionName)} · ${esc(day(j.createdAt))}${used ? ` · ${used}` : ""}</span><span class="status ${tone}"><span class="dot"></span>${esc(words)}</span></div>
    <p class="small">${esc(clip(j.brief, 240))}</p>${why && j.status !== "done" ? `<p class="small muted">${esc(why)}</p>` : ""}
    ${waiting && canManage ? '<div class="acts"><button class="btn btn-sm btn-primary" type="button" data-ag="approve">Let it run</button><button class="btn btn-sm btn-ghost" type="button" data-ag="refuse">Refuse</button></div>' : ""}</li>`;
}

function paint(): void {
  const el = body();
  keepFocus(el, "[data-id], [data-job]", "data-ag", () => draw(el), document.getElementById("agents-h"));
}

function draw(el: HTMLElement): void {
  if (!view) {
    el.innerHTML = `<p class="small muted">${getToken() ? "This could not be loaded just now. Open the page again in a moment." : "Log in to connect a tool. Nothing can reach your team without a key that you create here."}</p>`;
    return;
  }
  const v = view;
  const waiting = v.jobs.filter((j) => j.status === "waiting_for_owner");
  const recent = v.jobs.filter((j) => j.status !== "waiting_for_owner").slice(0, 8);
  const full = v.connections.length >= v.limits.maxConnections;
  el.innerHTML = `${secrets ? secretsHtml(secrets) : ""}
    ${waiting.length ? `<h3 class="ag-h">Waiting for your OK</h3><ul class="ag-list">${waiting.map((j) => jobHtml(j, v.canManage)).join("")}</ul>` : ""}
    ${v.connections.length ? `<ul class="ag-list">${v.connections.map((c) => connectionHtml(c, v.canManage)).join("")}</ul>` : '<p class="small muted">No tools connected yet.</p>'}
    ${planning ? planHtml(planning, location.origin) : ""}
    ${form === "new" ? formHtml(v, undefined, draft) : planning ? "" : v.canManage ? `<div class="acts"><button class="btn btn-primary btn-sm" type="button" data-ag="plan-new"${full ? " disabled" : ""}>Connect a tool with the Admin manager</button><button class="btn btn-ghost btn-sm" type="button" data-ag="new"${full ? " disabled" : ""}>Set one up myself</button>${full ? `<span class="small muted">You have the most connections allowed (${v.limits.maxConnections}).</span>` : ""}</div>` : '<p class="small muted">Only the account owner can connect or change a tool.</p>'}
    ${recent.length ? `<h3 class="ag-h">Latest jobs from your tools</h3><ul class="ag-list">${recent.map((j) => jobHtml(j, false)).join("")}</ul>` : ""}`;
  // Secrets go in as text, never as markup, and are not kept anywhere else.
  if (secrets) {
    document.getElementById("ag-key")!.textContent = secrets.key;
    const sign = document.getElementById("ag-sign");
    if (sign && secrets.signingSecret) sign.textContent = secrets.signingSecret;
  }
}

async function load(): Promise<void> {
  const r = getToken() ? await api<Overview>("/agents") : undefined;
  view = r?.ok ? r.data : undefined;
  paint();
}

async function act(path: string, payload: unknown, done: string): Promise<boolean> {
  const r = await api<{ error?: string; key?: string; signingSecret?: string; connection?: Connection; delivered?: boolean }>(path, { body: payload });
  // On a failure the list is drawn again, so the button that was pressed is usable again.
  if (!r.ok) { toast(r.data?.error ?? "That did not work just now. Please try again."); paint(); return false; }
  if (r.data?.key && r.data.connection) secrets = { name: r.data.connection.name, key: r.data.key, ...(r.data.signingSecret ? { signingSecret: r.data.signingSecret } : {}) };
  if (path.endsWith("/test")) toast(r.data?.delivered ? "Test sent, and your tool answered." : "The test was sent but your tool did not accept it. Check the address.");
  else if (done) toast(done);
  await load();
  return true;
}

/** Where keyboard focus goes after the interview moves on: the new question, the typed answer box, or the proposal. */
function focusPlan(): void {
  const el = document.querySelector<HTMLElement>("#agp-note, #agp-h, .agp .fd-opts .chip");
  el?.focus({ preventScroll: false });
}

/** Makes (or, for a connection planned again, changes) a connection and shows the key once. Returns false with a reason on failure. */
async function save(id: string, payload: object): Promise<{ ok: boolean; error?: string }> {
  const r = await api<{ error?: string; key?: string; signingSecret?: string; connection?: Connection }>(id ? `/agents/${encodeURIComponent(id)}` : "/agents", { body: payload });
  if (!r.ok || !r.data?.connection) return { ok: false, error: r.data?.error ?? "That could not be saved just now. Please try again." };
  if (r.data.key) secrets = { name: r.data.connection.name, key: r.data.key, ...(r.data.signingSecret ? { signingSecret: r.data.signingSecret } : {}) };
  form = "";
  draft = undefined;
  toast(id ? "Saved" : "Key created. Copy it now.");
  await load();
  if (secrets) document.querySelector(".ag-secrets")?.scrollIntoView({ block: "center", behavior: "smooth" });
  return { ok: true };
}

/** Everything the interview's buttons do. Returns true when the press was one of its own. */
async function onPlan(b: HTMLButtonElement, a: string): Promise<boolean> {
  if (!a.startsWith("plan-")) return false;
  if (a === "plan-new" || a === "plan-existing") {
    setBusy(b, true);
    const target = a === "plan-existing" ? b.closest<HTMLElement>("[data-id]")?.dataset.id ?? "" : "";
    const started = await startPlan(target);
    setBusy(b, false);
    if (!started) { toast("The questions could not be loaded just now. Please try again."); return true; }
    planning = started; form = ""; draft = undefined; removing = "";
    paint(); focusPlan();
    return true;
  }
  if (!planning) return true;
  if (a === "plan-cancel") { planning = undefined; paint(); return true; }
  if (a === "plan-skip") { planning = undefined; form = "new"; draft = undefined; paint(); document.getElementById("ag-name")?.focus(); return true; }
  if (a === "plan-restart") { planning = restart(planning); paint(); focusPlan(); return true; }
  if (a === "plan-back") { planning = { ...planning, typing: false }; paint(); focusPlan(); return true; }
  if (a === "plan-pick") {
    const last = Object.keys(planning.answers).length + 1 >= planning.questions.length;
    const typed = planning.questions.find((q) => q.id === b.dataset.q)?.options.find((o) => o.value === b.dataset.v)?.typed;
    if (last && !typed) { planning = { ...planning, working: true }; paint(); }
    planning = await answer(planning, b.dataset.q ?? "", b.dataset.v ?? "");
    paint(); focusPlan();
    return true;
  }
  if (a === "plan-change") {
    draft = draftOf(planning);
    form = planning.target || "new";
    planning = undefined;
    paint(); document.getElementById("ag-name")?.focus();
    return true;
  }
  if (a === "plan-accept") {
    const d = draftOf(planning);
    if (!d) return true;
    setBusy(b, true);
    const done = await save(planning.target, d);
    setBusy(b, false);
    planning = done.ok ? undefined : { ...planning, error: done.error ?? "" };
    paint();
    return true;
  }
  return true;
}

async function onClick(ev: Event): Promise<void> {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-ag]");
  if (!b || b.disabled || isBusy(b)) return;
  const a = b.dataset.ag!;
  if (await onPlan(b, a)) return;
  if (a === "copy") {
    const text = document.getElementById(b.dataset.from ?? "")?.textContent ?? "";
    try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Select the text and copy it by hand."); }
    return;
  }
  if (a === "secrets-done") { secrets = undefined; paint(); return; }
  if (a === "new") { form = "new"; removing = ""; draft = undefined; paint(); document.getElementById("ag-name")?.focus(); return; }
  if (a === "form-close") { form = ""; draft = undefined; paint(); return; }
  const jobId = b.closest<HTMLElement>("[data-job]")?.dataset.job;
  if (jobId) {
    setBusy(b, true);
    const ok = await act(`/agents/jobs/${encodeURIComponent(jobId)}/${a === "approve" ? "approve" : "refuse"}`, {}, a === "approve" ? "Approved. The employee is starting on it." : "Refused. The tool has been told.");
    // The employee works after the reply, so the list is read once more to show the finished job.
    if (ok && a === "approve") setTimeout(() => { if (!form && !secrets && !removing) void load(); }, APPROVED_RECHECK_MS);
    return;
  }
  const id = b.closest<HTMLElement>("[data-id]")?.dataset.id;
  if (!id) return;
  if (a === "edit") { form = form === id ? "" : id; removing = ""; paint(); return; }
  if (a === "remove") { removing = removing === id ? "" : id; form = ""; paint(); return; }
  if (a === "remove-no") { removing = ""; paint(); return; }
  setBusy(b, true);
  const at = `/agents/${encodeURIComponent(id)}`;
  if (a === "remove-yes") { removing = ""; await act(`${at}/remove`, {}, "Removed. Its key no longer works."); }
  else if (a === "pause") await act(`${at}/pause`, {}, "Paused. Its key is refused until you switch it on again.");
  else if (a === "resume") await act(`${at}/resume`, {}, "Switched on");
  else if (a === "rotate") await act(`${at}/rotate`, {}, "New key made. The old one has stopped working.");
  else if (a === "test") await act(`${at}/test`, {}, "");
}

async function onSubmit(ev: Event): Promise<void> {
  const f = ev.target as HTMLFormElement;
  if (f.dataset.planTyped && planning) {
    ev.preventDefault();
    const words = (document.getElementById("agp-note") as HTMLInputElement).value.trim();
    if (!words) { planning = { ...planning, error: "Say what it does in a few words first." }; paint(); document.getElementById("agp-note")?.focus(); return; }
    const last = Object.keys(planning.answers).length + 1 >= planning.questions.length;
    if (last) { planning = { ...planning, working: true }; paint(); }
    planning = await answer({ ...planning, error: "" }, f.dataset.planTyped, "custom", words);
    paint(); focusPlan();
    return;
  }
  if (f.id !== "ag-form") return;
  ev.preventDefault();
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
  const err = document.getElementById("ag-err")!;
  const fail = (message: string) => { err.hidden = false; err.textContent = message; };
  const employees = Array.from(f.querySelectorAll<HTMLInputElement>('input[name="emp"]:checked')).map((i) => i.value);
  if (!val("ag-name")) { fail("Give it a name first."); document.getElementById("ag-name")?.focus(); return; }
  if (!employees.length) { fail("Tick at least one employee it may give work to."); return; }
  const id = f.dataset.id ?? "";
  const hook = val("ag-hook");
  const payload = {
    name: val("ag-name"), tool: val("ag-tool"), employees, needsApproval: (document.getElementById("ag-ask") as HTMLInputElement).checked,
    limits: { dailyPercent: Number(val("ag-day")), perJobPercent: Number(val("ag-job")), jobsPerHour: Number(val("ag-hour")) },
    ...(hook ? { webhookUrl: hook } : id ? { webhookUrl: null } : {}),
    // A suggestion the owner changed keeps what the interview learned about the tool.
    ...(draft ? { profile: draft.profile } : {}),
  };
  const saved = await save(id, payload);
  if (!saved.ok) fail(saved.error ?? "That could not be saved just now. Please try again.");
}

/** Called each time the Apps screen is opened. */
export function showAgents(): void {
  if (!document.getElementById("agents-body")) return;
  if (!wired) {
    wired = true;
    body().addEventListener("click", (e) => void onClick(e));
    body().addEventListener("submit", (e) => void onSubmit(e));
  }
  // An open form or a key that has not been copied yet is not thrown away by coming back to the screen.
  if (form || secrets || planning) return;
  void load();
}
