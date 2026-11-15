import { defaultRegistry } from "../integrations/catalogue.js";
import type { Connector } from "../integrations/types.js";
import type { ConnDef, GuideStep } from "./catalog.js";

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

export function clientAppDefs(builtInKeys: readonly string[], connectors: readonly Connector[] = defaultRegistry().list()): ConnDef[] {
  const taken = new Set(builtInKeys);
  const out: ConnDef[] = [];
  for (const c of connectors) {
    if (HAS_OWN_CARD.has(c.key) || taken.has(c.key) || !c.setup) continue;
    if (c.auth.kind === "oauth2") {
      out.push({
        key: c.key, title: c.name, group: "clients", editable: true,
        summary: `Lets your clients connect ${c.name} with one click. ${c.summary}`,
        usedBy: [],
        clientsSee: `A Connect button for ${c.name} on their Apps page.`,
        copies: [{ label: "Redirect URI", path: REDIRECT_PATH }],
        fields: [
          { key: "clientId", label: "Client ID", secret: false, required: true, help: `From your ${c.name} developer app.` },
          { key: "clientSecret", label: "Client secret", secret: true, required: true, help: "Shown once in the provider's console. Copy it in full." },
        ],
        guide: [
          ...steps(c),
          { text: "Click Save, then Test connection. The test offers the provider a made-up sign-in code, so nothing is created. The real test is connecting one account yourself from the Apps page." },
        ],
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
export function clientAppEnv(connectors: readonly Connector[] = defaultRegistry().list()): Record<string, { clientId: string; clientSecret: string }> {
  const out: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const c of connectors) if (c.auth.kind === "oauth2" && c.setup && !HAS_OWN_CARD.has(c.key)) out[c.key] = { clientId: `${c.auth.envPrefix}_CLIENT_ID`, clientSecret: `${c.auth.envPrefix}_CLIENT_SECRET` };
  return out;
}
