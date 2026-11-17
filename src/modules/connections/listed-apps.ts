import type { ConnDef } from "./catalog.js";

/**
 * How much the site depends on each service whose card is made from the integrations list (see client-apps.ts).
 * critical: the site cannot work properly without it. must: needed for a main feature. optional: nice to have.
 * Anything not listed here is optional: a client can always use Zapier or Make instead.
 */
const TIERS: Record<string, NonNullable<ConnDef["tier"]>> = {
  hubspot: "must", salesforce: "must", quickbooks: "must", outlook: "must", gmail: "must",
  "google-business-profile": "must", "meta-ads": "must", "google-ads": "must", trustpilot: "optional",
  "linkedin-pages": "optional", tiktok: "optional", pinterest: "optional",
  "amazon-seller": "optional", etsy: "optional", ebay: "optional", docusign: "optional", canva: "optional",
};

export const listedTier = (key: string): NonNullable<ConnDef["tier"]> => TIERS[key] ?? "optional";
