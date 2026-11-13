/**
 * Roles nobody planned for. When the owner needs a specialist that is neither a ready-made
 * employee nor in the org blueprint, the Admin manager designs one: it turns the owner's brief
 * into a role blueprint, which becomes a full job description and a template like any other
 * specialist. The draft goes to the MAIZ platform owner for review (src/modules/review/specialists.ts)
 * before anything is trained; the client then decides whether to hire it at the confirmed price.
 *
 * Pure data and functions, no server imports: the website imports this file too.
 */
import { allRoles, jobDescriptionFromRole, type RoleBlueprint } from "./blueprints.js";
import { CONSULTANTS } from "./consultants.js";
import { JOB_DESCRIPTIONS, type JobDescription } from "./job-descriptions.js";

export interface RoleBrief {
  /** The job title the owner wants, for example "Wholesale account coordinator". */
  title: string;
  /** Why the role is needed, in a sentence. */
  purpose: string;
  /** What the specialist should do. At least MIN_DUTIES. */
  duties: readonly string[];
  skills?: readonly string[];
  legal?: readonly string[];
  records?: readonly string[];
}

export const MIN_DUTIES = 2;
export const MAX_DUTIES = 12;
const MAX_TITLE = 60;
const MAX_LINE = 240;

/** Work that needs a licensed professional. A specialist may prepare and organise, never practise. */
const REGULATED: readonly [RegExp, string][] = [
  [/\b(lawyer|solicitor|barrister|attorney|legal advi[cs]e)\b/i, "legal advice"],
  [/\b(doctor|nurse|medical|diagnos\w*|prescri\w*|therap\w*|pharmac\w*)\b/i, "medical or health care"],
  [/\b(tax advi[cs]\w*|audit(or|ing)?|statutory audit)\b/i, "tax advice or audit"],
  [/\b(investment advi[cs]\w*|financial advi[cs]\w*|stockbrok\w*)\b/i, "regulated financial advice"],
];

export type RoleDraft =
  | { ok: true; role: RoleBlueprint; jobDescription: JobDescription; similar: string[]; notes: string[] }
  | { ok: false; problems: string[] };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const cleanList = (xs: readonly string[] | undefined) => [...new Set((xs ?? []).map(clean).filter(Boolean))];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const words = (s: string) => new Set(slug(s).split("-").filter((w) => w.length > 3 && !["manager", "specialist", "officer", "coordinator"].includes(w)));

/** Existing employees, blueprint roles and consultants whose title shares a meaningful word with the brief. */
export function similarRoles(title: string): string[] {
  const wanted = words(title);
  const covered = allRoles().flatMap((r) => (r.covers ?? []).map((job) => `${r.title} (includes ${job})`));
  const existing = [...JOB_DESCRIPTIONS.map((j) => j.jobTitle), ...allRoles().map((r) => r.title), ...covered, ...CONSULTANTS.map((c) => c.title)];
  return [...new Set(existing.filter((t) => [...words(t)].some((w) => wanted.has(w))))];
}

/**
 * The Admin manager's role designer. Checks the brief, refuses what is unsafe or too thin,
 * and returns a draft role with its full job description for MAIZ to review.
 */
export function draftCustomRole(brief: RoleBrief): RoleDraft {
  const title = clean(brief.title);
  const purpose = clean(brief.purpose);
  const duties = cleanList(brief.duties);
  const problems: string[] = [];
  if (title.length < 3) problems.push("Give the role a job title.");
  if (title.length > MAX_TITLE) problems.push(`Keep the job title under ${MAX_TITLE} characters.`);
  if (purpose.length < 10) problems.push("Say in a sentence why you need this role.");
  if (duties.length < MIN_DUTIES) problems.push(`List at least ${MIN_DUTIES} things the specialist should do.`);
  if (duties.length > MAX_DUTIES) problems.push(`Keep it to ${MAX_DUTIES} duties. A bigger job is better split into two roles.`);
  if ([purpose, ...duties].some((line) => line.length > MAX_LINE)) problems.push(`Keep each line under ${MAX_LINE} characters.`);
  const key = `custom-${slug(title)}`;
  if (title.length >= 3 && key === "custom-") problems.push("Use letters or numbers in the job title.");
  if (problems.length) return { ok: false, problems };

  const text = [title, purpose, ...duties].join(" ");
  const regulated = REGULATED.filter(([re]) => re.test(text)).map(([, what]) => what);
  const notes = regulated.map((what) => `This touches ${what}. The specialist will prepare, organise and explain, and will tell you when a qualified professional must decide.`);
  const similar = similarRoles(title);
  if (similar.length) notes.push(`Similar roles already exist: ${similar.join(", ")}. Check they do not already cover this.`);

  const role: RoleBlueprint = {
    key,
    title,
    purpose: /[.!?]$/.test(purpose) ? purpose : `${purpose}.`,
    duties,
    skills: cleanList(brief.skills).length ? cleanList(brief.skills) : ["Good practice for this role, learned from the owner's brief and examples", "Clear written communication", "Accurate record-keeping"],
    legal: cleanList(brief.legal).length ? cleanList(brief.legal) : ["Data protection for any personal data the role handles", "Any rule specific to this role, confirmed for the owner's country with a dated official source"],
    records: cleanList(brief.records).length ? cleanList(brief.records) : ["Log of work done, decisions and approvals", "Documents and templates used by the role, with versions"],
    // Accuracy matters more where a regulated profession is nearby, so those roles use the premium lane.
    tier: regulated.length ? "premium" : "standard",
  };
  return { ok: true, role, jobDescription: jobDescriptionFromRole(role, "Custom specialists"), similar, notes };
}
