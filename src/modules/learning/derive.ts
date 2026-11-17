/**
 * Turns what a client did to an answer into short, plain preferences. Rules only, no AI call, so learning costs no energy.
 * What it can see is limited on purpose: how long the answer is, exclamation marks, emoji and lists. It never guesses at
 * meaning; a client's own written note is stored as written (clipped).
 */
const EMOJI = /\p{Extended_Pictographic}/gu;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/gm;
export const LESSON_MAX_CHARS = 200;

const words = (t: string): number => (t.match(/\S+/g) ?? []).length;
const count = (t: string, re: RegExp): number => (t.match(re) ?? []).length;

/** One line of text with no line breaks and a hard length limit, safe to put in a prompt. */
export function cleanLine(text: string, max = LESSON_MAX_CHARS): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What the change from `before` to `after` says about how the client likes things. May be empty. */
export function lessonsFromEdit(before: string, after: string): string[] {
  const out: string[] = [];
  const b = words(before);
  const a = words(after);
  if (b >= 20 && a <= b * 0.75) out.push("Keep answers shorter.");
  else if (b >= 10 && a >= b * 1.25) out.push("Give more detail.");
  if (count(before, /!/g) > count(after, /!/g) && count(after, /!/g) === 0) out.push("Avoid exclamation marks.");
  if (count(before, EMOJI) > 0 && count(after, EMOJI) === 0) out.push("Do not use emoji.");
  else if (count(before, EMOJI) === 0 && count(after, EMOJI) > 0) out.push("Emoji are welcome.");
  const [bb, ab] = [count(before, BULLET), count(after, BULLET)];
  if (bb >= 3 && ab === 0) out.push("Write in plain paragraphs, not lists.");
  else if (bb === 0 && ab >= 3) out.push("Use short bullet lists where it helps.");
  return out;
}

/** The same sentence typed twice (case, spacing, final full stop) counts once. */
export const normal = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
