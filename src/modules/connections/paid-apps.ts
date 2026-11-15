import { PAID_SERVICES } from "../paid-services/catalogue.js";
import type { ConnDef } from "./catalog.js";

/**
 * Cards for paid services (video templates). The two we call (Creatomate, Shotstack) take an API key in the browser.
 * The others have nothing to paste: their card says honestly what exists and how to use them by hand meanwhile.
 */
export const PAID_KEY_CARDS = ["creatomate", "shotstack"] as const;
export type PaidKeyCard = (typeof PAID_KEY_CARDS)[number];

const ENERGY_RULE = "Each video costs money, so it uses double energy by default (you set the figure once on the Prices page). The cost is always shown before anything runs.";

export function paidAppDefs(): ConnDef[] {
  return PAID_SERVICES.map((s): ConnDef => s.kind === "api"
    ? {
        key: s.key, title: `${s.name} (video templates)`, group: "social", editable: true,
        summary: `${s.summary} Until a key is saved, videos are practice renders that cost nothing.`,
        usedBy: ["promotion-agent"],
        fields: [{ key: "apiKey", label: "API key", secret: true, required: true, help: `From your ${s.name} account. Stored encrypted and never shown again.` }],
        guide: [
          { text: `Open a ${s.name} account, design or pick a template there, and copy the template's id. You give that id to the agent when you ask for a video.`, link: s.link },
          { text: `Find the API key in your ${s.name} project or account settings and paste it below. Set a spending limit or a small plan in ${s.name} first.` },
          { text: "Click Save, then Test connection. The test lists your templates, which renders nothing and costs nothing." },
          { text: `${ENERGY_RULE} ${s.note}` },
        ],
      }
    : {
        key: s.key, title: `${s.name} (${s.kind === "guide" ? "stock library, used by hand" : "not built yet"})`, group: "platform", editable: false,
        summary: `${s.summary} ${s.note}`,
        usedBy: ["promotion-agent"],
        fields: [],
        guide: [{ text: s.kind === "guide" ? "Nothing to connect. Your agent can suggest what to look for; you download and license the item yourself." : "Nothing to paste here yet. Make the video in the editor and paste its link into the draft.", link: s.link }, { text: "If this service opens an interface we can use, this card gets a key box. Nothing for you to do until then." }],
      });
}

export const isPaidListing = (key: string): boolean => PAID_SERVICES.some((s) => s.key === key && s.kind !== "api");
