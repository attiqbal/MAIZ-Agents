import { newId } from "../../core/ids.js";
import type { EnergyMeter } from "../energy/index.js";
import { PAID_SERVICES, paidService, quoteFor, type PaidQuote, type PaidService } from "./catalogue.js";
import { checkRender, cleanRender, renderCreatomate, renderPractice, renderShotstack, RenderError, type RenderResult } from "./render.js";

export * from "./catalogue.js";
export { RenderError, cleanRender, keyWorks, type RenderInput, type RenderResult } from "./render.js";

/**
 * Runs services that cost MAIZ money each time (video rendering today). The rule, set by the platform owner:
 * a paid service uses its plain cost in energy times one multiplier (2 by default, changed on the Prices page).
 *
 * Nothing runs until the caller sends back the exact energy figure from the quote, so the person has always seen
 * the cost first. A client's agent pays from the team's weekly pool like any other work; the real cost still counts
 * towards the hidden monthly cost cap. With no key on the Connections page a practice render answers and nothing is charged.
 */
export class PaidServiceError extends Error {
  constructor(message: string, readonly quote?: PaidQuote) { super(message); }
}

/** Who pays: a client's employee (from the team pool), or one of the platform owner's own agents (logged, no pool). */
export type Payer = { kind: "client"; workspaceId: string; employeeId: string } | { kind: "owner"; agent: string };

export interface PaidUse {
  id: string;
  at: string;
  service: string;
  payer: Payer;
  /** Energy charged (0 for a practice render). */
  energy: number;
  simulated: boolean;
  render: RenderResult;
}

export interface PaidServicesOptions {
  meter: Pick<EnergyMeter, "canAfford" | "recordPaid">;
  /** The owner's one setting, read each time so a change on the Prices page applies to the next quote. */
  multiplier: () => number;
  keys: () => { creatomate?: string; shotstack?: string };
  http: typeof fetch;
  now: () => Date;
  onUse?: (use: PaidUse) => void;
}

/** A runaway script cannot render all day: most paid calls one payer may make in a day. */
export const MAX_PAID_USES_PER_DAY = 25;
const KEPT = 500;
const REASONS: Record<string, string> = {
  weekly_pool_used: "there is not enough energy left this week for this. Top up, or wait for Monday's refill",
  daily_ceiling_reached: "the team has reached today's safety limit. Try again tomorrow",
  daily_quota_used: "this employee has used its energy for today",
  overtime_cap_reached: "this month's extra energy is used up",
  monthly_cost_cap_reached: "this month's limit has been reached. Please contact MAIZ",
  trial_ended: "the free trial has ended",
};

export class PaidServices {
  private uses: PaidUse[] = [];
  /** Payers with a paid call in flight, so two presses cannot both pass the same energy check. */
  private busy = new Set<string>();

  constructor(private readonly opts: PaidServicesOptions) {}

  private payerKey(p: Payer): string { return p.kind === "client" ? `c:${p.workspaceId}` : `o:${p.agent}`; }

  private connected(s: PaidService): boolean { return !!(s.connection && this.opts.keys()[s.connection]); }

  /** Every service with what it would cost now. Safe to show to anyone signed in: no keys, no real costs. */
  list(): (PaidService & { connected: boolean; quote?: PaidQuote })[] {
    return PAID_SERVICES.map((s) => ({ ...s, estCostMicro: undefined, connected: this.connected(s), quote: s.kind === "api" ? this.quote(s.key) : undefined }));
  }

  /** What one use costs right now. Shown before anything runs. */
  quote(key: string): PaidQuote & { simulated: boolean } {
    const s = paidService(key);
    if (!s || s.kind !== "api") throw new PaidServiceError("that service cannot be run from here yet");
    return { ...quoteFor(s, this.opts.multiplier()), simulated: !this.connected(s) };
  }

  /**
   * Renders one video. `confirmEnergy` must equal the current quote: if the owner changed the multiplier since the
   * person looked, the call is refused with the new figure rather than charging a number nobody saw.
   */
  async render(payer: Payer, key: string, rawInput: unknown, confirmEnergy: unknown): Promise<PaidUse> {
    const s = paidService(key);
    const quote = this.quote(key);
    const input = cleanRender(rawInput);
    if (confirmEnergy !== quote.energy) {
      throw new PaidServiceError(quote.simulated
        ? `${s!.name} is not connected yet, so this would be a practice render that uses no energy. Once connected it uses ${quote.energy} energy (${quote.multiplier} times its plain cost of ${quote.baseEnergy}). Confirm to continue.`
        : `This uses ${quote.energy} energy from the team's pool (${quote.multiplier} times its plain cost of ${quote.baseEnergy}), because ${s!.name} is a paid service. Confirm to continue.`, quote);
    }
    const pk = this.payerKey(payer);
    if (this.busy.has(pk)) throw new PaidServiceError("another paid request is still running. Wait for it to finish");
    const day = this.opts.now().toISOString().slice(0, 10);
    if (this.uses.filter((u) => this.payerKey(u.payer) === pk && u.at.startsWith(day)).length >= MAX_PAID_USES_PER_DAY) throw new PaidServiceError(`that is ${MAX_PAID_USES_PER_DAY} paid requests today, which is the daily safety limit`);
    const apiKey = s!.connection ? this.opts.keys()[s!.connection] : undefined;
    let overtime = false;
    if (apiKey && payer.kind === "client") {
      const v = this.opts.meter.canAfford(payer.workspaceId, payer.employeeId, quote.energy);
      if (!v.allowed) throw new PaidServiceError(`Not started: ${REASONS[v.reason] ?? "energy is not available"}.`, quote);
      overtime = v.overtime;
    }
    this.busy.add(pk);
    try {
      const render = !apiKey ? renderPractice(input, () => newId("r")) : s!.connection === "creatomate" ? await renderCreatomate(this.opts.http, apiKey, input) : await renderShotstack(this.opts.http, apiKey, input);
      // Charged only once the service accepted the job. A refusal above this line costs nothing.
      const energy = render.simulated ? 0 : quote.energy;
      if (!render.simulated && payer.kind === "client") this.opts.meter.recordPaid(payer.workspaceId, payer.employeeId, `paid:${s!.key}`, s!.estCostMicro ?? 0, energy, overtime);
      const use: PaidUse = { id: newId("paid"), at: this.opts.now().toISOString(), service: s!.key, payer, energy, simulated: render.simulated, render };
      this.uses = [...this.uses, use].slice(-KEPT);
      this.opts.onUse?.(use);
      return use;
    } finally {
      this.busy.delete(pk);
    }
  }

  /** Asks the service whether a started render has finished. Free: it reads, it does not render. */
  async status(payer: Payer, useId: string): Promise<PaidUse> {
    const pk = this.payerKey(payer);
    const use = this.uses.find((u) => u.id === useId && this.payerKey(u.payer) === pk);
    if (!use) throw new PaidServiceError("that request was not found");
    if (use.simulated || use.render.status === "done") return use;
    const s = paidService(use.service)!;
    const apiKey = s.connection ? this.opts.keys()[s.connection] : undefined;
    if (!apiKey || !s.connection) throw new PaidServiceError(`${s.name} is not connected any more`);
    const render = await checkRender(this.opts.http, s.connection, apiKey, use.render.id);
    const next = { ...use, render };
    this.uses = this.uses.map((u) => (u.id === use.id ? next : u));
    return next;
  }

  /** The latest paid calls of one payer, newest first. */
  recent(payer: Payer, limit = 20): PaidUse[] {
    const pk = this.payerKey(payer);
    return this.uses.filter((u) => this.payerKey(u.payer) === pk).slice(-limit).reverse();
  }
}

export const isPaidError = (e: unknown): e is PaidServiceError | RenderError => e instanceof PaidServiceError || e instanceof RenderError;
