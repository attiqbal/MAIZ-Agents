import { defaultRegistry } from "../integrations/catalogue.js";
import type { Connector } from "../integrations/types.js";
import type { ConnDef, FieldDef, GuideStep } from "./catalog.js";
import { listedTier } from "./listed-apps.js";

/**
 * One owner card per client app, made from the integrations registry so adding a connector never needs a hand-written
 * card. An OAuth app gets the Client ID and secret boxes (clients then connect with one click); an app that needs the
 * provider's approval first gets a card that carries the application steps and the usual wait.
 */
export const REDIRECT_PATH = "/api/integrations/callback";
/** Apps whose cards already exist by hand (Xero, Square) or share the Google data card (Analytics, Search Console). */
const HAS_OWN_CARD = new Set(["xero", "square", "ga4", "search-console"]);

const steps = (c: Connector): GuideStep[] => {
  const out: GuideStep[] = (c.setup?.steps ?? []).map((text, i) => (i === 0 && c.setup ? { text, link: c.setup.console } : { text }));
  if (c.setup?.approval) out.push({ text: `Approval: ${c.setup.approval}` });
  return out;
};

/** The environment variable behind an extra owner box, for example GOOGLEADS_DEVELOPER_TOKEN. */
export const extraEnvName = (prefix: string, key: string): string => `${prefix}_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

const ownerBoxes = (c: Connector): FieldDef[] => (c.ownerFields ?? []).map((f) => ({ key: f.key, label: f.label, help: f.help, secret: f.secret, required: f.required, placeholder: f.placeholder }));

/** One honest line on what state the app is in, shown in the card's title and summary. */
const WAITING = "ready, waiting for the provider's approval of your app";

export function clientAppDefs(builtInKeys: readonly string[], connectors: readonly Connector[] = defaultRegistry().list()): ConnDef[] {
  const taken = new Set(builtInKeys);
  const out: ConnDef[] = [];
  for (const c of connectors) {
    if (HAS_OWN_CARD.has(c.key) || taken.has(c.key) || (!c.setup && !c.unavailable)) continue;
    if (c.auth.kind === "oauth2") {
      const waiting = c.availability === "approval";
      out.push({
        key: c.key, title: waiting ? `${c.name} (${WAITING})` : c.name, group: "clients", editable: true, tier: listedTier(c.key),
        summary: `${waiting ? "Built and ready. Paste the details once the provider has approved your app; until then only your own account and testers can connect. " : ""}Lets your clients connect ${c.name} with one click. ${c.summary}`,
        usedBy: [],
        clientsSee: `A Connect button for ${c.name} on their Apps page.`,
        copies: [{ label: "Redirect URI", path: REDIRECT_PATH }],
        fields: [
          { key: "clientId", label: "Client ID", secret: false, required: true, help: `From your ${c.name} developer app.` },
          { key: "clientSecret", label: "Client secret", secret: true, required: true, help: "Shown once in the provider's console. Copy it in full." },
          ...ownerBoxes(c),
        ],
        guide: [
          ...steps(c),
          { text: "Click Save, then Test connection. The test offers the provider a made-up sign-in code, so nothing is created. The real test is connecting one account yourself from the Apps page." },
        ],
      });
    } else if (c.unavailable) {
      out.push({
        key: c.key, title: `${c.name} (cannot be connected)`, group: "clients", editable: false, tier: "optional",
        summary: `${c.summary} ${c.unavailable}`,
        usedBy: [],
        clientsSee: `${c.name} appears on the Apps page with a Zapier or Make link.`,
        fields: [],
        guide: [{ text: c.unavailable }, ...(c.setup ? [{ text: c.setup.steps[0] ?? "", link: c.setup.console }] : [{ text: "Nothing to do here." }])],
      });
    } else if (c.availability === "approval") {
      out.push({
        key: c.key, title: `${c.name} (needs approval)`, group: "clients", editable: false,
        summary: `${c.summary} ${c.note ?? ""}`.replace(/\s+Until then, connect it through Zapier or Make\./, "").trim(),
        usedBy: [],
        clientsSee: `${c.name} appears on the Apps page as coming soon, with a Zapier or Make link, until it is approved.`,
        fields: [],
        guide: [
          ...steps(c),
          { text: "Nothing to paste here yet: the connector for this app is written once the provider approves MAIZ. Tell us the day it is approved." },
        ],
      });
    }
  }
  return out;
}

/** The environment variable names behind an OAuth card's two boxes (OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET). */
export function clientAppEnv(connectors: readonly Connector[] = defaultRegistry().list()): Record<string, { clientId: string; clientSecret: string; extra: Record<string, string> }> {
  const out: Record<string, { clientId: string; clientSecret: string; extra: Record<string, string> }> = {};
  for (const c of connectors) {
    if (c.auth.kind !== "oauth2" || !c.setup || HAS_OWN_CARD.has(c.key)) continue;
    const prefix = c.auth.envPrefix;
    out[c.key] = { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET`, extra: Object.fromEntries((c.ownerFields ?? []).map((f) => [f.key, extraEnvName(prefix, f.key)])) };
  }
  return out;
}
