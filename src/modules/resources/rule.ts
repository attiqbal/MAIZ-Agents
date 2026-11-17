import type { CostClass, Resource } from "./types.js";

/**
 * The one rule for choosing how to get something done, cheapest first. Pure and deterministic: the same resources and
 * the same need always give the same choice, so it can be tested and the employee's brief can state it.
 *
 *  1. What is already known (figures read from connected apps, saved datasets, the business profile).
 *  2. Free answers worked out from the records.
 *  3. Energy: the open models, and free public sources that use a small flat figure.
 *  4. Double energy: an outside service that charges each time. Only when the task truly needs it, only when nothing
 *     cheaper gives the same thing, and always with the cost shown and confirmed first.
 *  5. Money (hiring someone new) is never chosen for the client: it is only ever suggested.
 *
 * Prices are not set here. The figures come from the modules that own them.
 */
export const COST_ORDER: readonly CostClass[] = ["known", "free", "energy", "double_energy", "money"];

export const costRank = (c: CostClass): number => COST_ORDER.indexOf(c);

/** Classes that are paid per use or in money: never picked unless the task truly needs them. */
export const isPaidClass = (c: CostClass): boolean => c === "double_energy" || c === "money";

/** Cheapest first: by class, then by the energy figure, then by key so the order never depends on input order. */
export function byCost(a: Resource, b: Resource): number {
  return costRank(a.cost.class) - costRank(b.cost.class) || (a.cost.energy ?? 0) - (b.cost.energy ?? 0) || a.key.localeCompare(b.key);
}

export interface Need {
  /** What is wanted, as one of the tags resources give ("sales", "public-opinion", "video"). */
  tag: string;
  /** True when the task cannot be done without it. A paid service is only ever chosen for an essential need. */
  essential?: boolean;
}

export type SkipReason = "not_allowed" | "not_ready" | "cheaper_exists" | "not_essential" | "money_needs_the_owner";

export interface Choice {
  /** The resource to use, or undefined when nothing usable gives this. */
  use?: Resource;
  /** True when the client must see the cost and say yes before `use` runs. */
  askFirst: boolean;
  /** Energy to show the client first (paid services only). */
  quoteEnergy?: number;
  /** Resources that give this but were passed over, and why. */
  skipped: { key: string; reason: SkipReason }[];
  /** The cheapest thing that would give this if it were connected, hired or switched on. For "connect X and I can do this". */
  missing?: Resource;
}

/** Picks the cheapest usable resource for a need. See the order at the top of this file. */
export function chooseResource(need: Need, resources: readonly Resource[]): Choice {
  const giving = resources.filter((r) => r.gives.includes(need.tag)).sort(byCost);
  const skipped: Choice["skipped"] = [];
  let use: Resource | undefined;
  for (const r of giving) {
    if (!r.allowed) { skipped.push({ key: r.key, reason: "not_allowed" }); continue; }
    if (r.state !== "ready") { skipped.push({ key: r.key, reason: "not_ready" }); continue; }
    if (use) { skipped.push({ key: r.key, reason: "cheaper_exists" }); continue; }
    if (r.cost.class === "money") { skipped.push({ key: r.key, reason: "money_needs_the_owner" }); continue; }
    if (isPaidClass(r.cost.class) && !need.essential) { skipped.push({ key: r.key, reason: "not_essential" }); continue; }
    use = r;
  }
  // Something the employee may use once it is connected. One it is not allowed to see is never offered.
  const missing = use ? undefined : giving.find((r) => r.allowed && r.state !== "ready");
  const paid = !!use && isPaidClass(use.cost.class);
  return {
    ...(use ? { use } : {}),
    askFirst: !!use && (paid || use.needsApproval),
    ...(paid && use?.cost.energy !== undefined ? { quoteEnergy: use.cost.energy } : {}),
    skipped,
    ...(missing ? { missing } : {}),
  };
}

/**
 * For each ready paid resource, the cheaper ready resource that gives the same thing (if any). The brief uses it to say
 * "use Reddit, not X" so a paid service is never used for something a cheaper one gives.
 */
export function cheaperAlternatives(resources: readonly Resource[]): Map<string, Resource> {
  const out = new Map<string, Resource>();
  const usable = resources.filter((r) => r.allowed && r.state === "ready");
  for (const r of usable.filter((x) => isPaidClass(x.cost.class))) {
    const cheaper = usable.filter((x) => x.key !== r.key && !isPaidClass(x.cost.class) && x.gives.some((g) => r.gives.includes(g))).sort(byCost)[0];
    if (cheaper) out.set(r.key, cheaper);
  }
  return out;
}

/** The longest answer that counts as a one-line acknowledgement. */
export const TRIVIAL_ANSWER_CHARS = 80;

/**
 * Whether a routine (sampled) quality check is worth paying for. A one-line answer with no figure in it has nothing
 * for the checking model to find, so the sample skips it. This never touches the checks that always run: an answer
 * that looks wrong (empty, cut off, looping, far too short for its task) is still checked or redone, and work for the
 * strongest lane ("premium": books, forecasts, advice) is still sampled whatever its length.
 */
export function worthSampling(answer: string, tier: "standard" | "premium" | undefined): boolean {
  if (tier === "premium") return true;
  const text = answer.trim();
  return text.length > TRIVIAL_ANSWER_CHARS || /\d/.test(text);
}
