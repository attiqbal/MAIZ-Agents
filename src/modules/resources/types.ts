/**
 * One thing an AI employee can work with: figures already read from a connected app, a saved dataset, a public data
 * source, a paid service, a teammate. The registry (registry.ts) builds these from the modules that own them; nothing
 * here is a second copy of their data. Pure types: the website imports them too.
 */

/**
 * What using a resource costs the client, cheapest first:
 * - known: already here (read from a connected app, saved, typed in by the owner). Using it again costs nothing extra.
 * - free: an answer worked out from the records with no AI model.
 * - energy: ordinary energy (the open models, or a small flat figure for reading a free public source).
 * - double_energy: an outside service that charges MAIZ each time, so it uses the owner's paid-service multiple.
 * - money: the client pays money for it (hiring another employee from the store).
 */
export type CostClass = "known" | "free" | "energy" | "double_energy" | "money";

/** ready: usable now. not_connected: the client can connect it. waiting_approval: MAIZ or the provider must switch it on first. not_hired: needs an employee the client has not hired. */
export type ResourceState = "ready" | "not_connected" | "waiting_approval" | "not_hired";

export type ResourceKind = "profile" | "records" | "app" | "dataset" | "data-source" | "paid-service" | "employee" | "outside-tool" | "model";

/** Who can make a resource that is not ready usable: the client (connect, hire, gather) or MAIZ (a key or an approval). */
export type FixBy = "client" | "maiz";

export interface ResourceCost {
  class: CostClass;
  /** Energy for one use, when it is known in advance. */
  energy?: number;
}

export interface Resource {
  /** Stable id: "app:xero", "source:reddit", "paid:creatomate", "known:profile", "employee:data-mining-agent". */
  key: string;
  kind: ResourceKind;
  name: string;
  /** What it is good for, in plain words. */
  goodFor: string;
  /** What it can supply, as short tags ("sales", "public-opinion", "video"). The choice rule matches a need to these. */
  gives: readonly string[];
  state: ResourceState;
  /** May this employee use it (the owner's per-app access, the employee's own job). */
  allowed: boolean;
  cost: ResourceCost;
  /** The client must confirm before it is used (anything that spends, sends or publishes). */
  needsApproval: boolean;
  /** How old the data may be, in plain words ("read today", "gathered 14 Nov"). */
  freshness?: string;
  /** A cheaper resource that gives the same thing, when one is ready. Set by the choice rule. */
  cheaper?: string;
  /** Where the client goes to connect, hire or gather it. Only when the client can fix it. */
  fix?: { by: FixBy; label: string; href: string };
}

/** A hint the web app shows as a link. The same shape as the Home screen's suggestions (src/server/suggestions.ts). */
export interface ResourceSuggestion {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  action: { label: string; href: string };
}
