/**
 * The calls to each outside service. Every one goes to a fixed address, refuses redirects (a key must only ever reach
 * the address we chose), has a time limit, and turns the provider's answer into a plain message with no key in it.
 * Endpoints and fields were checked against each provider's own documentation on 2026-11-16 (docs/NEW-SERVICES.md).
 * None of this has been run against the real services from this code.
 */
export class ToolError extends Error {}

const TIMEOUT_MS = 20_000;
const AUDIO_TIMEOUT_MS = 60_000;
const ELEVEN = "https://api.elevenlabs.io";
const BRAVE = "https://api.search.brave.com/res/v1/web/search";
const PEXELS = "https://api.pexels.com/v1";
const UNSPLASH = "https://api.unsplash.com";
/** The voice model. Multilingual v2 is the documented default; its price is in catalogue.ts. */
export const VOICE_MODEL = "eleven_multilingual_v2";
/** Speech at 32 kbit/s is clear for a voice and keeps a two-minute recording near half a megabyte. */
export const VOICE_FORMAT = "mp3_22050_32";
export const MAX_AUDIO_BYTES = 700_000;
export const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

async function send(http: typeof fetch, name: string, url: string, init: RequestInit, timeout = TIMEOUT_MS): Promise<Response> {
  let res: Response;
  try {
    res = await http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new ToolError(`${name} could not be reached. No energy was used. Try again in a minute.`);
  }
  if (res.status === 401 || res.status === 403) throw new ToolError(`${name} did not accept the key. MAIZ has to check it on the Connections page.`);
  if (res.status === 402) throw new ToolError(`${name} says the account is out of credit.`);
  if (res.status === 429) throw new ToolError(`${name} is busy or today's allowance is used. Try again later.`);
  if (!res.ok) throw new ToolError(`${name} refused the request (error ${res.status}).`);
  return res;
}

async function getJson(http: typeof fetch, name: string, url: string, headers: Record<string, string>): Promise<any> {
  const res = await send(http, name, url, { headers: { accept: "application/json", ...headers } });
  try { return await res.json(); } catch { throw new ToolError(`${name} sent an answer we could not read.`); }
}

/** One line of plain text: no control characters, no angle brackets or quotes that could break out of where it is shown. */
export function plain(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/<[^>]{0,200}>/g, " ").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿<>`\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
/** An https address on one of the hosts we expect, or undefined. */
export function httpsOn(v: unknown, hosts: RegExp, max = 500): string | undefined {
  if (typeof v !== "string" || v.length > max || /[\s<>"'`\\]/.test(v)) return undefined;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && hosts.test(u.hostname) ? u.toString() : undefined; } catch { return undefined; }
}
const anyHttps = (v: unknown): string | undefined => httpsOn(v, /^[a-z0-9.-]+\.[a-z]{2,}$/i, 400);

// ---------- ElevenLabs: voices and text to speech ----------

export interface Voice { id: string; name: string; description: string; previewUrl?: string }

/** The ready-made voices only (category premade): cloned and community voices are left out on purpose. */
export async function elevenVoices(http: typeof fetch, apiKey: string): Promise<Voice[]> {
  const body = await getJson(http, "ElevenLabs", `${ELEVEN}/v2/voices?page_size=100&category=premade&include_total_count=false`, { "xi-api-key": apiKey });
  const rows: unknown[] = Array.isArray(body?.voices) ? body.voices : [];
  return rows.flatMap((r: any): Voice[] => {
    if (typeof r?.voice_id !== "string" || !VOICE_ID.test(r.voice_id) || (r.category !== undefined && r.category !== "premade")) return [];
    const labels = r.labels && typeof r.labels === "object" ? Object.values(r.labels as Record<string, unknown>).map((x) => plain(x, 30)).filter(Boolean).slice(0, 4).join(", ") : "";
    const previewUrl = anyHttps(r.preview_url);
    return [{ id: r.voice_id, name: plain(r.name, 60) || "Voice", description: plain(r.description, 160) || labels, ...(previewUrl ? { previewUrl } : {}) }];
  }).slice(0, 100);
}

/** One recording. The answer is the audio itself; anything else is refused before any energy is kept. */
export async function elevenSpeak(http: typeof fetch, apiKey: string, input: { voiceId: string; text: string }): Promise<Buffer> {
  if (!VOICE_ID.test(input.voiceId)) throw new ToolError("pick one of the voices in the list");
  const res = await send(http, "ElevenLabs", `${ELEVEN}/v1/text-to-speech/${input.voiceId}?output_format=${VOICE_FORMAT}`, {
    method: "POST", headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: input.text, model_id: VOICE_MODEL }),
  }, AUDIO_TIMEOUT_MS);
  let audio: Buffer;
  try { audio = Buffer.from(await res.arrayBuffer()); } catch { throw new ToolError("ElevenLabs sent a recording we could not read."); }
  if (audio.length < 100 || audio.length > MAX_AUDIO_BYTES || /json|text/i.test(res.headers.get("content-type") ?? "")) throw new ToolError("ElevenLabs did not send a recording.");
  return audio;
}

export async function elevenKeyWorks(http: typeof fetch, apiKey: string): Promise<number> {
  return (await elevenVoices(http, apiKey)).length;
}

// ---------- Brave Search ----------

export interface SearchResult { title: string; url: string; snippet: string }
export const MAX_RESULTS = 8;

export async function braveSearch(http: typeof fetch, apiKey: string, input: { query: string; country?: string }): Promise<SearchResult[]> {
  const q = new URLSearchParams({ q: input.query, count: String(MAX_RESULTS), safesearch: "strict" });
  if (input.country && /^[A-Za-z]{2}$/.test(input.country)) q.set("country", input.country.toUpperCase());
  const body = await getJson(http, "Brave Search", `${BRAVE}?${q}`, { "x-subscription-token": apiKey });
  const rows: unknown[] = Array.isArray(body?.web?.results) ? body.web.results : [];
  return rows.flatMap((r: any): SearchResult[] => {
    const url = anyHttps(r?.url), title = plain(r?.title, 160);
    return url && title ? [{ title, url, snippet: plain(r?.description, 300) }] : [];
  }).slice(0, MAX_RESULTS);
}

// ---------- Stock pictures and video ----------

export type StockKind = "photo" | "video";
export interface StockItem {
  /** Stable id: provider, kind and the provider's own id. */
  id: string;
  provider: "pexels" | "unsplash";
  kind: StockKind;
  description: string;
  /** The item's own page at the provider (where the credit links to). */
  pageUrl: string;
  /** The file to show or hand to a video or design tool, at the provider's own address. */
  fileUrl: string;
  thumbUrl?: string;
  /** The credit line to show beside it. */
  credit: string;
  creditUrl?: string;
  licence: string;
}

const PEXELS_HOSTS = /(^|\.)pexels\.com$/i;
const UNSPLASH_HOSTS = /(^|\.)unsplash\.com$/i;
export const STOCK_PER_PAGE = 12;
const PEXELS_LICENCE = "Pexels licence: free to use, also commercially. Credit not required but appreciated.";
const UNSPLASH_LICENCE = "Unsplash licence: free to use, also commercially. Credit the photographer and Unsplash, and show it from Unsplash's address.";

export async function pexelsSearch(http: typeof fetch, apiKey: string, kind: StockKind, query: string): Promise<StockItem[]> {
  const q = new URLSearchParams({ query, per_page: String(STOCK_PER_PAGE) });
  const body = await getJson(http, "Pexels", `${PEXELS}/${kind === "video" ? "videos/search" : "search"}?${q}`, { authorization: apiKey });
  const rows: unknown[] = Array.isArray(kind === "video" ? body?.videos : body?.photos) ? (kind === "video" ? body.videos : body.photos) : [];
  return rows.flatMap((r: any): StockItem[] => {
    const pageUrl = httpsOn(r?.url, PEXELS_HOSTS);
    const files: any[] = Array.isArray(r?.video_files) ? r.video_files : [];
    // The smallest HD file is plenty for a social post and quick to load.
    const video = files.filter((f) => f?.file_type === "video/mp4" && httpsOn(f?.link, PEXELS_HOSTS)).sort((a, b) => Math.abs((Number(a.width) || 0) - 1280) - Math.abs((Number(b.width) || 0) - 1280))[0];
    const fileUrl = kind === "video" ? httpsOn(video?.link, PEXELS_HOSTS) : httpsOn(r?.src?.large, PEXELS_HOSTS);
    const who = plain(kind === "video" ? r?.user?.name : r?.photographer, 80);
    if (!pageUrl || !fileUrl || !Number.isSafeInteger(r?.id)) return [];
    const thumbUrl = httpsOn(kind === "video" ? r?.image : r?.src?.medium, PEXELS_HOSTS);
    const creditUrl = httpsOn(kind === "video" ? r?.user?.url : r?.photographer_url, PEXELS_HOSTS);
    return [{ id: `pexels-${kind}-${r.id}`, provider: "pexels", kind, description: plain(r?.alt, 160) || `${kind === "video" ? "Video" : "Photo"} from Pexels`, pageUrl, fileUrl, ...(thumbUrl ? { thumbUrl } : {}), credit: `${kind === "video" ? "Video" : "Photo"} by ${who || "a Pexels contributor"} on Pexels`, ...(creditUrl ? { creditUrl } : {}), licence: PEXELS_LICENCE }];
  });
}

const UTM = "utm_source=maiz_agents&utm_medium=referral";
const withUtm = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}${UTM}`;

export async function unsplashSearch(http: typeof fetch, accessKey: string, query: string): Promise<StockItem[]> {
  const q = new URLSearchParams({ query, per_page: String(STOCK_PER_PAGE), content_filter: "high" });
  const body = await getJson(http, "Unsplash", `${UNSPLASH}/search/photos?${q}`, { authorization: `Client-ID ${accessKey}`, "accept-version": "v1" });
  const rows: unknown[] = Array.isArray(body?.results) ? body.results : [];
  return rows.flatMap((r: any): StockItem[] => {
    const pageUrl = httpsOn(r?.links?.html, UNSPLASH_HOSTS), fileUrl = httpsOn(r?.urls?.regular, UNSPLASH_HOSTS);
    if (!pageUrl || !fileUrl || typeof r?.id !== "string" || !/^[\w-]{4,40}$/.test(r.id)) return [];
    const thumbUrl = httpsOn(r?.urls?.small, UNSPLASH_HOSTS), creditUrl = httpsOn(r?.user?.links?.html, UNSPLASH_HOSTS);
    return [{ id: `unsplash-photo-${r.id}`, provider: "unsplash", kind: "photo", description: plain(r?.alt_description ?? r?.description, 160) || "Photo from Unsplash", pageUrl: withUtm(pageUrl), fileUrl, ...(thumbUrl ? { thumbUrl } : {}), credit: `Photo by ${plain(r?.user?.name, 80) || "an Unsplash photographer"} on Unsplash`, ...(creditUrl ? { creditUrl: withUtm(creditUrl) } : {}), licence: UNSPLASH_LICENCE }];
  });
}

/** Unsplash asks to be told each time a photo is really used. Best effort: a failure never blocks the client. */
export async function unsplashUsed(http: typeof fetch, accessKey: string, itemId: string): Promise<void> {
  const id = /^unsplash-photo-([\w-]{4,40})$/.exec(itemId)?.[1];
  if (!id) return;
  try { await send(http, "Unsplash", `${UNSPLASH}/photos/${id}/download`, { headers: { authorization: `Client-ID ${accessKey}`, "accept-version": "v1" } }); } catch { /* counted on their side only */ }
}
