import { looksLikeWork } from "../batch/classify.js";

/**
 * Short questions the client's own records can answer exactly, so they get an answer in milliseconds with no
 * model call and no energy. Matching is deliberately strict: anything that mentions another day, asks for writing
 * or analysis, or is long falls through to the normal route. A wrong "instant" answer is worse than a slow one.
 */
export type InstantTopic = "who_in_today" | "hours_this_week" | "cash_runway" | "energy_left" | "next_batch";

const MAX_CHARS = 140;
/** Another day or period than today / this week: the records here only answer for now. */
const OTHER_TIME = /\b(tomorrow|yesterday|next|last|previous|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[/-]\d{1,2})\b/i;

const PATTERNS: readonly [InstantTopic, RegExp][] = [
  ["who_in_today", /\bwho(?:'s|s| is| are)?\s+(?:in|working|on shift|on the rota|on today|coming in)\b/i],
  ["hours_this_week", /\b(?:how many hours|total hours|hours scheduled|labou?r cost)\b.*\b(?:this week|scheduled|rota)\b|\bhours (?:this week|scheduled)\b/i],
  ["cash_runway", /\b(?:how much cash|cash (?:do we have|left|balance|position|in the bank)|runway|how long (?:will|can) (?:our )?cash last)\b/i],
  ["energy_left", /\bhow much energy\b|\benergy (?:left|remaining)\b|\bam i (?:out|running low) of energy\b/i],
  ["next_batch", /\bwhen\b.*\b(?:batch|queue)\b.*\brun\b|\bwhat(?:'s| is)\b.*\b(?:in|waiting in) (?:the|my) (?:queue|batch)\b|\bnext batch\b|\bwhat(?:'s| is) the batch doing\b/i],
];

export function matchInstant(brief: string): InstantTopic | undefined {
  const text = brief.trim();
  if (!text || text.length > MAX_CHARS || looksLikeWork(text) || OTHER_TIME.test(text)) return undefined;
  return PATTERNS.find(([, re]) => re.test(text))?.[0];
}
