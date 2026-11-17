// The Admin manager's planning interview for "Your own AI tools": a few plain questions with tap answers, then a
// proposed set-up the owner can accept, change or start again. It is scripted (no AI model is asked), so it works
// at once and uses no energy. Nothing is created until the owner accepts. The answers and the proposal come from the
// server, which checks them again when the connection is made; everything shown is escaped.
import { api } from "./api";

export interface PlanOption { value: string; label: string; typed?: string }
export interface PlanQuestion { id: "purpose" | "tool" | "volume"; ask: string; options: PlanOption[] }
interface Limits { dailyPercent: number; perJobPercent: number; jobsPerHour: number }
export interface Profile { purpose: string; purposeNote?: string; volume: string; examples: { employee: string; brief: string }[]; plannedAt?: string }
export interface Proposal {
  says: string; name: string; tool: string; employees: { key: string; title: string }[]; limits: Limits; needsApproval: boolean;
  examples: { employee: string; brief: string }[]; estimate?: { perJob: number; jobsADay: number; perDay: number; percentOfPoolADay: number };
  notes: string[]; connect: string[]; profile: Profile;
}
/** What is sent to make or change a connection from an accepted (or changed) proposal. */
export interface Draft { name: string; tool: string; employees: string[]; needsApproval: boolean; limits: Limits; profile: Profile }

/** One run of the interview. `target` is the connection being planned again, or empty for a new one. */
export interface PlanState {
  target: string;
  questions: PlanQuestion[];
  answers: Record<string, string>;
  /** The owner's own words for "Something else", when the interview is waiting for them. */
  typing: boolean;
  note: string;
  proposal?: Proposal;
  working: boolean;
  error: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: number): string => n.toLocaleString("en-GB");
const WHAT_PURPOSE: Record<string, string> = { "customer-service": "customer service", "order-tracking": "order tracking", bookings: "bookings", reports: "reports", custom: "something else" };
const MAX_TYPED = 200;
const bubble = (html: string, mine = false): string => mine
  ? `<div class="fd-msg mine"><div class="fd-bub"><span class="sr-only">You: </span>${html}</div></div>`
  : `<div class="fd-msg"><span class="av av-tl" aria-hidden="true">AM</span><div class="fd-bub"><b class="fd-name">Admin manager</b>${html}</div></div>`;

/** Fetches the questions and starts the interview. Undefined when they could not be loaded. */
export async function startPlan(target: string): Promise<PlanState | undefined> {
  const r = await api<{ questions?: PlanQuestion[] }>("/agents/plan");
  if (!r.ok || !r.data?.questions?.length) return undefined;
  return { target, questions: r.data.questions, answers: {}, typing: false, note: "", working: false, error: "" };
}

const nextQuestion = (s: PlanState): PlanQuestion | undefined => s.questions.find((q) => s.answers[q.id] === undefined);

/** One answer. "Something else" first asks for a few words; the last answer asks the server for the proposal. */
export async function answer(s: PlanState, id: string, value: string, typed = ""): Promise<PlanState> {
  const q = s.questions.find((x) => x.id === id);
  const option = q?.options.find((o) => o.value === value);
  if (!q || !option) return s;
  if (option.typed && !typed.trim()) return { ...s, typing: true, error: "" };
  const next: PlanState = { ...s, answers: { ...s.answers, [id]: value }, typing: false, note: option.typed ? typed.trim().slice(0, MAX_TYPED) : s.note, error: "" };
  if (nextQuestion(next)) return next;
  const body = { ...next.answers, ...(next.note ? { purposeNote: next.note } : {}) };
  const r = await api<{ proposal?: Proposal; error?: string }>("/agents/plan", { body });
  if (!r.ok || !r.data?.proposal) {
    const { [id]: _undone, ...rest } = next.answers;
    return { ...next, answers: rest, working: false, error: r.data?.error ?? "I could not put a suggestion together just now. Please try again." };
  }
  return { ...next, proposal: r.data.proposal, working: false };
}

/** The proposal as it would be saved. The server checks every part of it again. */
export function draftOf(s: PlanState): Draft | undefined {
  const p = s.proposal;
  return p ? { name: p.name, tool: p.tool, employees: p.employees.map((e) => e.key), needsApproval: p.needsApproval, limits: p.limits, profile: p.profile } : undefined;
}

/** Back to the first question, with nothing answered. */
export const restart = (s: PlanState): PlanState => ({ ...s, answers: {}, typing: false, note: "", proposal: undefined, working: false, error: "" });

function askedHtml(s: PlanState): string {
  return s.questions.filter((q) => s.answers[q.id] !== undefined).map((q) => {
    const o = q.options.find((x) => x.value === s.answers[q.id]);
    const said = o?.typed && s.note ? `${o.label}: ${s.note}` : o?.label ?? "";
    return `${bubble(esc(q.ask))}${bubble(esc(said), true)}`;
  }).join("");
}

function questionHtml(s: PlanState, q: PlanQuestion): string {
  const typed = q.options.find((o) => o.typed);
  if (s.typing && typed) {
    return `${bubble(esc(q.ask))}<form class="agp-typed" data-plan-typed="${esc(q.id)}"><div class="field"><label for="agp-note">${esc(typed.typed ?? "Say it in a few words")}</label><input class="input" id="agp-note" maxlength="${MAX_TYPED}" autocomplete="off"></div>
      <div class="acts"><button class="btn btn-primary btn-sm" type="submit">Next</button><button class="btn btn-ghost btn-sm" type="button" data-ag="plan-back">Back to the choices</button></div></form>`;
  }
  const chips = q.options.map((o) => `<button type="button" class="chip" data-ag="plan-pick" data-q="${esc(q.id)}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join("");
  return `${bubble(esc(q.ask))}<div class="fd-opts" role="group" aria-label="${esc(q.ask)}">${chips}</div>`;
}

function limitsSentence(p: Proposal): string {
  const l = p.limits;
  return `It can use up to ${l.dailyPercent}% of your weekly energy in a day, up to ${l.perJobPercent}% on one job, and send up to ${l.jobsPerHour} jobs an hour.`;
}

function proposalHtml(s: PlanState, p: Proposal, origin: string): string {
  const employees = p.employees.length ? p.employees.map((e) => esc(e.title)).join(", ") : "nobody yet. Choose in the next step";
  const estimate = p.estimate ? `<li>About ${num(p.estimate.jobsADay)} requests a day at about ${num(p.estimate.perJob)} energy each is about ${num(p.estimate.perDay)} energy a day, which is about ${p.estimate.percentOfPoolADay}% of your weekly energy.</li>` : "";
  const examples = p.examples.length ? `<h4>Example requests it can send</h4><ul class="agp-list">${p.examples.map((e) => `<li>${esc(e.brief)}</li>`).join("")}</ul>` : "";
  const accept = p.employees.length ? '<button class="btn btn-primary btn-sm" type="button" data-ag="plan-accept">Accept and create the key</button>' : "";
  return `${bubble(esc(p.says))}
    <section class="agp-card" aria-labelledby="agp-h"><h3 id="agp-h" tabindex="-1">${esc(p.name)}</h3>
      <ul class="agp-list">
        <li><b>May give work to:</b> ${employees}.</li>
        <li><b>Limits:</b> ${esc(limitsSentence(p))}</li>
        <li><b>Your OK:</b> ${p.needsApproval ? "Each job waits for you before it runs." : "Jobs run without waiting for you, inside those limits."}</li>
        ${estimate}
      </ul>
      ${p.notes.length ? `<ul class="agp-list agp-notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${examples}
      <h4>How to connect it</h4><ol class="agp-list">${p.connect.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
      <p class="small muted">The address to send jobs to is <code class="mono">${esc(origin)}/api/agent/v1/jobs</code>. The key appears once, after you accept.</p>
      <div class="acts">${accept}<button class="btn btn-ghost btn-sm" type="button" data-ag="plan-change">Change it</button><button class="btn btn-ghost btn-sm" type="button" data-ag="plan-restart">Start again</button><button class="btn btn-ghost btn-sm" type="button" data-ag="plan-cancel">Cancel</button></div>
      <p class="small muted">${s.target ? "Accepting changes this connection to match. Its key stays the same." : "Nothing is switched on until you accept."}</p>
    </section>`;
}

/** The whole interview as it should look now. */
export function planHtml(s: PlanState, origin: string): string {
  const q = nextQuestion(s);
  const lead = bubble("Hello. I will ask three short questions about your tool, then suggest how to set it up. Nothing is created until you say so.");
  const body = s.proposal ? proposalHtml(s, s.proposal, origin) : q ? questionHtml(s, q) : "";
  const wait = s.working ? '<p class="status live wrap"><span class="dot"></span>Working out a suggestion…</p>' : "";
  const err = s.error ? `<p class="small status crit wrap" role="alert">${esc(s.error)}</p>` : "";
  const skip = s.proposal ? "" : '<div class="acts"><button class="btn btn-ghost btn-sm" type="button" data-ag="plan-skip">Skip the questions and set it up myself</button><button class="btn btn-ghost btn-sm" type="button" data-ag="plan-cancel">Cancel</button></div>';
  return `<section class="agp" aria-labelledby="agp-title"><h3 id="agp-title">Plan it with the Admin manager</h3>
    <div class="agp-log" role="log" aria-live="polite">${lead}${askedHtml(s)}${body}${wait}</div>${err}${skip}</section>`;
}

/** Looks of an existing connection's saved set-up: what it is for, and the example requests the tool can send. */
export function profileHtml(p: Profile | null): string {
  if (!p) return "";
  const what = p.purpose === "custom" && p.purposeNote ? p.purposeNote : WHAT_PURPOSE[p.purpose] ?? "";
  const examples = p.examples.length ? `<details class="ag-how"><summary>Example requests it can send</summary><ul class="agp-list">${p.examples.map((e) => `<li>${esc(e.brief)}</li>`).join("")}</ul></details>` : "";
  return `<p class="small">Set up with the Admin manager for ${esc(what)}. Its employees are told this when its jobs arrive.</p>${examples}`;
}
