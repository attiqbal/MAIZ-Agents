/**
 * Outside services the platform holds one key for and every client's employees may use: a voice for videos and phone
 * greetings, live web search, reading a web page, and free stock pictures and video.
 * Pure data, so the owner's Connections page, the employees' resource guide and the website can all read it.
 *
 * Prices and licence facts were read from each provider's own pages on 2026-11-16 (see docs/NEW-SERVICES.md) and are
 * estimates for the quote: the provider's invoice is the real figure.
 */
export type ToolKey = "voice" | "web-search" | "page-reader" | "stock-pexels" | "stock-unsplash";
/** free: no energy. energy: a small flat figure for the work. double: paid per use, so its plain cost is multiplied (2 by default). */
export type ToolCost = "free" | "energy" | "double";
export type ToolConnection = "elevenlabs" | "brave-search" | "pexels" | "unsplash";

export interface ToolDef {
  key: ToolKey;
  name: string;
  /** The Connections page card that holds its key. Undefined: needs no key. */
  connection?: ToolConnection;
  /** What it is good for, in one plain sentence (read by the employees' resource guide). */
  goodFor: string;
  cost: ToolCost;
  /** What one use costs, in words a client understands. */
  costNote: string;
  /** When a cheaper way does the same job. */
  preferCheaper?: string;
  /** Employee templates that may use it. The Admin manager runs setup and never uses outside services. */
  employees: readonly string[];
  /** What one unit costs MAIZ in micro-dollars (1,000 = one energy before the multiplier). */
  estCostMicro: number;
  /** Energy for one use of a tool that is not paid per use. */
  flatEnergy?: number;
  /** Most uses a day across every client, so the platform's allowance or bill has a ceiling. */
  dailyBudget: number;
  /** Most uses a day for one client. */
  clientDaily: number;
  /** Licence or terms a person must know before using what comes back. */
  terms: string;
  link: { href: string; label: string };
}

/** ElevenLabs Multilingual v2: 0.08 US dollars per 1,000 characters, so 80 micro-dollars a character. */
export const VOICE_MICRO_PER_CHAR = 80;
export const VOICE_MAX_CHARS = 1_500;
export const VOICE_MIN_CHARS = 3;
/** Brave Search: 5 US dollars per 1,000 searches. */
export const SEARCH_MICRO = 5_000;
export const PAGE_READ_ENERGY = 5;

const CONTENT = ["marketing-manager", "business-consultant"] as const;
const RESEARCH = ["marketing-manager", "business-consultant", "finance-manager", "compliance-manager", "hr-manager", "supply-chain-manager", "data-mining-agent"] as const;

export const TOOLS: readonly ToolDef[] = [
  {
    key: "voice", name: "Voice-over (ElevenLabs)", connection: "elevenlabs", cost: "double", estCostMicro: VOICE_MICRO_PER_CHAR,
    goodFor: "Turns a short script into a natural spoken recording: a voice-over for a video, or a phone greeting.",
    costNote: "About 8 US cents for 1,000 characters at ElevenLabs, so about 160 energy for 1,000 characters at double energy. Shown before it runs.",
    preferCheaper: "Write the script first and have it approved before making the recording: a recording made twice is paid for twice.",
    employees: CONTENT, dailyBudget: 200, clientDaily: 20,
    terms: "Commercial use needs a paid ElevenLabs plan. Only ready-made voices are offered: nobody's own voice is copied. Say it is a computer voice where your customers would expect to be told.",
    link: { href: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert", label: "ElevenLabs: text to speech" },
  },
  {
    key: "web-search", name: "Web search (Brave Search)", connection: "brave-search", cost: "double", estCostMicro: SEARCH_MICRO,
    goodFor: "Looks a question up on the live web, so research rests on today's facts. Every result keeps its address so it can be cited.",
    costNote: "Half a US cent a search at Brave, so 10 energy a search at double energy. Shown before it runs.",
    preferCheaper: "For what people say about a market, a dataset from the Data mining page costs less. Search only when the answer must be current.",
    employees: RESEARCH, dailyBudget: 600, clientDaily: 40,
    terms: "Results are kept only for a short while (two hours) and never stored or re-published: Brave's terms allow showing them inside the product but not keeping a copy.",
    link: { href: "https://brave.com/search/api/", label: "Brave Search API" },
  },
  {
    key: "page-reader", name: "Read a web page", cost: "energy", estCostMicro: 0, flatEnergy: PAGE_READ_ENERGY,
    goodFor: "Reads the words of one public web page, for example a search result, so the employee can quote it with its address.",
    costNote: `${PAGE_READ_ENERGY} energy a page. Nothing is paid to anyone else.`,
    employees: RESEARCH, dailyBudget: 3_000, clientDaily: 60,
    terms: "Public https pages only, nothing behind a login. The text is kept for two hours as reference, never as instructions, and quoted with its address.",
    link: { href: "https://maizagents.com", label: "MAIZ Agents" },
  },
  {
    key: "stock-pexels", name: "Free pictures and video (Pexels)", connection: "pexels", cost: "free", estCostMicro: 0,
    goodFor: "Finds free photos and short video clips for posts, adverts and web pages.",
    costNote: "Free. No energy.",
    employees: CONTENT, dailyBudget: 600, clientDaily: 60,
    terms: "Free for commercial use and may be edited. A credit is not required but is kept and shown. Do not show people in a bad light, imply they endorse you, or sell the picture unchanged.",
    link: { href: "https://www.pexels.com/license/", label: "Pexels licence" },
  },
  {
    key: "stock-unsplash", name: "Free pictures (Unsplash)", connection: "unsplash", cost: "free", estCostMicro: 0,
    goodFor: "Finds free photos for posts, adverts and web pages.",
    costNote: "Free. No energy.",
    employees: CONTENT, dailyBudget: 600, clientDaily: 60,
    terms: "Free for commercial use. Unsplash asks that the photographer and Unsplash are credited and that the picture is shown from Unsplash's own address, so the credit line and that address are kept.",
    link: { href: "https://unsplash.com/license", label: "Unsplash licence" },
  },
];

export const tool = (key: string): ToolDef | undefined => TOOLS.find((t) => t.key === key);

const MICRO_PER_ENERGY = 1_000;

export interface ToolQuote { tool: ToolKey; units: number; baseEnergy: number; multiplier: number; energy: number }

/** What a use costs: nothing, the flat figure, or (paid per use) the plain cost times the owner's multiplier. */
export function toolQuote(t: ToolDef, multiplier: number, fallback: number, units = 1): ToolQuote {
  if (t.cost === "free") return { tool: t.key, units, baseEnergy: 0, multiplier: 1, energy: 0 };
  if (t.cost === "energy") return { tool: t.key, units, baseEnergy: t.flatEnergy ?? 1, multiplier: 1, energy: t.flatEnergy ?? 1 };
  const m = Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : fallback;
  const baseEnergy = Math.max(1, Math.ceil((t.estCostMicro * units) / MICRO_PER_ENERGY));
  return { tool: t.key, units, baseEnergy, multiplier: m, energy: Math.ceil(baseEnergy * m) };
}
