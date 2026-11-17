/**
 * What the employees used and what it cost, for the platform owner. Two honest sources, both recorded already:
 * - each finished task lists the resources it was given (`used`), with the energy and real cost of the task;
 * - each paid service use and each data-gathering run books its own energy and real cost under a provider name
 *   ("paid:creatomate", "mine:reddit") in the energy meter.
 * Pure arithmetic over those records. Nothing is estimated and nothing is stored twice.
 */
export interface UsageInput {
  tasks: readonly { used?: readonly string[]; energy?: number; costMicro?: number }[];
  providers: readonly { provider: string; energy: number; costMicro: number; uses: number }[];
}

export interface UsageRow {
  key: string;
  /** "given": handed to employees with their tasks. "charged": booked its own energy when it ran. */
  how: "given" | "charged";
  uses: number;
  /** For "given": the energy of the tasks it was in front of (shared between everything they were given, so rows do not add up). For "charged": the energy taken from clients for it. */
  energy: number;
  /** Real cost to MAIZ in micro-dollars. */
  costMicro: number;
}

/** "paid:creatomate" and "mine:reddit" are the names the energy meter books under; the registry calls them paid:creatomate and source:reddit. */
const keyOfProvider = (p: string): string | undefined => (p.startsWith("paid:") ? p : p.startsWith("mine:") ? `source:${p.slice(5)}` : undefined);

export function usageTable(input: UsageInput): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const bump = (key: string, how: UsageRow["how"], uses: number, energy: number, costMicro: number): void => {
    const id = `${how}|${key}`;
    const r = rows.get(id) ?? { key, how, uses: 0, energy: 0, costMicro: 0 };
    rows.set(id, { ...r, uses: r.uses + uses, energy: r.energy + energy, costMicro: r.costMicro + costMicro });
  };
  for (const t of input.tasks) for (const key of new Set(t.used ?? [])) bump(key, "given", 1, t.energy ?? 0, t.costMicro ?? 0);
  for (const p of input.providers) {
    const key = keyOfProvider(p.provider);
    if (key) bump(key, "charged", p.uses, p.energy, p.costMicro);
  }
  // Paid and charged things first (that is where money goes), then by energy, then by key so the order never shifts.
  return [...rows.values()].sort((a, b) => (a.how === b.how ? 0 : a.how === "charged" ? -1 : 1) || b.energy - a.energy || a.key.localeCompare(b.key));
}
