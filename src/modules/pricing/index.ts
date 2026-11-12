import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import { PermissionError } from "../identity/index.js";
import { CATALOGUE, MONTHLY_PRICE_GBP, type CatalogueItem } from "../store/cart.js";
import { EMPLOYEE_TEMPLATES } from "../workforce/templates.js";
import { PLANS, type EnergyPlan } from "../energy/index.js";

/**
 * Prices and packages, owned by the MAIZ platform owner. The code holds the launch defaults; the
 * owner changes them from the Prices page without a release. Every change is kept (who, when, why,
 * from and to) and can start now or on a later date, so prices can be adjusted over time.
 * Changes only affect new quotes and new trials: nothing already sold is repriced.
 */
export interface GeneralPrices {
  /** The basic package (core team) per month. */
  basicPackageMonthlyGbp: number;
  /** A ready-made add-on employee per month. */
  addOnEmployeeMonthlyGbp: number;
  specialistStandardMonthlyGbp: number;
  specialistPremiumMonthlyGbp: number;
  /** Extra energy beyond a consultant pass, per 100 energy, only with the client's approval. */
  overageGbpPer100Energy: number;
  /** Free trial length for new clients. */
  trialDays: number;
  /** Energy the whole team shares for the entire free trial. */
  trialTeamEnergy: number;
  /** Energy the basic package's team shares each week (refills Monday). */
  weeklyTeamEnergy: number;
  /** Most the whole team may use in one day, so a runaway script cannot empty the week at once. */
  dailyTeamCeiling: number;
  /** Weekly energy each add-on employee adds to the team pool. */
  addOnWeeklyEnergy: number;
  specialistStandardWeeklyEnergy: number;
  specialistPremiumWeeklyEnergy: number;
}

export interface ItemSetting {
  priceGbp?: number;
  /** Energy included (consultant passes). */
  energy?: number;
  /** Pass length in days (consultant passes). */
  days?: number;
  /** Off hides it from the store; existing clients keep what they have. */
  available?: boolean;
}

export interface PriceChangeSet {
  general?: Partial<GeneralPrices>;
  /** By catalogue key, for example "seo-specialist" or "web-developer:sprint". */
  items?: Record<string, ItemSetting>;
  /** An agent's own daily cap inside the team pool, by employee template key. null clears it (no cap). */
  agents?: Record<string, number | null>;
}

export interface PriceChange {
  id: string;
  at: string;
  by: string;
  /** When the change takes effect (ISO time). Equal to `at` for an immediate change. */
  effectiveFrom: string;
  note?: string;
  set: PriceChangeSet;
  /** What each changed value was just before this change took effect, for the history view. */
  from: Record<string, unknown>;
}

export interface PriceBookView {
  general: GeneralPrices;
  items: (CatalogueItem & { available: boolean })[];
  /** dailyEnergy is null when the agent has no cap of its own and just draws from the team pool. */
  agents: { key: string; title: string; dailyEnergy: number | null; custom: boolean }[];
}

export class PricingError extends Error {}

/** Top-up pack sizes in pounds; the energy in each follows the owner's extra-energy price. */
export const TOP_UP_PACK_GBP = [5, 10, 25] as const;

/**
 * The energy plan a client gets when they buy the basic package, from the prices in force at the sale.
 * Payments are not built yet; checkout calls this so the owner's pool settings reach paid clients.
 */
export function paidTeamPlan(g: GeneralPrices): EnergyPlan {
  return { ...PLANS.starter!, weeklyTeamEnergy: g.weeklyTeamEnergy, dailyTeamCeiling: g.dailyTeamCeiling };
}

/** Launch defaults agreed with the platform owner on 2026-11-11 (£150 starting point, 8,000 energy a week). */
export const DEFAULT_GENERAL: GeneralPrices = {
  basicPackageMonthlyGbp: 150,
  addOnEmployeeMonthlyGbp: MONTHLY_PRICE_GBP.employee,
  specialistStandardMonthlyGbp: MONTHLY_PRICE_GBP.specialistStandard,
  specialistPremiumMonthlyGbp: MONTHLY_PRICE_GBP.specialistPremium,
  overageGbpPer100Energy: 1,
  trialDays: 7,
  trialTeamEnergy: PLANS.trial!.weeklyTeamEnergy!,
  weeklyTeamEnergy: PLANS.starter!.weeklyTeamEnergy!,
  dailyTeamCeiling: PLANS.starter!.dailyTeamCeiling!,
  addOnWeeklyEnergy: 2_000,
  specialistStandardWeeklyEnergy: 2_000,
  specialistPremiumWeeklyEnergy: 2_000,
};

const GENERAL_LIMITS: Record<keyof GeneralPrices, [number, number, boolean]> = {
  // [min, max, whole numbers only]
  basicPackageMonthlyGbp: [0, 10_000, false],
  addOnEmployeeMonthlyGbp: [0, 10_000, false],
  specialistStandardMonthlyGbp: [0, 10_000, false],
  specialistPremiumMonthlyGbp: [0, 10_000, false],
  overageGbpPer100Energy: [0, 1_000, false],
  trialDays: [0, 60, true],
  trialTeamEnergy: [0, 1_000_000, true],
  weeklyTeamEnergy: [0, 1_000_000, true],
  dailyTeamCeiling: [0, 1_000_000, true],
  addOnWeeklyEnergy: [0, 1_000_000, true],
  specialistStandardWeeklyEnergy: [0, 1_000_000, true],
  specialistPremiumWeeklyEnergy: [0, 1_000_000, true],
};
const MAX_PRICE = 100_000;
const MAX_ENERGY = 10_000_000;
const MAX_FUTURE_DAYS = 366;

function num(v: unknown, [min, max, whole]: [number, number, boolean], what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) {
    throw new PricingError(`${what} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}`);
  }
  // Money to the penny.
  return whole ? v : Math.round(v * 100) / 100;
}

/** Checks a change from the Prices page. Unknown keys are refused rather than silently ignored. */
export function parseChange(input: unknown): { set: PriceChangeSet; effectiveFrom?: string; note?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PricingError("change is not valid");
  const b = input as Record<string, unknown>;
  const set: PriceChangeSet = {};
  if (b.general !== undefined) {
    if (!b.general || typeof b.general !== "object") throw new PricingError("general is not valid");
    const g: Partial<GeneralPrices> = {};
    for (const [k, v] of Object.entries(b.general)) {
      const limits = GENERAL_LIMITS[k as keyof GeneralPrices];
      if (!limits) throw new PricingError(`unknown setting ${k}`);
      g[k as keyof GeneralPrices] = num(v, limits, k);
    }
    if (Object.keys(g).length) set.general = g;
  }
  if (b.items !== undefined) {
    if (!b.items || typeof b.items !== "object") throw new PricingError("items is not valid");
    const items: Record<string, ItemSetting> = {};
    for (const [key, raw] of Object.entries(b.items)) {
      const item = CATALOGUE.find((i) => i.key === key);
      if (!item) throw new PricingError(`unknown store item ${key}`);
      if (!raw || typeof raw !== "object") throw new PricingError(`${key} is not valid`);
      const r = raw as Record<string, unknown>;
      const s: ItemSetting = {};
      if (r.priceGbp !== undefined) s.priceGbp = num(r.priceGbp, [0, MAX_PRICE, false], `${item.title} price`);
      if (r.energy !== undefined) { if (item.kind !== "consultant") throw new PricingError(`${item.title} has no energy pool`); s.energy = num(r.energy, [0, MAX_ENERGY, true], `${item.title} energy`); }
      if (r.days !== undefined) { if (item.kind !== "consultant") throw new PricingError(`${item.title} has no pass length`); s.days = num(r.days, [1, 365, true], `${item.title} days`); }
      if (r.available !== undefined) { if (typeof r.available !== "boolean") throw new PricingError(`${item.title} availability must be on or off`); s.available = r.available; }
      if (Object.keys(s).length) items[key] = s;
    }
    if (Object.keys(items).length) set.items = items;
  }
  if (b.agents !== undefined) {
    if (!b.agents || typeof b.agents !== "object") throw new PricingError("agents is not valid");
    const agents: Record<string, number | null> = {};
    for (const [key, v] of Object.entries(b.agents)) {
      const t = EMPLOYEE_TEMPLATES.find((x) => x.key === key);
      if (!t) throw new PricingError(`unknown agent ${key}`);
      agents[key] = v === null ? null : num(v, [0, 100_000, true], `${t.title} daily energy`);
    }
    if (Object.keys(agents).length) set.agents = agents;
  }
  if (!set.general && !set.items && !set.agents) throw new PricingError("nothing to change");
  const note = typeof b.note === "string" && b.note.trim() ? b.note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500) : undefined;
  let effectiveFrom: string | undefined;
  if (b.effectiveFrom !== undefined && b.effectiveFrom !== null && b.effectiveFrom !== "") {
    const t = typeof b.effectiveFrom === "string" ? Date.parse(b.effectiveFrom) : NaN;
    if (!Number.isFinite(t)) throw new PricingError("start date is not a date");
    effectiveFrom = new Date(t).toISOString();
  }
  return { set, ...(effectiveFrom ? { effectiveFrom } : {}), ...(note ? { note } : {}) };
}

interface State { general: GeneralPrices; items: Record<string, ItemSetting>; agents: Record<string, number> }

function apply(state: State, set: PriceChangeSet): State {
  const agents = { ...state.agents };
  for (const [k, v] of Object.entries(set.agents ?? {})) {
    if (v === null) delete agents[k];
    else agents[k] = v;
  }
  const items = { ...state.items };
  for (const [k, v] of Object.entries(set.items ?? {})) items[k] = { ...items[k], ...v };
  return { general: { ...state.general, ...set.general }, items, agents };
}

/** "general.trialDays" -> value, for the history's "from" column. */
function valuesOf(state: State, set: PriceChangeSet, item: (key: string) => CatalogueItem & { available: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(set.general ?? {})) out[`general.${k}`] = state.general[k as keyof GeneralPrices];
  for (const [key, s] of Object.entries(set.items ?? {})) {
    const now = item(key);
    for (const f of Object.keys(s)) out[`items.${key}.${f}`] = now[f as keyof typeof now];
  }
  for (const k of Object.keys(set.agents ?? {})) out[`agents.${k}`] = state.agents[k] ?? null;
  return out;
}

export class PriceBook {
  private changes: PriceChange[] = [];
  private sink?: Sink;

  constructor(
    private isPlatformOwner: (userId: string) => boolean,
    private now: () => Date = () => new Date(),
  ) {}

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restore(c: PriceChange): void {
    this.changes.push(c);
  }

  /** Settings in force at a moment (now by default). Public: the store and trials read it. */
  private stateAt(at: Date): State {
    const iso = at.toISOString();
    return this.ordered()
      .filter((c) => c.effectiveFrom <= iso)
      .reduce<State>((s, c) => apply(s, c.set), { general: { ...DEFAULT_GENERAL }, items: {}, agents: {} });
  }

  private ordered(): PriceChange[] {
    return [...this.changes].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.at.localeCompare(b.at));
  }

  general(at = this.now()): GeneralPrices {
    return this.stateAt(at).general;
  }

  /** Every store item with today's price, energy, days and availability. */
  items(at = this.now()): (CatalogueItem & { available: boolean })[] {
    const s = this.stateAt(at);
    return CATALOGUE.map((i) => priced(i, s));
  }

  /** What clients can buy right now. */
  catalogue(at = this.now()): CatalogueItem[] {
    return this.items(at).filter((i) => i.available).map(({ available: _a, ...i }) => i);
  }

  /**
   * Top-up packs a paid client can buy when the week's energy runs out. Priced at the extra-energy rate,
   * they roll over and never expire (like Macro's credit packs), and nothing is ever charged automatically
   * unless the client turns auto-reload on with a monthly cap.
   */
  topUpPacks(at = this.now()): { gbp: number; energy: number }[] {
    const rate = this.stateAt(at).general.overageGbpPer100Energy;
    if (rate <= 0) return [];
    return TOP_UP_PACK_GBP.map((gbp) => ({ gbp, energy: Math.floor((gbp / rate) * 100) }));
  }

  /** Weekly energy an employee adds to a paid team pool: add-ons and specialists do; the core team does not. */
  weeklyEnergyFor(templateKey: string, at = this.now()): number {
    const item = CATALOGUE.find((i) => i.key === templateKey);
    const g = this.stateAt(at).general;
    if (item?.kind === "employee") return g.addOnWeeklyEnergy;
    if (item?.kind === "specialist") return item.tier === "premium" ? g.specialistPremiumWeeklyEnergy : g.specialistStandardWeeklyEnergy;
    return 0;
  }

  /** An agent's own daily energy, if the platform owner set one. Applies to every client from its start date. */
  agentAllowance(templateKey: string, at = this.now()): number | undefined {
    return this.stateAt(at).agents[templateKey];
  }

  /** The whole price book for the platform owner's page. */
  view(userId: string): PriceBookView & { history: (PriceChange & { upcoming: boolean })[] } {
    this.requireOwner(userId);
    const at = this.now();
    const s = this.stateAt(at);
    const iso = at.toISOString();
    return {
      general: s.general,
      items: CATALOGUE.map((i) => priced(i, s)),
      agents: EMPLOYEE_TEMPLATES.map((t) => ({ key: t.key, title: t.title, dailyEnergy: s.agents[t.key] ?? null, custom: s.agents[t.key] !== undefined })),
      history: this.ordered().reverse().map((c) => ({ ...c, upcoming: c.effectiveFrom > iso })),
    };
  }

  /** The platform owner changes prices, now or from a later date. */
  change(userId: string, input: unknown): PriceChange {
    this.requireOwner(userId);
    const { set, effectiveFrom, note } = parseChange(input);
    const at = this.now();
    const from = effectiveFrom && Date.parse(effectiveFrom) > at.getTime() ? effectiveFrom : at.toISOString();
    if (Date.parse(from) - at.getTime() > MAX_FUTURE_DAYS * 86_400_000) throw new PricingError(`a change can start at most ${MAX_FUTURE_DAYS} days ahead`);
    const before = this.stateAt(new Date(from));
    const c: PriceChange = {
      id: newId("price"),
      at: at.toISOString(),
      by: userId,
      effectiveFrom: from,
      ...(note ? { note } : {}),
      set,
      from: valuesOf(before, set, (key) => priced(CATALOGUE.find((i) => i.key === key)!, before)),
    };
    this.changes.push(c);
    this.sink?.priceChange(c);
    return c;
  }

  /** A change that has not started yet can be called off. Started changes stay in the history. */
  cancel(userId: string, id: string): void {
    this.requireOwner(userId);
    const c = this.changes.find((x) => x.id === id);
    if (!c) throw new PricingError("change not found");
    if (c.effectiveFrom <= this.now().toISOString()) throw new PricingError("this change has already started; make a new change instead");
    this.changes = this.changes.filter((x) => x.id !== id);
    this.sink?.priceChange({ ...c, set: {}, note: "cancelled" }, true);
  }

  private requireOwner(userId: string): void {
    if (!this.isPlatformOwner(userId)) throw new PermissionError("only the platform owner manages prices");
  }
}

function priced(i: CatalogueItem, s: State): CatalogueItem & { available: boolean } {
  const g = s.general;
  const base =
    i.kind === "employee" ? g.addOnEmployeeMonthlyGbp
    : i.kind === "specialist" ? (i.tier === "premium" ? g.specialistPremiumMonthlyGbp : g.specialistStandardMonthlyGbp)
    : i.priceGbp;
  const o = s.items[i.key] ?? {};
  return {
    ...i,
    priceGbp: o.priceGbp ?? base,
    ...(i.kind === "consultant" ? { energy: o.energy ?? i.energy, days: o.days ?? i.days } : {}),
    available: o.available ?? true,
  };
}
