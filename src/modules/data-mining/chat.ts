import { cleanTopic } from "./dataset.js";
import type { MiningQuote } from "./service.js";
import type { MiningSourceId } from "./sources.js";

/**
 * Starting a search from a conversation: the pure parts. Working out whether a message is a request to look up
 * public market data, and writing the reply. No AI model is asked, so reading a message this way uses no energy and
 * can never start a search by itself: the reply is always the quote, and the client confirms it or not.
 */

/** A request to look something up: the topic, and the places the client named (none means "the usual places"). */
export interface SearchRequest { topic: string; named: MiningSourceId[] }
/**
 * How sure the wording has to be. "addressed": the message is to the Data mining agent, so "look up coffee carts" is
 * enough. "open": it was typed in the ask bar to nobody in particular, so it must name public market data plainly.
 */
export type RequestMode = "addressed" | "open";

/** The places looked in when the client names none. Any that MAIZ has not switched on are left out of the quote. */
export const USUAL_SOURCES: readonly MiningSourceId[] = ["news", "reddit", "youtube", "hackernews"];
/** A topic about prices or the economy also gets the country's economy figures. */
const ECONOMY_WORDS = /\b(?:prices?|inflation|econom\w*|cost of living|unemployment|wages?)\b/i;

const LEAD_IN = /^(?:(?:hi|hey|hello|ok|okay|please)[\s,!.]+)*(?:(?:can|could|would|will) you (?:please )?|i(?: would|'d) like you to |i (?:want|need) you to |please )?/i;
const VERB = /^(?:find out|find|look up|look into|look for|search for|search|research|gather|collect|dig up|track down|check|get)\b\s*(?:(?:me|us)\s+)?/i;
const WEAK_VERB = /^(?:check|get)\b/i;
/** Words that mean the client is asking about data that is already saved, not for a new search. */
const ALREADY_SAVED = /\b(?:datasets?|saved|you (?:gathered|found|collected|looked up)|last (?:search|time|week)|already|earlier)\b/i;
/** A request that goes on to a second job is work for the employee, not a search. */
const FOLLOW_ON_JOB = /\b(?:and|then)\s+(?:then\s+)?(?:write|draft|make|create|send|post|tell|summari[sz]e|email|plan|prepare|compare)\b/i;
const FILLER = "(?:(?:some|the|any|all the|the latest|latest|recent|current)\\s+)*";
/** Phrases that plainly mean public market data. In the ask bar one of these (or a named place) is required. */
const MARKET_WHAT = new RegExp(`^${FILLER}(?:(?:public\\s+)?market data|public data|what (?:people|customers|everyone|the public) (?:are|is) saying|what (?:people|customers) (?:say|think)|(?:the\\s+)?news(?: coverage| articles| stories)?|public (?:posts|discussions|opinions?))\\b\\s*`, "i");
/** Looser words that are fine when the message is to the Data mining agent. */
const ANY_WHAT = new RegExp(`^${FILLER}(?:data|posts|discussions|conversations|opinions?|mentions|articles|videos|figures|numbers|statistics|stats|information|info|trends)\\b\\s*`, "i");
const LINK = /^(?:about|on|for|around|regarding|into|of)\b\s*/i;

const SOURCE_NAMES: readonly [MiningSourceId, RegExp][] = [
  ["hackernews", /^(?:hacker\s*news|hn)$/i], ["reddit", /^reddit$/i], ["youtube", /^you\s*tube$/i],
  ["x", /^(?:x|twitter)$/i], ["news", /^news$/i], ["companies", /^companies house$/i],
];
const NAME = "(?:hacker\\s*news|hn|reddit|you\\s*tube|twitter|x|news|companies house)";
const PLACE = "(?:(?:on|from|in|at|using|across|via|through)\\s+)?(?:the\\s+)?";
const NAME_LIST = `${PLACE}${NAME}(?:\\s*(?:,\\s*and|,|and|&)\\s*${PLACE}${NAME})*`;
/** "search the news and Reddit for oat milk". */
const PLACES_FIRST = new RegExp(`^(${NAME_LIST})\\s+for\\s+(.+)$`, "i");
/** "... oat milk on Reddit and in the news". */
const PLACES_LAST = new RegExp(`^(.+?)\\s+(?:on|from|in|at|using|across|via)\\s+((?:the\\s+)?${NAME}(?:\\s*(?:,\\s*and|,|and|&)\\s*${PLACE}${NAME})*)$`, "i");

function namedIn(list: string): MiningSourceId[] {
  const words = list.split(/\s*(?:,|\band\b|&)\s*/i).map((w) => w.replace(/^(?:(?:on|from|in|at|using|across|via|through)\s+)?(?:the\s+)?/i, "").trim()).filter(Boolean);
  const ids = words.map((w) => SOURCE_NAMES.find(([, re]) => re.test(w))?.[0]).filter((id): id is MiningSourceId => id !== undefined);
  return [...new Set(ids)];
}

const tidy = (s: string): string => s.replace(/[\s.?!]+$/g, "").replace(/\s+(?:for me|please|thanks|thank you)$/i, "").replace(/[\s.?!,]+$/g, "");

/**
 * Reads a message as a request to look up public data, or returns undefined when it is anything else (a question
 * about saved datasets, ordinary work, small talk), in which case it goes to the employee as it always did.
 */
export function readSearchRequest(text: string, mode: RequestMode): SearchRequest | undefined {
  if (typeof text !== "string" || text.length > 400) return undefined;
  const said = tidy(text.replace(/\s+/g, " ").trim().replace(LEAD_IN, ""));
  if (ALREADY_SAVED.test(said) || FOLLOW_ON_JOB.test(said)) return undefined;
  const verb = VERB.exec(said);
  if (!verb) return undefined;
  let rest = said.slice(verb[0].length);
  let named: MiningSourceId[] = [];
  // "Clear" means the words themselves say public data: a market-data phrase, or a place to search named up front.
  let clear = false;
  const first = PLACES_FIRST.exec(rest);
  if (first) {
    named = namedIn(first[1]!);
    rest = first[2]!;
    clear = true;
  } else {
    const market = MARKET_WHAT.exec(rest);
    const what = market ?? (mode === "addressed" ? ANY_WHAT.exec(rest) : null);
    if (what) rest = rest.slice(what[0].length).replace(LINK, "");
    clear = !!market;
    // "get" and "check" start too many ordinary sentences to count without saying what is wanted.
    if (WEAK_VERB.test(verb[0]) && !what) return undefined;
    const last = PLACES_LAST.exec(rest);
    if (last) { rest = last[1]!; named = namedIn(last[2]!); }
  }
  if (mode === "open" && !clear) return undefined;
  const topic = cleanTopic(tidy(rest));
  return topic ? { topic, named } : undefined;
}

/** The places to quote for a request: the ones the client named, or the usual ones (plus economy figures for a topic about prices). */
export function sourcesFor(request: SearchRequest): MiningSourceId[] {
  if (request.named.length) return request.named;
  return ECONOMY_WORDS.test(request.topic) ? [...USUAL_SOURCES, "economy"] : [...USUAL_SOURCES];
}

/**
 * The quote in words, the same figures the Market data screen shows: each place with its energy, the most the search
 * can use, and that nothing has run yet. `mention` lists places the client named that cannot be read right now.
 */
export function offerText(quote: MiningQuote, mention: readonly MiningSourceId[]): string {
  const ready = quote.sources.filter((s) => s.available);
  const places = ready.map((s) => `${s.label} (${s.energy} energy)`).join(", ");
  const paid = ready.filter((s) => s.paid).map((s) => `${s.label} costs MAIZ money for each search, so it uses more energy.`);
  const left = quote.sources.filter((s) => !s.available && mention.includes(s.id)).map((s) => `${(s.reason ?? `${s.label} is not available`).replace(/\.+$/, "")}, so it is left out.`);
  return [
    `I can look up "${quote.topic}" in: ${places}.`,
    `That uses up to ${quote.total} energy from your team's pool. You only pay for sources that find something.`,
    ...paid, ...left,
    "Nothing has been looked up yet. Shall I start?",
  ].join(" ");
}

export const CHAT_NOT_HIRED = "The Data mining agent is not on your team yet, so nothing was looked up and no energy was used. You can hire it from the store.";
export const CHAT_DECLINED = "No problem. Nothing was looked up and no energy was used.";
export const CHAT_NOTHING_WAITING = "There is no search waiting to be confirmed. Ask the Data mining agent to look something up first.";
