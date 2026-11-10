/**
 * Decides how a piece of work is handled, so people never wait for what does not need speed and
 * never get a delayed answer to a quick question.
 *
 *  - lookup: a quick question answered from the records (status, rota, "what did we spend"). A cheap Claude model, at once.
 *  - urgent: real-time work on the normal route (RunPod now). Marked urgent, or time-sensitive words.
 *  - batch:  everything else (reports, drafts, bookkeeping, analysis). Queued and run together.
 *
 * Keyword rules are deliberately simple and visible. A person can always override with "urgent" or Run now.
 */
export type WorkMode = "lookup" | "urgent" | "batch";
export interface Classification { mode: WorkMode; reason: string }

const URGENT = /\b(urgent(ly)?|asap|immediately|right now|right away|emergency|deadline today|due today|by (noon|midday|today|tonight|end of day|eod)|before (my|the) (meeting|call)|in the next (hour|few minutes))\b/i;
const QUESTION_START = /^\s*(what|what's|whats|when|who|who's|how many|how much|which|where|is|are|do|does|did|can you tell|show|list|status|check|remind)\b/i;
const WORK_VERBS = /\b(write|draft|create|prepare|build|compile|generate|analy[sz]e|reconcile|categori[sz]e|summari[sz]e|plan|design|research|review|audit|forecast|produce|put together|file|post|process|report)\b/i;
const LOOKUP_MAX_CHARS = 220;

export function classifyWork(input: { brief: string; templateKey: string; urgent?: boolean; liveTemplates: readonly string[] }): Classification {
  const { brief, templateKey } = input;
  if (input.liveTemplates.includes(templateKey)) return { mode: "urgent", reason: "this employee always answers at once" };
  if (input.urgent) return { mode: "urgent", reason: "marked urgent" };
  if (URGENT.test(brief)) return { mode: "urgent", reason: "sounds time-sensitive" };
  if (brief.length <= LOOKUP_MAX_CHARS && (QUESTION_START.test(brief) || brief.trim().endsWith("?")) && !WORK_VERBS.test(brief)) {
    return { mode: "lookup", reason: "a quick question about current records" };
  }
  return { mode: "batch", reason: "not urgent, so it runs with the next batch" };
}

/** Work that must stay real-time and why. Shown to the platform owner and the client; edit with liveTemplates and the keyword rules above. */
export const REAL_TIME_RULES: readonly { what: string; why: string }[] = [
  { what: "The Admin manager (setup, welcome, form, rollback)", why: "People wait on it during sign-up and it must never be delayed (liveTemplates)" },
  { what: "Anything marked urgent, or worded as time-sensitive", why: "The person chose speed" },
  { what: "Quick questions about current status, the rota or existing records", why: "Answered at once by a cheap Claude model reading the records" },
  { what: "Sign-off decisions and quality review", why: "A person decides these; they are not model work and are never queued" },
  { what: "Sign-in, payments and anything touching money movement", why: "Not AI work; never queued" },
];
