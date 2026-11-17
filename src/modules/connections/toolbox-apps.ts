import { TOOLS } from "../toolbox/catalogue.js";
import type { ConnDef } from "./catalog.js";

/**
 * Owner cards for the platform's outside services (voice, web search, free stock pictures). Each holds one key that
 * every client's employees share, so each card says what it costs and what the clients get. What each service is good
 * for and when to prefer a cheaper way lives in the toolbox catalogue; the cards only point at it.
 */
const costOf = (key: string): string => TOOLS.find((t) => t.connection === key)?.costNote ?? "";

export const TOOLBOX_CARD_KEYS = ["elevenlabs", "brave-search", "pexels", "unsplash"] as const;

export function toolboxAppDefs(): ConnDef[] {
  return [
    {
      key: "elevenlabs", title: "Voice-overs (ElevenLabs)", group: "platform", editable: true, tier: "optional",
      summary: "Lets the Marketing manager and the Business consultant turn a script into a spoken recording for a video or a phone greeting. Paid per use, so it uses double energy.",
      usedBy: ["marketing-manager", "business-consultant"],
      clientsSee: "A voice-over they can ask for, with the cost shown before anything is made, and the recording kept as a file.",
      fields: [{ key: "apiKey", label: "API key", secret: true, required: true, placeholder: "Starts with sk_", help: "From ElevenLabs, under Developers, API keys. Give it only the Text to Speech and Voices (read) permissions." }],
      guide: [
        { text: "Open an ElevenLabs account and pick a paid plan. ElevenLabs's terms allow commercial use only on a paid plan, and MAIZ sells these recordings to clients, so the free plan is not enough.", link: { href: "https://elevenlabs.io/pricing/api", label: "ElevenLabs: prices" } },
        { text: "Open Developers, then API keys, and create a key. Restrict it to Text to Speech and read access to Voices, and set a monthly spending limit.", link: { href: "https://elevenlabs.io/app/settings/api-keys", label: "ElevenLabs: API keys" } },
        { text: "Paste the key below and click Save, then Test connection. The test lists the ready-made voices, which costs nothing." },
        { text: `${costOf("elevenlabs")} Only ElevenLabs's ready-made voices are offered. Nobody's voice is copied.` },
      ],
    },
    {
      key: "brave-search", title: "Web search (Brave Search)", group: "platform", editable: true, tier: "optional",
      summary: "Lets employees look a question up on the live web and cite every result with its address. Paid per use, so it uses double energy.",
      usedBy: ["marketing-manager", "business-consultant", "finance-manager", "compliance-manager", "hr-manager", "supply-chain-manager", "data-mining-agent"],
      clientsSee: "Research that rests on today's facts, with a link beside every claim.",
      fields: [{ key: "apiKey", label: "API key", secret: true, required: true, placeholder: "Letters and numbers", help: "From the Brave Search API dashboard, under API keys." }],
      guide: [
        { text: "Sign up for the Brave Search API and choose the Search plan. It is five US dollars for 1,000 searches, with five dollars of free credit each month. Do not choose a plan meant for training AI: MAIZ only shows results, never stores or trains on them.", link: { href: "https://brave.com/search/api/", label: "Brave Search API" } },
        { text: "Create an API key in the dashboard and paste it below. Set a monthly limit there too.", link: { href: "https://api-dashboard.search.brave.com/", label: "Brave Search API dashboard" } },
        { text: "Click Save, then Test connection. The test runs one search, which uses one of the month's free searches." },
        { text: `${costOf("brave-search")} Brave's terms do not allow keeping a copy of results, so MAIZ shows them and does not store them.` },
      ],
    },
    {
      key: "pexels", title: "Free pictures and video (Pexels)", group: "platform", editable: true, tier: "optional",
      summary: "Lets the Marketing manager find free photos and video clips that may be used commercially. Free.",
      usedBy: ["marketing-manager", "business-consultant"],
      clientsSee: "A search for free pictures and clips, each kept with its credit line.",
      fields: [{ key: "apiKey", label: "API key", secret: true, required: true, help: "From your Pexels API page. Free." }],
      guide: [
        { text: "Create a free Pexels account and request an API key. Describe MAIZ as a tool that helps small businesses find pictures for their own posts and pages.", link: { href: "https://www.pexels.com/api/", label: "Pexels API" } },
        { text: "Paste the key below, click Save, then Test connection. The default allowance is 200 searches an hour and 20,000 a month, shared by every client. Ask Pexels for more if you grow." },
        { text: "Pexels asks every app to link back to Pexels and to credit photographers. MAIZ keeps the credit line with each picture it saves. Pexels does not allow an app that simply re-offers its whole library, so MAIZ only searches and links." },
      ],
    },
    {
      key: "unsplash", title: "Free pictures (Unsplash)", group: "platform", editable: true, tier: "optional",
      summary: "Lets the Marketing manager find free photos that may be used commercially. Free.",
      usedBy: ["marketing-manager", "business-consultant"],
      clientsSee: "A search for free photos, each kept with the photographer's credit.",
      fields: [{ key: "accessKey", label: "Access key", secret: true, required: true, help: "The Access Key (not the Secret key) of your Unsplash application." }],
      guide: [
        { text: "Create a free Unsplash developer account, then a new application. Tick that you have read the API guidelines.", link: { href: "https://unsplash.com/oauth/applications", label: "Unsplash: your applications" } },
        { text: "Copy the Access Key and paste it below. A new application is in demo mode: 50 searches an hour, shared by every client. Apply for production (1,000 an hour) from the application's page once MAIZ shows pictures, with the credit line and the picture shown from Unsplash's own address." },
        { text: "Click Save, then Test connection. The test runs one search." },
      ],
    },
  ];
}
