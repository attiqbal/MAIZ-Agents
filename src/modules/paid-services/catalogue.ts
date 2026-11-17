/**
 * Services that cost MAIZ money each time they run, starting with video rendering from templates.
 * Pure data (the website imports it too): no server code in this file.
 *
 * - "api": we call it. With no key on the Connections page it runs as a practice render (nothing is charged).
 * - "listed": has a public interface we have not built yet, or only for approved partners. Shown honestly with the link.
 * - "guide": a library or editor a person uses by hand (stock templates). We never download or resell anything from it.
 * Facts checked 2026-11 against each vendor's developer pages; re-check before building a connector.
 */
export type PaidKind = "api" | "listed" | "guide";

export interface PaidService {
  key: string;
  name: string;
  kind: PaidKind;
  summary: string;
  /** Honest note shown next to the service. */
  note: string;
  link?: { href: string; label: string };
  /** What one use costs us in micro-dollars (1,000 = $0.001, one energy before the multiplier). An estimate for the quote. */
  estCostMicro?: number;
  /** The Connections page card that holds its key (api services only). */
  connection?: "creatomate" | "shotstack";
}

export const PAID_SERVICES: readonly PaidService[] = [
  {
    key: "creatomate", name: "Creatomate", kind: "api", connection: "creatomate", estCostMicro: 100_000,
    summary: "Fills a video template you designed in Creatomate with the text and pictures your agent chooses, and renders the video.",
    note: "Needs a Creatomate API key and a template id from your Creatomate account. The cost is an estimate (about 10 US cents a video): your invoice from Creatomate is the real figure.",
    link: { href: "https://creatomate.com/docs/api/introduction", label: "Creatomate API" },
  },
  {
    key: "shotstack", name: "Shotstack", kind: "api", connection: "shotstack", estCostMicro: 200_000,
    summary: "Fills a Shotstack template with your agent's text and pictures and renders the video.",
    note: "Needs a Shotstack API key and a template id. The cost is an estimate (about 20 US cents for a short video): your invoice from Shotstack is the real figure.",
    link: { href: "https://shotstack.io/docs/guide/", label: "Shotstack docs" },
  },
  {
    key: "canva", name: "Canva", kind: "listed",
    summary: "Brand templates and designs in Canva.",
    note: "Canva's Connect API can read your design list (built: see the Canva card on the Connections page). Not built: filling brand templates is a separate Canva feature that, as far as we know, is for Canva Enterprise accounts. Make the video in Canva and paste its link into the draft.",
    link: { href: "https://www.canva.dev/docs/connect/", label: "Canva Connect API" },
  },
  {
    key: "adobe-express", name: "Adobe Express", kind: "listed",
    summary: "Templates and quick video in Adobe Express.",
    note: "Adobe offers add-on and embed tools for Express; we have not found a server-side way to render a template for you. Not built. Use the editor by hand.",
    link: { href: "https://developer.adobe.com/express/", label: "Adobe Express for developers" },
  },
  {
    key: "veed", name: "VEED", kind: "listed",
    summary: "Editing, subtitles and AI video in VEED.",
    note: "VEED now has a self-serve API, but it is built for subtitles and AI video, not template filling. Not built yet. Use the editor by hand.",
    link: { href: "https://www.veed.io/newsroom/veed-is-now-api-self-serve", label: "VEED API" },
  },
  {
    key: "kapwing", name: "Kapwing", kind: "listed",
    summary: "Online video editor with templates.",
    note: "We could not confirm a public render API for Kapwing. Not built. Use the editor by hand and paste the link.",
    link: { href: "https://www.kapwing.com/", label: "Kapwing" },
  },
  {
    key: "invideo", name: "InVideo", kind: "listed",
    summary: "AI video maker with templates.",
    note: "We could not confirm a public API for InVideo. Not built. Use the editor by hand and paste the link.",
    link: { href: "https://invideo.io/", label: "InVideo" },
  },
  {
    key: "envato", name: "Envato Elements", kind: "guide",
    summary: "Stock video templates, music and footage by subscription.",
    note: "A person downloads and licenses each item for a project. The agent only lists ideas and links; it never downloads or re-shares Envato files.",
    link: { href: "https://elements.envato.com/", label: "Envato Elements" },
  },
  {
    key: "motion-array", name: "Motion Array", kind: "guide",
    summary: "Stock video templates, music and footage by subscription.",
    note: "A person downloads and licenses each item for a project. The agent only lists ideas and links; it never downloads or re-shares Motion Array files.",
    link: { href: "https://motionarray.com/", label: "Motion Array" },
  },
];

export const DEFAULT_PAID_MULTIPLIER = 2;

export function paidService(key: string): PaidService | undefined {
  return PAID_SERVICES.find((s) => s.key === key);
}

export interface PaidQuote {
  service: string;
  /** Energy the call would cost without the paid-service rule (its real cost). */
  baseEnergy: number;
  multiplier: number;
  /** What the client is charged: base energy times the multiplier, rounded up. */
  energy: number;
}

const MICRO_PER_ENERGY = 1_000;

/** Pure sum shown to the client before anything runs. */
export function quoteFor(service: PaidService, multiplier: number, units = 1): PaidQuote {
  const baseEnergy = Math.max(1, Math.ceil(((service.estCostMicro ?? 0) * units) / MICRO_PER_ENERGY));
  const m = Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : DEFAULT_PAID_MULTIPLIER;
  return { service: service.key, baseEnergy, multiplier: m, energy: Math.ceil(baseEnergy * m) };
}
