import { employeeKey } from "./keys.js";
import { AGENT_TOOLS, AgentError, CUSTOMER_SUPPORT_KEY, DEFAULT_LIMITS, MAX_LIMITS, NEVER_ALLOWED, type AgentLimits, type AgentTool } from "./types.js";

/**
 * The Admin manager's planning interview for an outside tool (stage 2 in docs/EXTERNAL-AGENTS.md): a few plain
 * questions, and a proposed set-up worked out from the answers. Everything here is a fixed rule or a template. No AI
 * model is asked, so planning uses no energy, and nothing is created: the owner accepts or changes the proposal, and
 * accepting goes through the same door, and the same limits, as making a connection by hand.
 */

export const AGENT_PURPOSES = ["customer-service", "order-tracking", "bookings", "reports", "custom"] as const;
export type AgentPurpose = (typeof AGENT_PURPOSES)[number];
export const AGENT_VOLUMES = ["few", "some", "many", "lots", "unsure"] as const;
export type AgentVolume = (typeof AGENT_VOLUMES)[number];

/** A request the tool could send, as an example for whoever sets the tool up. */
export interface AgentExample { employee: string; brief: string }

/** What the owner told the Admin manager about a tool. Kept with the connection and given to the employee as context. */
export interface AgentProfile {
  purpose: AgentPurpose;
  /** The owner's own few words, when the tool does "something else". Plain text on one line. */
  purposeNote?: string;
  volume: AgentVolume;
  examples: AgentExample[];
  plannedAt: string;
}

export interface PlanOption { value: string; label: string; /** Set when choosing this asks for a few typed words too. */ typed?: string }
export interface PlanQuestion { id: "purpose" | "tool" | "volume"; ask: string; options: PlanOption[] }

export const PLAN_QUESTIONS: readonly PlanQuestion[] = [
  { id: "purpose", ask: "What does your tool do today?", options: [
    { value: "customer-service", label: "Customer service" }, { value: "order-tracking", label: "Order tracking" },
    { value: "bookings", label: "Bookings" }, { value: "reports", label: "Reports" },
    { value: "custom", label: "Something else", typed: "Say what it does in a few words" },
  ] },
  { id: "tool", ask: "Where does it live?", options: [
    { value: "zapier", label: "Zapier" }, { value: "make", label: "Make" }, { value: "n8n", label: "n8n" },
    { value: "claude", label: "Claude" }, { value: "chatgpt", label: "ChatGPT" }, { value: "other", label: "Something else, or not sure" },
  ] },
  { id: "volume", ask: "Roughly how many requests will it send in a day?", options: [
    { value: "few", label: "A few, up to 10" }, { value: "some", label: "Up to 50" }, { value: "many", label: "Up to 200" },
    { value: "lots", label: "More than 200" }, { value: "unsure", label: "Not sure yet" },
  ] },
];

/** One employee on the client's team, and whether an outside tool may be given it. */
export type PlanRoster = readonly { key: string; title: string; allowed: boolean; reason?: string }[];
/** The team's weekly energy pool and what one job is expected to use: the two real figures a plan is sized from. */
export interface PlanSize { weeklyPool: number; perJob: number }

export interface PlanEstimate { perJob: number; jobsADay: number; perDay: number; percentOfPoolADay: number }

export interface AgentProposal {
  /** What the Admin manager says above the proposal. */
  says: string;
  name: string;
  tool: AgentTool;
  employees: { key: string; title: string }[];
  limits: AgentLimits;
  needsApproval: boolean;
  examples: AgentExample[];
  /** Left out when the owner is not sure how busy the tool will be: no figure is made up. */
  estimate?: PlanEstimate;
  /** Why each choice was made, one plain sentence each. */
  notes: string[];
  /** How to connect this kind of tool, step by step. */
  connect: string[];
  /** What is kept with the connection if the owner accepts. */
  profile: Omit<AgentProfile, "plannedAt">;
}

const NOTE_MAX_CHARS = 200;
const EXAMPLE_MAX_CHARS = 300;
const MAX_EXAMPLES = 5;
/** The lowest daily limit proposed, so a quiet tool still has room for a busy day. */
const MIN_DAILY_PERCENT = 5;
/** The day's jobs are assumed to arrive within a working day, with room for a burst. */
const JOBS_A_DAY: Record<Exclude<AgentVolume, "unsure">, number> = { few: 10, some: 50, many: 200, lots: 400 };
const JOBS_AN_HOUR: Record<Exclude<AgentVolume, "unsure">, number> = { few: 10, some: 20, many: 60, lots: 120 };
const PURPOSE_WORDS: Record<AgentPurpose, string> = { "customer-service": "customer service", "order-tracking": "order tracking", bookings: "bookings", reports: "reports", custom: "custom" };
const TOOL_WORDS: Record<AgentTool, string> = { claude: "Claude", chatgpt: "ChatGPT", zapier: "Zapier", make: "Make", n8n: "n8n", other: "" };
const SUGGESTED: Record<AgentPurpose, readonly string[]> = {
  "customer-service": [CUSTOMER_SUPPORT_KEY], "order-tracking": [CUSTOMER_SUPPORT_KEY, "supply-chain-manager"], bookings: [CUSTOMER_SUPPORT_KEY],
  reports: ["business-consultant", "marketing-manager"], custom: [CUSTOMER_SUPPORT_KEY],
};
const EXAMPLE_BRIEFS: Record<AgentPurpose, readonly string[]> = {
  "customer-service": ["A customer asks where their order is. Draft a polite reply. The order details are in the data.", "A customer wants a refund for a late delivery. Draft a reply that follows our refund policy.", "Sum up this customer conversation in three lines for the team. The messages are in the data."],
  "order-tracking": ["Order 4471 was due on Tuesday and has not arrived. Draft a message to the customer with the latest status from the data.", "A supplier says a delivery will be a week late. Draft a short note to the customers who are affected."],
  bookings: ["A customer wants to move their booking from Friday to Monday. Draft a reply that offers the free times in the data.", "Draft a friendly reminder for tomorrow's bookings. The list is in the data."],
  reports: ["Write a short summary of this week's figures in the data, with three things to watch.", "Compare this month with last month from the data and say what changed, in plain words."],
  custom: ["Say what you need in one or two plain sentences, and put any details in the data."],
};
const CONNECT_STEPS: Record<AgentTool, readonly string[]> = {
  zapier: ["In Zapier, add a step called Webhooks by Zapier and choose POST.", "Paste the address below into the URL box.", "Add a header named Authorization. Its value is the word Bearer, a space, then your key.", "Add two fields: employee (who the job is for) and brief (what you need)."],
  make: ["In Make, add an HTTP module and choose Make a request, with the method POST.", "Paste the address below into the URL box.", "Add a header named Authorization. Its value is the word Bearer, a space, then your key.", "Send two fields: employee (who the job is for) and brief (what you need)."],
  n8n: ["In n8n, add an HTTP Request step with the method POST.", "Paste the address below into the URL box.", "Add a header named Authorization. Its value is the word Bearer, a space, then your key.", "Send two fields: employee (who the job is for) and brief (what you need)."],
  claude: ["Give the address below and your key to whoever set up your Claude assistant.", "The assistant sends a job with two fields, employee and brief, and reads the answer back."],
  chatgpt: ["Give the address below and your key to whoever set up your ChatGPT assistant.", "The assistant sends a job with two fields, employee and brief, and reads the answer back."],
  other: ["Send the address below and your key to whoever built your tool.", "The tool sends a job with two fields, employee and brief, and reads the answer back."],
};

const pick = <T extends string>(v: unknown, from: readonly T[]): T | undefined => from.find((x) => x === v);
/** Plain text on one line: nothing that could look like the markers around a request, or break out of a sentence. */
const plain = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[^\p{L}\p{N}\p{M} .,'&+#/%£$€?!:;()-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "");
/** The name a tool uses for an employee: the short "customer-support" for the customer support employee. */
const publicKey = (key: string): string => (key === CUSTOMER_SUPPORT_KEY ? "customer-support" : key);

interface Answers { purpose: AgentPurpose; purposeNote: string; tool: AgentTool; volume: AgentVolume; employees?: string[] }

function readAnswers(raw: unknown): Answers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError("Send the answers as a JSON object.", "invalid_request");
  const b = raw as Record<string, unknown>;
  const purpose = pick(b.purpose, AGENT_PURPOSES), tool = pick(b.tool, AGENT_TOOLS), volume = pick(b.volume, AGENT_VOLUMES);
  if (!purpose || !tool || !volume) throw new AgentError("Choose one of the answers for each question.", "answer_invalid");
  const named = Array.isArray(b.employees) ? b.employees.filter((k): k is string => typeof k === "string").slice(0, 20) : undefined;
  return { purpose, purposeNote: purpose === "custom" ? plain(b.purposeNote, NOTE_MAX_CHARS) : "", tool, volume, ...(named ? { employees: named } : {}) };
}

/** The employees to propose: the owner's own choice when they made one, otherwise the usual ones for this kind of tool. */
function chooseEmployees(a: Answers, roster: PlanRoster): { employees: { key: string; title: string }[]; notes: string[] } {
  const wanted = [...new Set((a.employees ?? SUGGESTED[a.purpose]).map(employeeKey))];
  const notes: string[] = [];
  const employees: { key: string; title: string }[] = [];
  for (const key of wanted) {
    const entry = roster.find((e) => e.key === key);
    const never = NEVER_ALLOWED[key] ?? (entry && !entry.allowed ? entry.reason ?? "An outside tool can never use that employee." : undefined);
    if (never) { if (a.employees) notes.push(never); continue; }
    if (entry) employees.push({ key: entry.key, title: entry.title });
  }
  if (!employees.length) notes.push("None of the employees I would usually suggest for this are on your team, so choose which employees this tool may give jobs to.");
  return { employees, notes };
}

/** Limits sized to the answers, never above what anyone may set. Without a volume the usual starting limits are used. */
function sizeLimits(volume: AgentVolume, size: PlanSize): { limits: AgentLimits; estimate?: PlanEstimate; notes: string[] } {
  const pool = Math.max(1, size.weeklyPool), perJob = Math.max(1, Math.round(size.perJob));
  const jobPercent = (perJob / pool) * 100;
  const perJobPercent = Math.min(MAX_LIMITS.perJobPercent, Math.max(DEFAULT_LIMITS.perJobPercent, Math.ceil(jobPercent)));
  const notes = jobPercent > MAX_LIMITS.perJobPercent ? [`One job is expected to use about ${perJob} energy, which is more than a single job from an outside tool may use, so each job would wait for your OK.`] : [];
  if (volume === "unsure") {
    return { limits: { ...DEFAULT_LIMITS, perJobPercent }, notes: [...notes, "You were not sure how busy it will be, so these are the usual starting limits. You can change them at any time."] };
  }
  const jobsADay = JOBS_A_DAY[volume];
  const perDay = jobsADay * perJob;
  const percentOfPoolADay = Math.ceil((perDay / pool) * 100);
  const estimate: PlanEstimate = { perJob, jobsADay, perDay, percentOfPoolADay };
  const dailyPercent = Math.min(MAX_LIMITS.dailyPercent, Math.max(MIN_DAILY_PERCENT, percentOfPoolADay));
  const over = percentOfPoolADay > MAX_LIMITS.dailyPercent
    ? [`That is more than the daily limit an outside tool may have (${MAX_LIMITS.dailyPercent}% of your weekly energy), so it would stop part way through a busy day. Fewer requests or a bigger plan would fix that.`]
    : [];
  return { limits: { dailyPercent, perJobPercent, jobsPerHour: JOBS_AN_HOUR[volume] }, estimate, notes: [...notes, ...over] };
}

function approvalFor(a: Answers): { needsApproval: boolean; note: string } {
  if (a.purpose === "custom") return { needsApproval: true, note: "Every job will wait for your OK before an employee starts, because this is a new kind of work. You can switch that off once you have seen what it sends." };
  if (a.volume === "few") return { needsApproval: true, note: "Every job will wait for your OK before an employee starts. With a few requests a day that is quick, and you can switch it off later." };
  return { needsApproval: false, note: "Jobs start without waiting for you, because approving each one at this pace would not be practical. The limits stop it using more than you agreed." };
}

/**
 * The proposed set-up for a tool, from the owner's answers, the client's own team and two real figures (the weekly
 * pool and what a job is expected to use). Only employees the client has and an outside tool may use are proposed,
 * and no limit is above the platform's maximum. Throws when an answer is not one of the choices.
 */
export function proposePlan(rawAnswers: unknown, roster: PlanRoster, size: PlanSize): AgentProposal {
  const a = readAnswers(rawAnswers);
  const chosen = chooseEmployees(a, roster);
  const sized = sizeLimits(a.volume, size);
  const approval = approvalFor(a);
  const first = chosen.employees[0];
  const examples: AgentExample[] = first ? EXAMPLE_BRIEFS[a.purpose].map((brief) => ({ employee: publicKey(first.key), brief })) : [];
  const what = a.purpose === "custom" ? "tool" : `${PURPOSE_WORDS[a.purpose]} tool`;
  const name = a.purpose === "custom" ? `${TOOL_WORDS[a.tool] || "My"} tool` : TOOL_WORDS[a.tool] ? `${TOOL_WORDS[a.tool]} ${PURPOSE_WORDS[a.purpose]}` : `${PURPOSE_WORDS[a.purpose][0]!.toUpperCase()}${PURPOSE_WORDS[a.purpose].slice(1)} tool`;
  return {
    says: `Here is what I suggest for your ${what}. Nothing is switched on until you accept, and you can change any of it.`,
    name, tool: a.tool, employees: chosen.employees, limits: sized.limits, needsApproval: approval.needsApproval, examples,
    ...(sized.estimate ? { estimate: sized.estimate } : {}),
    notes: [...chosen.notes, approval.note, ...sized.notes],
    connect: [...CONNECT_STEPS[a.tool]],
    profile: { purpose: a.purpose, ...(a.purposeNote ? { purposeNote: a.purposeNote } : {}), volume: a.volume, examples },
  };
}

/**
 * Checks a set-up before it is kept with a connection. It arrives from the browser, so nothing in it is trusted: the
 * answers must be from the lists, the owner's words become plain text, and an example is kept only for an employee
 * this connection may use. The time is the server's own.
 */
export function cleanProfile(raw: unknown, allowedKeys: readonly string[], now: string): AgentProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError("The set-up answers are not valid. Plan the connection again.", "profile_invalid");
  const b = raw as Record<string, unknown>;
  const purpose = pick(b.purpose, AGENT_PURPOSES), volume = pick(b.volume, AGENT_VOLUMES);
  if (!purpose || !volume) throw new AgentError("The set-up answers are not valid. Plan the connection again.", "profile_invalid");
  const note = purpose === "custom" ? plain(b.purposeNote, NOTE_MAX_CHARS) : "";
  const examples = (Array.isArray(b.examples) ? b.examples : []).flatMap((e): AgentExample[] => {
    const row = e && typeof e === "object" ? (e as Record<string, unknown>) : undefined;
    const brief = plain(row?.brief, EXAMPLE_MAX_CHARS);
    if (!row || typeof row.employee !== "string" || !brief || !allowedKeys.includes(employeeKey(row.employee))) return [];
    return [{ employee: publicKey(employeeKey(row.employee)), brief }];
  }).slice(0, MAX_EXAMPLES);
  return { purpose, ...(note ? { purposeNote: note } : {}), volume, examples, plannedAt: now };
}

/** What an employee is told about the tool a job came from, in the owner's own terms. Undefined when there is nothing to say. */
export function profileContext(profile: AgentProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const what = profile.purpose === "custom" ? profile.purposeNote : PURPOSE_WORDS[profile.purpose];
  return what ? plain(what, NOTE_MAX_CHARS) : undefined;
}
