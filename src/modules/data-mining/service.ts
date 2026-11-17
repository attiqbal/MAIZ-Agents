import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import { noEnergyMessage } from "../channels/index.js";
import type { EnergyMeter, PaidHold } from "../energy/index.js";
import type { IdentityService } from "../identity/index.js";
import { DEFAULT_PAID_MULTIPLIER } from "../paid-services/catalogue.js";
import { ResearchError } from "../research/sources.js";
import { MAX_TOPIC, MIN_TOPIC, cleanTopic, headerOf, readDataset, renderContext, summarise, type Dataset, type DatasetHeader, type DatasetSource } from "./dataset.js";
import { MINING_SOURCES, energyFor, gather, miningSource, unavailableReason, type Gathered, type MiningKeys, type MiningSource, type MiningSourceId } from "./sources.js";
import { MAX_CHECKS, MAX_NEW_ITEMS, MAX_WATCHES, changeSummary, compareSources, mergeSources, missedNote, nextSlot, type DatasetCheck } from "./watch.js";

/** The template key of the employee a client hires to use any of this. */
export const DATA_MINING_AGENT = "data-mining-agent";
/** Most sources one run may ask. */
export const MAX_SOURCES_PER_RUN = 5;
/** Most confirmed runs one client may start in an hour. */
export const MAX_RUNS_PER_HOUR = 20;
/** Datasets kept per client. When a new one would be the fifty-first, the oldest is dropped. */
export const MAX_DATASETS = 50;
/** Most employees one dataset can be shared with. */
export const MAX_SHARED_WITH = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOT_HIRED = "Hire the Data mining agent from the store first.";
/** Weekly checks read in one pass of the scheduler, so a busy minute cannot start a burst of outside calls. */
const MAX_CHECKS_PER_TICK = 3;
/** A check that ran late (the server was off) is never followed by another within half a week. */
const HALF_WEEK_MS = 3.5 * DAY_MS;
const MINING_PAGE = "/app.html#mining";

/** What a weekly check tells the client: a short title, one line, and the on-site page it opens. */
export interface MiningNotice { title: string; body: string; link: string }
/** What reading a quote's sources gave, and the energy kept for the ones that found something. */
interface Reading { sources: DatasetSource[]; energyUsed: number }

const unwatched = (d: Dataset): Dataset => {
  const { watch: _watch, ...rest } = d;
  return rest;
};
const noCheck = (at: string, note: string): DatasetCheck => ({ at, status: "skipped", summary: "", energyUsed: 0, newItems: [], figures: [], note });

/** What one source would use, and whether it can be read right now. */
export interface QuotedSource { id: MiningSourceId; label: string; gives: string; energy: number; paid: boolean; available: boolean; reason?: string }

/** Shown before anything runs. `total` counts only the sources that are available: the others are skipped, not charged. */
export interface MiningQuote { topic: string; sources: QuotedSource[]; total: number; unavailable: MiningSourceId[] }

/**
 * Anything the client did wrong or cannot do yet, in words they can act on. When `quote` is set the request was fine
 * but has not been confirmed: the caller shows the cost and asks again with `confirm: true` and that total.
 */
export class MiningError extends Error {
  constructor(message: string, readonly quote?: MiningQuote) { super(message); }
}
/** No such dataset in this workspace. Another client's dataset is reported the same way, so nothing leaks. */
export class DatasetNotFound extends MiningError {
  constructor() { super("that dataset was not found"); }
}

export interface MiningOptions {
  identity: Pick<IdentityService, "require">;
  meter: Pick<EnergyMeter, "canAfford" | "holdPaid" | "settlePaid" | "releasePaid">;
  /** The client's employees, as the signed-in person may see them. */
  team: (userId: string, workspaceId: string) => readonly { id: string; templateKey: string }[];
  /** The title of a template as this client sees it (their own custom specialists included). */
  titleOf: (templateKey: string, workspaceId: string) => string | undefined;
  /** The country in the business profile, for the economy figures. */
  countryOf?: (workspaceId: string) => string | undefined;
  /** The owner's paid-service multiplier, read each time so a change on the Prices page applies to the next quote. */
  multiplier: () => number;
  /** The platform's keys, read each time so a key typed on the Connections page works at once. */
  keys: () => MiningKeys;
  audit?: Pick<AuditLog, "record">;
  http?: typeof fetch;
  now?: () => Date;
  /**
   * Platform-level (no user check): the id of the client's Data mining agent, or undefined when it is no longer on
   * the team. Weekly checks run with nobody signed in, so they cannot ask as a person. Without it no check runs.
   */
  agentIn?: (workspaceId: string) => string | undefined;
  /** The client's time zone when it is known, so a weekly check waits for a quiet hour of their night. */
  timezone?: (workspaceId: string) => string | undefined;
  /** Tells the client something about a weekly check through the usual notification paths. */
  notify?: (workspaceId: string, notice: MiningNotice) => void;
}

/** What the Data mining page shows when it opens. */
export interface MiningOverview {
  hired: boolean;
  sources: QuotedSource[];
  datasets: DatasetHeader[];
  employees: { key: string; title: string }[];
  limits: { maxSources: number; runsPerHour: number; maxDatasets: number; minTopic: number; maxTopic: number };
}

/** The most one client may use of a source's daily budget: a fifth of it, and never fewer than two searches. */
const clientShare = (dailyBudget: number): number => Math.max(2, Math.ceil(dailyBudget / 5));

/**
 * The Data mining agent's desk: a client who has hired the agent picks a topic and up to five public sources, sees
 * what it will use in energy, confirms, and gets a small saved dataset (snippets, links, a few figures and a
 * plain-English summary). A dataset can then be shared with other employees, who are given it with their tasks as
 * clearly marked reference data.
 *
 * Energy is set aside per source before anything is read and is only kept for sources that returned something; a
 * source that failed or found nothing gives its energy back. Every record belongs to one workspace and is never
 * visible from another.
 */
export class DataMiningService {
  private datasets = new Map<string, Dataset[]>();
  /** When each client's confirmed runs started, for the hourly limit. */
  private runs = new Map<string, number[]>();
  /** When each budgeted source was read, across every client, for the platform's daily limits. */
  private sourceRuns = new Map<MiningSourceId, { at: number; workspaceId: string }[]>();
  /** Clients with a run in flight, so two presses cannot both pass the same energy check. */
  private busy = new Set<string>();
  /** True while the weekly checks are being worked through, so two passes never overlap. */
  private ticking = false;
  private sink?: Sink;

  constructor(private readonly opts: MiningOptions) {}

  useSink(sink: Sink): void { this.sink = sink; }

  /** Puts a stored dataset back after a restart. A removed or damaged record is skipped. */
  restore(data: unknown): void {
    const d = readDataset(data);
    if (!d) return;
    const others = this.mine(d.workspaceId).filter((x) => x.id !== d.id);
    this.datasets.set(d.workspaceId, [...others, d].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_DATASETS));
  }

  private get http(): typeof fetch { return this.opts.http ?? fetch; }
  private nowMs(): number { return (this.opts.now?.() ?? new Date()).getTime(); }
  private mine(workspaceId: string): readonly Dataset[] { return this.datasets.get(workspaceId) ?? []; }
  private agentOf(userId: string, workspaceId: string): string | undefined {
    return this.opts.team(userId, workspaceId).find((e) => e.templateKey === DATA_MINING_AGENT)?.id;
  }

  /** The employees a dataset can be shared with: everyone on the client's team except the Data mining agent itself. */
  private shareTargets(userId: string, workspaceId: string): { key: string; title: string }[] {
    const keys = [...new Set(this.opts.team(userId, workspaceId).map((e) => e.templateKey))].filter((k) => k !== DATA_MINING_AGENT);
    return keys.map((key) => ({ key, title: this.opts.titleOf(key, workspaceId) ?? key }));
  }

  /**
   * A source with a daily budget is shared by every client, and a search counts against it whether or not it finds
   * anything (the outside service counts the call either way). So one client may use only a share of the day's
   * budget: nobody can use it all up for everyone else, even with searches that cost them nothing.
   */
  private budgetProblem(source: MiningSource, workspaceId: string): string | undefined {
    if (source.dailyBudget === undefined) return undefined;
    const t = this.nowMs();
    const today = (this.sourceRuns.get(source.id) ?? []).filter((x) => t - x.at < DAY_MS);
    if (today.length >= source.dailyBudget) return `${source.label} has been used a lot today across MAIZ. It will be available again tomorrow.`;
    if (today.filter((x) => x.workspaceId === workspaceId).length >= clientShare(source.dailyBudget)) return `You have used ${source.label} as often as one team can in a day. It will be available again tomorrow.`;
    return undefined;
  }

  private quoteSource(source: MiningSource, keys: MiningKeys, workspaceId: string, topic?: string): QuotedSource {
    const reason = unavailableReason(source, keys, topic) ?? this.budgetProblem(source, workspaceId);
    return {
      id: source.id, label: source.label, gives: source.gives, paid: source.paid,
      energy: energyFor(source, this.opts.multiplier(), DEFAULT_PAID_MULTIPLIER),
      available: !reason, ...(reason ? { reason } : {}),
    };
  }

  /** Everything the Data mining page needs: whether the agent is hired, the sources with today's energy, and saved datasets. */
  overview(userId: string, workspaceId: string): MiningOverview {
    this.opts.identity.require(userId, workspaceId, "task.read");
    const keys = this.opts.keys();
    return {
      hired: !!this.agentOf(userId, workspaceId),
      sources: MINING_SOURCES.map((s) => this.quoteSource(s, keys, workspaceId)),
      datasets: this.list(userId, workspaceId),
      employees: this.shareTargets(userId, workspaceId),
      limits: { maxSources: MAX_SOURCES_PER_RUN, runsPerHour: MAX_RUNS_PER_HOUR, maxDatasets: MAX_DATASETS, minTopic: MIN_TOPIC, maxTopic: MAX_TOPIC },
    };
  }

  /** The client's datasets, newest first, without their items. */
  list(userId: string, workspaceId: string): DatasetHeader[] {
    this.opts.identity.require(userId, workspaceId, "task.read");
    return [...this.mine(workspaceId)].reverse().map(headerOf);
  }

  /** One whole dataset. Another client's dataset looks exactly like one that does not exist. */
  get(userId: string, workspaceId: string, datasetId: string): Dataset {
    this.opts.identity.require(userId, workspaceId, "task.read");
    const d = this.mine(workspaceId).find((x) => x.id === datasetId);
    if (!d) throw new DatasetNotFound();
    return { ...d, sources: d.sources.map((s) => ({ ...s })), sharedWith: [...d.sharedWith] };
  }

  private read(raw: Record<string, unknown>): { topic: string; sources: MiningSource[] } {
    const topic = cleanTopic(raw.topic);
    if (!topic) throw new MiningError(`Type a topic of ${MIN_TOPIC} to ${MAX_TOPIC} characters: letters, numbers and everyday punctuation.`);
    const wanted = Array.isArray(raw.sources) ? [...new Set(raw.sources.filter((s): s is string => typeof s === "string"))] : [];
    if (!wanted.length) throw new MiningError("Choose at least one place to look.");
    if (wanted.length > MAX_SOURCES_PER_RUN) throw new MiningError(`Choose up to ${MAX_SOURCES_PER_RUN} places to look at a time.`);
    const sources = wanted.map((id) => miningSource(id));
    if (sources.some((s) => !s)) throw new MiningError("One of those places to look is not on the list.");
    return { topic, sources: sources as MiningSource[] };
  }

  /** What a run would use right now, source by source. Changes nothing and reads nothing. */
  quote(userId: string, workspaceId: string, raw: Record<string, unknown>): MiningQuote {
    this.opts.identity.require(userId, workspaceId, "task.create");
    if (!this.agentOf(userId, workspaceId)) throw new MiningError(NOT_HIRED);
    const { topic, sources } = this.read(raw);
    return this.quoteFor(workspaceId, topic, sources);
  }

  /** The quote itself, with no user check: the weekly check uses the same rules and prices as a search today. */
  private quoteFor(workspaceId: string, topic: string, sources: readonly MiningSource[]): MiningQuote {
    const keys = this.opts.keys();
    const quoted = sources.map((s) => this.quoteSource(s, keys, workspaceId, topic));
    return { topic, sources: quoted, total: quoted.filter((s) => s.available).reduce((n, s) => n + s.energy, 0), unavailable: quoted.filter((s) => !s.available).map((s) => s.id) };
  }

  /** Whether the team's pool and the hidden cost cap have room for everything in a quote that can be read. */
  private affordable(workspaceId: string, employeeId: string, quote: MiningQuote): ReturnType<EnergyMeter["canAfford"]> {
    const realCost = quote.sources.filter((s) => s.available).reduce((n, s) => n + miningSource(s.id)!.estCostMicro, 0);
    return this.opts.meter.canAfford(workspaceId, employeeId, quote.total, realCost);
  }

  private runsThisHour(workspaceId: string): number {
    const t = this.nowMs();
    return (this.runs.get(workspaceId) ?? []).filter((x) => t - x < HOUR_MS).length;
  }

  /** Counts a confirmed run towards the client's hour, whether or not it then finds anything. */
  private countRun(workspaceId: string): void {
    const t = this.nowMs();
    const recent = (this.runs.get(workspaceId) ?? []).filter((x) => t - x < HOUR_MS);
    if (recent.length >= MAX_RUNS_PER_HOUR) throw new MiningError(`That is ${MAX_RUNS_PER_HOUR} searches in an hour, which is the limit. Try again a little later.`);
    this.runs.set(workspaceId, [...recent, t]);
  }

  private countSource(source: MiningSource, workspaceId: string): void {
    if (source.dailyBudget === undefined) return;
    const t = this.nowMs();
    this.sourceRuns.set(source.id, [...(this.sourceRuns.get(source.id) ?? []).filter((x) => t - x.at < DAY_MS), { at: t, workspaceId }]);
  }

  /**
   * Gathers a dataset. Without `confirm: true` and `confirmEnergy` equal to the quote's total, nothing runs: the call
   * is refused with the quote, so the person has always seen the cost first. If a key was added, a price changed or a
   * daily limit was reached since they looked, they are shown the new figure rather than charged one nobody saw.
   */
  async run(userId: string, workspaceId: string, raw: Record<string, unknown>): Promise<Dataset> {
    const quote = this.quote(userId, workspaceId, raw);
    const employeeId = this.agentOf(userId, workspaceId)!;
    const ready = quote.sources.filter((s) => s.available);
    if (!ready.length) throw new MiningError(`Nothing can be gathered for that right now. ${quote.sources.map((s) => s.reason).join(" ")}`);
    if (raw.confirm !== true || raw.confirmEnergy !== quote.total) {
      const skipped = quote.unavailable.length ? ` ${quote.unavailable.length === 1 ? "One source is" : `${quote.unavailable.length} sources are`} not available and will be skipped.` : "";
      throw new MiningError(`This uses up to ${quote.total} energy from the team's pool. You only pay for sources that find something.${skipped} Confirm to continue.`, quote);
    }
    if (this.busy.has(workspaceId)) throw new MiningError("Another search is still running. Wait for it to finish.");
    // From here to the holds nothing is awaited, so two requests cannot both pass the same check.
    const verdict = this.affordable(workspaceId, employeeId, quote);
    if (!verdict.allowed) throw new MiningError(`Not started. ${noEnergyMessage(verdict.reason)}`);
    this.countRun(workspaceId);
    const { sources, energyUsed } = await this.readAndCharge(workspaceId, employeeId, quote);
    if (!sources.some((s) => s.status === "ok")) {
      this.opts.audit?.record({ workspaceId, actor: `user:${userId}`, action: "mining.nothing_found", data: { sources: sources.map((s) => ({ id: s.id, status: s.status })) } });
      throw new MiningError(`Nothing was found, so no energy was used. ${sources.map((s) => `${s.label}: ${s.status === "empty" ? "nothing on this topic" : (s.note ?? "not available").replace(/\.+$/, "")}.`).join(" ")}`);
    }
    const createdAt = new Date(this.nowMs()).toISOString();
    const dataset: Dataset = { id: newId("dataset"), workspaceId, topic: quote.topic, createdAt, sources, summary: summarise(quote.topic, sources, createdAt.slice(0, 10)), energyUsed, sharedWith: [] };
    this.keep(dataset);
    this.opts.audit?.record({ workspaceId, actor: `employee:${employeeId}`, action: "mining.dataset_created", target: dataset.id, data: { by: userId, energy: energyUsed, sources: sources.map((s) => ({ id: s.id, status: s.status })) } });
    return dataset;
  }

  /**
   * Reads every available source in a quote and settles the energy. The energy is set aside and the daily limits are
   * counted before anything is awaited; the caller has already checked the client can afford the quote's total.
   */
  private async readAndCharge(workspaceId: string, employeeId: string, quote: MiningQuote): Promise<Reading> {
    const ready = quote.sources.filter((s) => s.available);
    const sourceOf = (id: MiningSourceId): MiningSource => miningSource(id)!;
    const keys = this.opts.keys();
    const held = ready.map((s) => ({ quoted: s, hold: this.opts.meter.holdPaid(workspaceId, s.energy) }));
    for (const s of ready) this.countSource(sourceOf(s.id), workspaceId);
    this.busy.add(workspaceId);
    let outcomes: { quoted: QuotedSource; hold: PaidHold; result: DatasetSource }[];
    try {
      const country = this.opts.countryOf?.(workspaceId);
      outcomes = await Promise.all(held.map(async (h) => ({ ...h, result: await this.readSource(h.quoted, { http: this.http, keys, topic: quote.topic, country }) })));
    } catch (e) {
      // Should never happen (each source catches its own failure), but held energy must not be stranded if it does.
      for (const h of held) this.opts.meter.releasePaid(h.hold);
      throw e;
    } finally {
      this.busy.delete(workspaceId);
    }
    // A source that found something is charged; one that failed or found nothing gives its energy back.
    let energyUsed = 0;
    for (const o of outcomes) {
      if (o.result.status === "ok") {
        this.opts.meter.settlePaid(o.hold, employeeId, `mine:${o.quoted.id}`, sourceOf(o.quoted.id).estCostMicro);
        energyUsed += o.quoted.energy;
      } else this.opts.meter.releasePaid(o.hold);
    }
    const byId = new Map(outcomes.map((o) => [o.quoted.id, o.result]));
    const sources = quote.sources.map((s): DatasetSource => byId.get(s.id) ?? { id: s.id, label: s.label, status: "unavailable", items: [], note: s.reason });
    return { sources, energyUsed };
  }

  /** Reads one source and never throws: a failure becomes a "failed" row with a plain reason. */
  private async readSource(quoted: QuotedSource, ctx: Parameters<typeof gather>[1]): Promise<DatasetSource> {
    const base = { id: quoted.id, label: quoted.label };
    let got: Gathered;
    try {
      got = await gather(quoted.id, ctx);
    } catch (e) {
      // Only messages written for people are passed on; anything else could carry a web address with a key in it.
      return { ...base, status: "failed", items: [], note: e instanceof ResearchError ? e.message : `${quoted.label} could not be read this time.` };
    }
    if (!got.items.length && !got.figures.length) return { ...base, status: "empty", items: [] };
    return { ...base, status: "ok", items: got.items, ...(got.figures.length ? { figures: got.figures } : {}) };
  }

  /**
   * Saves a new dataset and drops the oldest beyond the cap, both in memory and in the store. A dataset with a weekly
   * check switched on is not the one dropped (there are always fewer of those than the cap).
   */
  private keep(dataset: Dataset): void {
    const all = [...this.mine(dataset.workspaceId), dataset];
    const dropped = all.filter((d) => !d.watch && d.id !== dataset.id).slice(0, Math.max(0, all.length - MAX_DATASETS));
    this.datasets.set(dataset.workspaceId, all.filter((d) => !dropped.includes(d)));
    this.sink?.record(dataset.workspaceId, "dataset", dataset.id, dataset);
    for (const d of dropped) this.sink?.record(d.workspaceId, "dataset", d.id, { removed: true });
  }

  /**
   * Sets who a dataset is shared with (the list replaces the old one; an empty list stops sharing). Only employees
   * on this client's own team can be named.
   */
  share(userId: string, workspaceId: string, datasetId: string, templateKeys: unknown): Dataset {
    this.opts.identity.require(userId, workspaceId, "task.create");
    const current = this.get(userId, workspaceId, datasetId);
    if (!Array.isArray(templateKeys) || templateKeys.some((k) => typeof k !== "string")) throw new MiningError("Choose which employees to share with.");
    const keys = [...new Set(templateKeys as string[])];
    if (keys.length > MAX_SHARED_WITH) throw new MiningError(`A dataset can be shared with up to ${MAX_SHARED_WITH} employees.`);
    const allowed = new Set(this.shareTargets(userId, workspaceId).map((e) => e.key));
    if (keys.some((k) => !allowed.has(k))) throw new MiningError("You can only share with employees on your own team.");
    const next: Dataset = { ...current, sharedWith: keys };
    this.datasets.set(workspaceId, this.mine(workspaceId).map((d) => (d.id === datasetId ? next : d)));
    this.sink?.record(workspaceId, "dataset", datasetId, next);
    this.opts.audit?.record({ workspaceId, actor: `user:${userId}`, action: "mining.dataset_shared", target: datasetId, data: { sharedWith: keys } });
    return next;
  }

  /** Deletes a dataset for good. The stored copy is overwritten, so its snippets and links are gone too. */
  remove(userId: string, workspaceId: string, datasetId: string): void {
    this.opts.identity.require(userId, workspaceId, "task.create");
    this.get(userId, workspaceId, datasetId);
    this.datasets.set(workspaceId, this.mine(workspaceId).filter((d) => d.id !== datasetId));
    this.sink?.record(workspaceId, "dataset", datasetId, { removed: true });
    this.opts.audit?.record({ workspaceId, actor: `user:${userId}`, action: "mining.dataset_removed", target: datasetId });
  }

  /** Replaces a dataset with a newer copy, in memory and in the store. */
  private put(next: Dataset): Dataset {
    this.datasets.set(next.workspaceId, this.mine(next.workspaceId).map((d) => (d.id === next.id ? next : d)));
    this.sink?.record(next.workspaceId, "dataset", next.id, next);
    return next;
  }

  /** Tells the client about a weekly check. A notification that cannot be sent is recorded and never stops the checks. */
  private tell(workspaceId: string, notice: MiningNotice): void {
    try {
      this.opts.notify?.(workspaceId, notice);
    } catch (e) {
      this.opts.audit?.record({ workspaceId, actor: "system", action: "mining.watch_notice_failed", data: { error: e instanceof Error ? e.name : "unknown" } });
    }
  }

  /**
   * Switches the weekly check on a dataset on or off. Switching on works like a search: without `confirm: true` and
   * `confirmEnergy` equal to the weekly figure, nothing changes and the call is refused with the quote, so the person
   * has always seen what a week uses at most. The sources are the original search's unless others are named; any that
   * cannot be read right now are left out of the watch. Switching off always works and keeps the history.
   */
  watch(userId: string, workspaceId: string, datasetId: string, raw: Record<string, unknown>): Dataset {
    this.opts.identity.require(userId, workspaceId, "task.create");
    const current = this.get(userId, workspaceId, datasetId);
    if (raw.on !== true) return this.stopWatch(current, userId);
    if (!this.agentOf(userId, workspaceId)) throw new MiningError(NOT_HIRED);
    const others = this.mine(workspaceId).filter((d) => d.watch && d.id !== datasetId).length;
    if (others >= MAX_WATCHES) throw new MiningError(`You can have up to ${MAX_WATCHES} weekly checks. Stop one to start another.`);
    const wanted = Array.isArray(raw.sources) ? raw.sources : current.watch?.sources ?? current.sources.map((s) => s.id);
    const { sources } = this.read({ topic: current.topic, sources: wanted });
    const quote = this.quoteFor(workspaceId, current.topic, sources);
    const ready = quote.sources.filter((s) => s.available);
    if (!ready.length) throw new MiningError(`Nothing can be checked for that right now. ${quote.sources.map((s) => s.reason).join(" ")}`);
    if (raw.confirm !== true || raw.confirmEnergy !== quote.total) {
      const left = quote.unavailable.length ? ` ${quote.unavailable.length === 1 ? "One source is" : `${quote.unavailable.length} sources are`} not available and will be left out.` : "";
      throw new MiningError(`A weekly check uses up to ${quote.total} energy each week from the team's pool. You only pay for sources that find something.${left} Confirm to switch it on.`, quote);
    }
    // Changing the sources of a watch that is already on keeps its rhythm: it cannot be used to bring a check forward.
    const since = current.watch?.since ?? new Date(this.nowMs()).toISOString();
    const nextCheckAt = current.watch?.nextCheckAt ?? nextSlot(since, this.nowMs(), this.opts.timezone?.(workspaceId));
    const next = this.put({ ...current, watch: { since, sources: ready.map((s) => s.id), maxEnergy: quote.total, nextCheckAt } });
    this.opts.audit?.record({ workspaceId, actor: `user:${userId}`, action: "mining.watch_on", target: datasetId, data: { sources: next.watch!.sources, maxEnergy: quote.total } });
    return next;
  }

  private stopWatch(current: Dataset, userId: string): Dataset {
    if (!current.watch) return current;
    const next = this.put(unwatched(current));
    this.opts.audit?.record({ workspaceId: current.workspaceId, actor: `user:${userId}`, action: "mining.watch_off", target: current.id });
    return next;
  }

  /**
   * Runs the weekly checks that are due. Called once a minute by the server; safe to call as often as you like. Each
   * week of each watch runs at most once: the next check is moved on, and stored, before anything is read. Returns
   * how many checks read their sources.
   */
  async tick(): Promise<number> {
    const agentIn = this.opts.agentIn;
    if (this.ticking || !agentIn) return 0;
    this.ticking = true;
    try {
      let ran = 0;
      for (const workspaceId of [...this.datasets.keys()]) {
        const watched = this.mine(workspaceId).filter((d) => d.watch);
        if (!watched.length) continue;
        const employeeId = agentIn(workspaceId);
        if (!employeeId) { this.stopAll(workspaceId, watched); continue; }
        for (const d of watched) {
          if (ran >= MAX_CHECKS_PER_TICK) return ran;
          if (Date.parse(d.watch!.nextCheckAt) > this.nowMs()) continue;
          if (await this.checkSafely(d, employeeId)) ran++;
        }
      }
      return ran;
    } finally {
      this.ticking = false;
    }
  }

  /** The Data mining agent is no longer on the team: every weekly check stops, the datasets stay, the client is told once. */
  private stopAll(workspaceId: string, watched: readonly Dataset[]): void {
    for (const d of watched) this.put(unwatched(d));
    this.opts.audit?.record({ workspaceId, actor: "system", action: "mining.watch_stopped", data: { reason: "agent_gone", datasets: watched.map((d) => d.id) } });
    const which = watched.length === 1 ? "your weekly market check has" : `your ${watched.length} weekly market checks have`;
    this.tell(workspaceId, { title: "Weekly market checks stopped", body: `The Data mining agent is no longer on your team, so ${which} stopped. Your saved datasets are still there.`, link: MINING_PAGE });
  }

  /** One check that can never take the scheduler down with it. The week is already marked, so a failure waits for next week. */
  private async checkSafely(d: Dataset, employeeId: string): Promise<boolean> {
    try {
      return await this.check(d, employeeId);
    } catch (e) {
      this.opts.audit?.record({ workspaceId: d.workspaceId, actor: "system", action: "mining.watch_failed", target: d.id, data: { error: e instanceof Error ? e.name : "unknown" } });
      return false;
    }
  }

  /** One due check. Returns true when the sources were read. Nothing is awaited before the energy is set aside. */
  private async check(d: Dataset, employeeId: string): Promise<boolean> {
    const { workspaceId } = d;
    const watch = d.watch!;
    // A search of the client's own is running, or their hour is full: the week stays due and a later pass tries again.
    if (this.busy.has(workspaceId) || this.runsThisHour(workspaceId) >= MAX_RUNS_PER_HOUR) return false;
    const now = this.nowMs();
    const at = new Date(now).toISOString();
    // The week is marked as handled, and stored, before anything is read: a crash half way cannot run it again.
    const marked = this.put({ ...d, watch: { ...watch, nextCheckAt: nextSlot(watch.since, now + HALF_WEEK_MS, this.opts.timezone?.(workspaceId)) } });
    const quote = this.quoteFor(workspaceId, d.topic, watch.sources.map((id) => miningSource(id)!));
    if (!quote.sources.some((s) => s.available)) {
      this.put(this.withCheck(marked, noCheck(at, `Nothing could be read this week. ${quote.sources.map((s) => s.reason).join(" ")}`)));
      return false;
    }
    if (quote.total > watch.maxEnergy) { this.stopOutgrown(marked, at, quote.total); return false; }
    if (!this.affordable(workspaceId, employeeId, quote).allowed) { this.skipForEnergy(marked, at); return false; }
    this.countRun(workspaceId);
    const reading = await this.readAndCharge(workspaceId, employeeId, quote);
    const latest = this.mine(workspaceId).find((x) => x.id === d.id);
    // Removed while it was being read: there is nothing left to update.
    if (latest) this.applyCheck(latest, reading, at, employeeId);
    return true;
  }

  private withCheck(d: Dataset, check: DatasetCheck): Dataset {
    return { ...d, checks: [check, ...(d.checks ?? [])].slice(0, MAX_CHECKS) };
  }

  /** A price went up since the client agreed: nothing is read at a figure they never saw. The watch stops and says why. */
  private stopOutgrown(d: Dataset, at: string, total: number): void {
    const agreed = d.watch!.maxEnergy;
    this.put(this.withCheck(unwatched(d), noCheck(at, `Stopped: a check would now use up to ${total} energy, more than the ${agreed} you agreed to.`)));
    this.opts.audit?.record({ workspaceId: d.workspaceId, actor: "system", action: "mining.watch_stopped", target: d.id, data: { reason: "energy_changed", agreed, now: total } });
    this.tell(d.workspaceId, { title: "Weekly market check stopped", body: `The weekly check on "${d.topic}" would now use up to ${total} energy, more than the ${agreed} you agreed to, so it has stopped. Nothing was used. You can switch it on again on the Market data page.`, link: `${MINING_PAGE}/${d.id}` });
  }

  /** Too little energy this week: nothing is read, the client is told once, and next week tries again. */
  private skipForEnergy(d: Dataset, at: string): void {
    const watch = d.watch!;
    this.put(this.withCheck({ ...d, watch: { ...watch, lowEnergyTold: true } }, noCheck(at, "Skipped: the team did not have enough energy.")));
    this.opts.audit?.record({ workspaceId: d.workspaceId, actor: "system", action: "mining.watch_skipped", target: d.id, data: { reason: "energy" } });
    if (watch.lowEnergyTold) return;
    this.tell(d.workspaceId, { title: "Weekly market check skipped", body: `"${d.topic}" was not checked this week because the team is low on energy. Nothing was used. It will try again next week.`, link: `${MINING_PAGE}/${d.id}` });
  }

  /** Lays this week's reading over the dataset, records what changed, and tells the client only if something did. */
  private applyCheck(latest: Dataset, reading: Reading, at: string, employeeId: string): void {
    const found = reading.sources.some((s) => s.status === "ok");
    const change = compareSources(latest.sources, reading.sources);
    const summary = changeSummary(latest.topic, change);
    const note = missedNote(reading.sources);
    const check: DatasetCheck = {
      at, status: !found ? "skipped" : summary ? "changed" : "same", summary, energyUsed: reading.energyUsed,
      newItems: change.newItems.slice(0, MAX_NEW_ITEMS), figures: change.figures, ...(note ? { note } : {}),
    };
    const sources = mergeSources(latest.sources, reading.sources);
    this.put({
      ...this.withCheck(latest, check), sources,
      ...(found ? { updatedAt: at, summary: summarise(latest.topic, sources, at.slice(0, 10)) } : {}),
      // A check ran, so a later shortage of energy is worth telling the client about again.
      ...(latest.watch ? { watch: { ...latest.watch, lowEnergyTold: false } } : {}),
    });
    this.opts.audit?.record({ workspaceId: latest.workspaceId, actor: `employee:${employeeId}`, action: "mining.watch_checked", target: latest.id, data: { status: check.status, energy: reading.energyUsed, newItems: change.newItems.length, figures: change.figures.length } });
    if (summary) this.tell(latest.workspaceId, { title: "Your weekly market check found something new", body: summary, link: `${MINING_PAGE}/${latest.id}` });
  }

  /**
   * What an employee is told with each task: the datasets shared with it, newest first and capped. The Data mining
   * agent itself always sees the client's latest datasets. Platform-level (no user check): the workforce calls it
   * for an employee that is already known to belong to this workspace.
   */
  contextFor(workspaceId: string, templateKey: string): string | undefined {
    const all = this.mine(workspaceId);
    if (templateKey === DATA_MINING_AGENT) {
      return renderContext(all) ?? "Datasets: none have been gathered yet. If you are asked what people are saying or for market data, say there is no dataset on it and ask the owner to gather one on the Data mining page. Never make up posts, figures or sources.";
    }
    return renderContext(all.filter((d) => d.sharedWith.includes(templateKey)));
  }
}
