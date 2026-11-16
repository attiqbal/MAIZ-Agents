import { defaultRegistry } from "../integrations/catalogue.js";
import { PAID_SERVICES } from "../paid-services/catalogue.js";
import type { ConnDef } from "./catalog.js";

/**
 * How much the site depends on each connection, so the owner knows which to set up first, and how each one is
 * connected. Pure data plus two small rules: the Connections page shows what these return and never keeps its own
 * list of keys. A definition that sets `tier` itself always wins; the table below covers the built-in services, and
 * everything else gets a default from the kind of service it is.
 */
export type Tier = "critical" | "must" | "optional";
/** editable: typed in the browser. server: set on the server. approval: the provider must approve MAIZ first. manual: nothing to connect. */
export type Mode = "editable" | "server" | "approval" | "manual";
export interface TierInfo { tier: Tier; why: string }

export const TIER_ORDER: readonly Tier[] = ["critical", "must", "optional"];
export const TIER_LABEL: Record<Tier, string> = { critical: "Critical", must: "Must have", optional: "Optional" };
export const TIER_ABOUT: Record<Tier, string> = {
  critical: "The site cannot do its basic job without these.",
  must: "A main feature your clients are promised depends on each of these.",
  optional: "Useful extras. The site works without them.",
};

const BUILT_IN_TIERS: Record<string, TierInfo> = {
  stripe: { tier: "critical", why: "Without this, nobody can pay." },
  runpod: { tier: "critical", why: "Without this, your AI employees have no engine to do their work." },
  anthropic: { tier: "critical", why: "Without this, nothing checks the AI's work before a client sees it." },
  resend: { tier: "critical", why: "Without this, log-in links and receipts are never sent." },
  google: { tier: "must", why: "Needed for clients to log in with Google." },
  microsoft: { tier: "must", why: "Needed for clients to log in with Microsoft." },
  slack: { tier: "must", why: "Needed for clients to talk to their AI team in Slack, which the site promises." },
  xero: { tier: "must", why: "Needed for the Finance manager to read a client's books from Xero." },
  quickbooks: { tier: "must", why: "Needed for the Finance manager to read a client's books from QuickBooks." },
  "google-data": { tier: "must", why: "Needed for the Marketing manager's weekly growth report." },
  square: { tier: "optional", why: "Only clients with a Square till need it. Others can upload their sales." },
  facebook: { tier: "optional", why: "Only your own promotion agent uses it. Clients are not affected." },
  instagram: { tier: "optional", why: "Only your own promotion agent uses it. Clients are not affected." },
  whatsapp: { tier: "optional", why: "A faster way for you to approve things. Email and the website still work." },
  reddit: { tier: "optional", why: "One more source for Market data. It works without it." },
  youtube: { tier: "optional", why: "One more source for Market data. It works without it." },
  x: { tier: "optional", why: "One more source for Market data, and it costs money. It works without it." },
  fred: { tier: "optional", why: "Extra economic figures for your own team. Nothing else depends on it." },
  alphavantage: { tier: "optional", why: "Share prices for Market data. It works without it." },
  companieshouse: { tier: "optional", why: "UK company records for Market data. It works without it." },
};

const isManual = (def: ConnDef): boolean => PAID_SERVICES.some((s) => s.key === def.key && s.kind !== "api") || /\((?:[^)]*used by hand|not built yet)\)/i.test(def.title);

/** How this service is connected. Anything that cannot be typed here and is not a platform service waits for approval. */
export function modeOf(def: ConnDef): Mode {
  if (def.editable) return "editable";
  if (isManual(def)) return "manual";
  if (defaultRegistry().get(def.key)?.availability === "approval" || /\(needs approval\)/i.test(def.title)) return "approval";
  return def.group === "platform" ? "server" : "approval";
}

function defaultWhy(def: ConnDef, tier: Tier, mode: Mode): string {
  if (tier === "critical") return "The site cannot do its basic job without this.";
  if (tier === "must") return "A main feature depends on this.";
  if (mode === "manual") return "Nothing to connect. Your team uses it by hand.";
  if (mode === "approval") return "Clients cannot connect it until the provider approves MAIZ. They can use Zapier or Make meanwhile.";
  if (def.group === "clients") return "One more app your clients can connect. Only clients who use it need it.";
  if (def.group === "platform") return "An extra for your team. The site works without it.";
  return "Only your own team uses it. Clients are not affected.";
}

/** The tier and the one-line reason for any definition, built-in or generated. */
export function tierOf(def: ConnDef): TierInfo {
  const own = BUILT_IN_TIERS[def.key];
  if (def.tier) return { tier: def.tier, why: own?.tier === def.tier ? own.why : defaultWhy(def, def.tier, modeOf(def)) };
  if (own) return own;
  return { tier: "optional", why: defaultWhy(def, "optional", modeOf(def)) };
}
