/**
 * The rules every online-shop employee works to (E-commerce manager, Dropshipping agent, Marketplace manager,
 * Shop customer care agent). One list, so the employees' instructions, their job descriptions and the tests all
 * say the same thing. Pure data and one small text check; no server imports, so the website can read it too.
 *
 * Not legal advice. It states what a UK seller usually has to follow and sends the owner to check, and to the
 * Compliance manager, wherever the rules differ by country.
 */
export const SHOP_EMPLOYEE_KEYS: readonly string[] = ["online-shop-manager", "dropshipping-agent", "marketplace-manager", "shop-care-agent"];

export const SHOP_RULES: readonly string[] = [
  "Nothing is listed, published, ordered, repriced, emailed, texted or refunded without the owner's approval. You prepare drafts and the owner decides.",
  "Never write, suggest or buy a fake review, testimonial or star rating, and never present one as coming from a customer. Never ask for reviews in return for a gift or discount.",
  "Never use a fake countdown, a fake 'only 3 left', 'selling fast' or 'people are viewing this' message. Use a stock or time claim only when the shop's own connected data shows it is true right now, and say where the figure came from.",
  "Never invent stock levels, prices, sales figures, supplier facts or delivery times. Use what is connected or what the owner told you, and say plainly what is missing.",
  "Always state a realistic delivery time. For goods sent by a supplier, give the supplier's real handling time plus its shipping time to the shopper's country as a range, and never promise a speed the supplier does not state.",
  "Never say a product does, contains or is certified for anything that the supplier's page, the maker's documents or the owner's own papers do not say. No health, safety, eco or approval claims without that evidence.",
  "A UK seller usually has to follow these rules, so build them in: shoppers can normally cancel a distance sale within 14 days of receiving the goods (some goods, such as made-to-order items, are exceptions); the total price shown includes delivery and VAT where the seller is VAT registered; the seller's name, address and contact details are clear; no fee is hidden until the last step.",
  "Product safety and labelling rules apply to everything sold. Do not help sell restricted or age-limited goods (for example weapons, alcohol, tobacco and vapes, medicines, counterfeit or 'inspired by' branded goods, or anything a marketplace bans) and tell the owner to check with the Compliance manager first.",
  "Where the rules differ by country, say so, tell the owner to check the rules for each country they sell to, and point them to the Compliance manager. You do not give legal advice.",
  "Use shoppers' personal details only for the job in hand, never copy them into a draft that leaves the workspace, and never contact a shopper yourself.",
];

export type CopyIssueKind = "urgency" | "social-proof" | "claim" | "returns";

export interface CopyIssue {
  kind: CopyIssueKind;
  /** The words found, as written. */
  found: string;
  /** What to do, in plain words. */
  advice: string;
}

const URGENCY = "False urgency: use a stock or time message only if your shop's own figures show it is true right now.";
const REVIEWS = "Invented reviews: only use reviews real customers wrote, and never write one for them.";

const CHECKS: readonly { kind: CopyIssueKind; re: RegExp; advice: string }[] = [
  { kind: "urgency", re: /\bonly\s+\d+\s+(?:items?\s+)?(?:left|remaining|in stock)\b/i, advice: URGENCY },
  { kind: "urgency", re: /\b(?:selling\s+fast|almost\s+gone|last\s+chance|hurry)\b/i, advice: URGENCY },
  { kind: "urgency", re: /\b(?:offer|sale|deal)\s+ends\s+in\b|\bcountdown\b|\b\d{1,2}:\d{2}:\d{2}\b/i, advice: URGENCY },
  { kind: "social-proof", re: /\b\d+\s+(?:people|others|shoppers|customers)\s+(?:are\s+)?(?:viewing|looking\s+at|watching)\b/i, advice: "Invented social proof: show a viewer count only if your shop really measures it." },
  { kind: "social-proof", re: /\bverified\s+(?:buyer|purchase|customer)\b|[★⭐]{3,}|\b5\s*\/\s*5\s+stars?\b/i, advice: REVIEWS },
  { kind: "social-proof", re: /["“][^"”]{12,}["”]\s*[-–—]\s*[A-Z][a-z]+/, advice: REVIEWS },
  { kind: "claim", re: /\b(?:clinically\s+proven|cures?|FDA[- ]approved|CE[- ]approved|100%\s+safe|guaranteed\s+results?)\b/i, advice: "Product claim: say only what the supplier's page or the maker's documents say." },
  { kind: "returns", re: /\b(?:no\s+returns?|no\s+refunds?|all\s+sales\s+(?:are\s+)?final|final\s+sale)\b/i, advice: "Returns: UK shoppers can normally cancel within 14 days of receiving the goods. Ask the Compliance manager to check before you say otherwise." },
];

/** Looks for the shop-copy habits that break UK consumer rules. Case and spacing do not matter. */
export function checkShopCopy(text: string): CopyIssue[] {
  const flat = text.replace(/\s+/g, " ");
  const out: CopyIssue[] = [];
  for (const c of CHECKS) {
    const m = c.re.exec(flat);
    if (m) out.push({ kind: c.kind, found: m[0].trim().slice(0, 80), advice: c.advice });
  }
  return out;
}

/** A short note to add under a draft, or undefined when the draft is clean. Each kind of problem is named once. */
export function shopCopyNote(text: string): string | undefined {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const i of checkShopCopy(text)) {
    if (seen.has(i.advice)) continue;
    seen.add(i.advice);
    lines.push(`- "${i.found}": ${i.advice}`);
  }
  if (!lines.length) return undefined;
  return ["Check before you use this. Some words in this draft can break the rules a seller has to follow:", ...lines, "If those words are only here as a warning, you can ignore this note. Ask the Compliance manager if you are unsure. This is not legal advice."].join("\n");
}
