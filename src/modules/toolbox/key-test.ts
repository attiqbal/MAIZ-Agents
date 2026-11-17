import { braveSearch, elevenKeyWorks, pexelsSearch, unsplashSearch } from "./providers.js";

/** One small, harmless read with a service's key. Voice only lists voices (free); search spends one of the month's searches. */
export async function toolKeyTest(http: typeof fetch, key: string, secret: string): Promise<{ ok: boolean; message: string; details: string[] }> {
  switch (key) {
    case "elevenlabs": {
      const n = await elevenKeyWorks(http, secret);
      return { ok: true, message: `ElevenLabs accepted the key and offers ${n} ready-made voices.`, details: ["The test listed voices. Nothing was recorded and nothing was spent. Whether your plan allows commercial use is only known from your ElevenLabs account."] };
    }
    case "brave-search": {
      const r = await braveSearch(http, secret, { query: "coffee" });
      return { ok: true, message: `Brave Search accepted the key and answered with ${r.length} results.`, details: ["The test used one search, which comes out of your free monthly credit."] };
    }
    case "pexels": {
      const r = await pexelsSearch(http, secret, "photo", "coffee");
      return { ok: true, message: `Pexels accepted the key and answered with ${r.length} pictures.`, details: ["The test ran one search."] };
    }
    default: {
      const r = await unsplashSearch(http, secret, "coffee");
      return { ok: true, message: `Unsplash accepted the key and answered with ${r.length} photos.`, details: ["The test ran one search. A new application is in demo mode (50 an hour) until Unsplash approves it for production."] };
    }
  }
}
