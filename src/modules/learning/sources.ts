import { cleanLine, normal } from "./derive.js";
import type { FactKind, FactSource } from "./index.js";

/**
 * Where profile lines come from. Every function is plain rules over data the business already gave us (signup answers,
 * its website's public home page, the apps it connected, what it keeps asking for). No AI call, no new data collected.
 */
export interface Found { kind: FactKind; text: string; source: FactSource }

const list = (items: readonly string[]): string => items.join(", ");

export function factsFromSignup(a: { sells?: string; website?: string; sectorLabel?: string; country?: string; size?: string; needs?: readonly string[]; apps?: readonly string[] }): Found[] {
  const out: Found[] = [];
  if (a.sells) out.push({ kind: "about", text: `Sells: ${cleanLine(a.sells, 160)}`, source: "signup" });
  if (a.sectorLabel) out.push({ kind: "about", text: `Kind of business: ${a.sectorLabel}`, source: "signup" });
  if (a.website) out.push({ kind: "about", text: `Website: ${cleanLine(a.website, 100)}`, source: "signup" });
  if (a.size) out.push({ kind: "how", text: `Team size: ${a.size}`, source: "signup" });
  if (a.needs?.length) out.push({ kind: "how", text: `Wants help with: ${list(a.needs.slice(0, 8))}`, source: "signup" });
  if (a.apps?.length) out.push({ kind: "tool", text: `Uses: ${list(a.apps.slice(0, 8))}`, source: "signup" });
  return out;
}

/** What the business's own home page says about it. The reading is already clipped plain text. */
export function factsFromWebsite(r: { about?: string; apps?: readonly string[]; socials?: readonly string[] }): Found[] {
  const out: Found[] = [];
  if (r.about) out.push({ kind: "about", text: `Its website says: ${cleanLine(r.about, 200)}`, source: "website" });
  if (r.apps?.length) out.push({ kind: "tool", text: `Its website runs on: ${list(r.apps.slice(0, 8))}`, source: "website" });
  if (r.socials?.length) out.push({ kind: "tool", text: `Active on: ${list(r.socials.slice(0, 8))}`, source: "website" });
  return out;
}

export function factsFromProfile(p: { tone?: string; audience?: string } | undefined): Found[] {
  const out: Found[] = [];
  if (p?.tone) out.push({ kind: "tone", text: `Wants the team to sound: ${cleanLine(p.tone, 80)}`, source: "signup" });
  if (p?.audience) out.push({ kind: "about", text: `Customers: ${cleanLine(p.audience, 160)}`, source: "signup" });
  return out;
}

export function factsFromConnections(appNames: readonly string[]): Found[] {
  return appNames.length ? [{ kind: "tool", text: `Connected apps: ${list([...new Set(appNames)].slice(0, 12))}`, source: "connection" }] : [];
}

/** Things asked again and again (three or more times, near the same words) are a recurring job. */
export function factsFromAsks(asked: readonly string[]): Found[] {
  const groups = new Map<string, { n: number; sample: string }>();
  for (const q of asked) {
    const key = normal(q).split(" ").slice(0, 4).join(" ");
    if (key.length < 8) continue;
    const g = groups.get(key);
    groups.set(key, { n: (g?.n ?? 0) + 1, sample: g?.sample ?? q });
  }
  return [...groups.values()].filter((g) => g.n >= 3).sort((a, b) => b.n - a.n).slice(0, 3)
    .map((g) => ({ kind: "recurring" as const, text: `Often asks for: "${cleanLine(g.sample, 90)}" (${g.n} times)`, source: "activity" as const }));
}
