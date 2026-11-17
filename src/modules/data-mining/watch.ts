import { localParts, localToInstant } from "../batch/schedule.js";
import type { DatasetSource } from "./dataset.js";
import type { MiningItem, MiningSourceId } from "./sources.js";

/**
 * The weekly watch on a dataset: the pure parts. When a check is due, what changed between two readings of the same
 * sources, and the one short line the client is sent. Nothing here reads the network or the clock.
 */

/** Checks kept per dataset: the latest and a short history behind it. */
export const MAX_CHECKS = 8;
/** Weekly checks one client may have switched on at a time. */
export const MAX_WATCHES = 10;
/** The hour of the client's own night a check waits for, when their time zone is known. */
export const WATCH_QUIET_HOUR = 3;
/** New items listed in one check. The count in the summary is always the full number. */
export const MAX_NEW_ITEMS = 10;
const MAX_FIGURES_IN_SUMMARY = 3;
const MAX_SUMMARY_LENGTH = 240;
const WEEK_MS = 7 * 86_400_000;
/** How far ahead a slot is looked for when the time zone is known (a guard, never reached in practice). */
const MAX_WEEKS_AHEAD = 4;

/** A weekly check the client switched on, with the most energy a week may use: the figure they saw and agreed to. */
export interface DatasetWatch {
  since: string;
  sources: MiningSourceId[];
  maxEnergy: number;
  nextCheckAt: string;
  /** Set once the client has been told a week was skipped for lack of energy, so they are not told every week. */
  lowEnergyTold?: boolean;
}

export type CheckStatus = "changed" | "same" | "skipped";
export interface NewItem extends MiningItem { sourceId: MiningSourceId }
export interface FigureChange { label: string; from: string; to: string }
export interface SourceChange { newItems: NewItem[]; figures: FigureChange[] }

/** One weekly check as it is kept and shown under "What changed". */
export interface DatasetCheck {
  at: string;
  status: CheckStatus;
  /** The one line the client was sent, or empty when nothing changed. */
  summary: string;
  energyUsed: number;
  newItems: NewItem[];
  figures: FigureChange[];
  /** Anything the client should know about this check, for example a source that could not be read. */
  note?: string;
}

/**
 * When the next check is due, strictly after `nowMs`. With no time zone it is every seven days from the moment the
 * watch was switched on. With one, it is the same weekday at a quiet hour of the client's own night.
 */
export function nextSlot(since: string, nowMs: number, timezone: string | undefined): string {
  const start = Date.parse(since);
  const weeks = Math.floor(Math.max(0, nowMs - start) / WEEK_MS);
  if (timezone) {
    try {
      const day = localParts(new Date(start), timezone);
      for (let k = Math.max(1, weeks); k <= weeks + MAX_WEEKS_AHEAD; k++) {
        const slot = localToInstant(timezone, day.y, day.m, day.d + 7 * k, WATCH_QUIET_HOUR, 0).getTime();
        if (slot > nowMs) return new Date(slot).toISOString();
      }
    } catch {
      // A time zone this server does not know: fall back to plain weeks, below.
    }
  }
  return new Date(start + (weeks + 1) * WEEK_MS).toISOString();
}

/** The latest value of each figure. Figures arrive newest first, so the first of each label is its latest. */
function latestFigures(source: DatasetSource | undefined): Map<string, string> {
  const latest = new Map<string, string>();
  for (const f of source?.figures ?? []) if (!latest.has(f.label)) latest.set(f.label, f.value);
  return latest;
}

/**
 * What is different in this week's reading: items whose address was not there before, and figures whose latest value
 * moved. Items that are no longer there are not reported. A source that was not read this week (failed, not
 * available, or found nothing) is left out, so a bad week is never reported as "everything is new" the week after.
 */
export function compareSources(before: readonly DatasetSource[], now: readonly DatasetSource[]): SourceChange {
  const newItems: NewItem[] = [];
  const figures: FigureChange[] = [];
  for (const fresh of now) {
    if (fresh.status !== "ok") continue;
    const old = before.find((s) => s.id === fresh.id);
    const seen = new Set((old?.items ?? []).map((i) => i.url));
    for (const item of fresh.items) if (!seen.has(item.url)) newItems.push({ ...item, sourceId: fresh.id });
    const was = latestFigures(old);
    for (const [label, to] of latestFigures(fresh)) {
      const from = was.get(label);
      if (from !== undefined && from !== to) figures.push({ label, from, to });
    }
  }
  return { newItems, figures };
}

/** This week's reading laid over the last one: a source that found something replaces its old data, any other keeps it. */
export function mergeSources(before: readonly DatasetSource[], now: readonly DatasetSource[]): DatasetSource[] {
  const fresh = new Map(now.filter((s) => s.status === "ok").map((s) => [s.id, s]));
  const kept = before.map((s) => fresh.get(s.id) ?? s);
  return [...kept, ...[...fresh.values()].filter((s) => !before.some((b) => b.id === s.id))];
}

const NOUNS: Partial<Record<MiningSourceId, [string, string]>> = {
  news: ["new article", "new articles"],
  hackernews: ["new discussion", "new discussions"],
  reddit: ["new conversation", "new conversations"],
  youtube: ["new video", "new videos"],
  x: ["new post on X", "new posts on X"],
  companies: ["new company record", "new company records"],
};

/** "Inflation, consumer prices (% a year)" becomes "inflation"; a name in capitals such as "IBM share price" is kept. */
function shortLabel(label: string): string {
  const head = label.split(/[,(]/)[0]!.trim() || label;
  return /^\p{Lu}\p{Ll}/u.test(head) ? head[0]!.toLowerCase() + head.slice(1) : head;
}

/**
 * The one line a client is sent, for example "Oat milk prices: 3 new articles, inflation moved from 3.4% to 3.6%".
 * Empty when nothing changed, which is how the caller knows not to send anything.
 */
export function changeSummary(topic: string, change: SourceChange): string {
  const counts = new Map<MiningSourceId, number>();
  for (const item of change.newItems) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
  const found = [...counts].map(([id, n]) => {
    const [one, many] = NOUNS[id] ?? ["new item", "new items"];
    return `${n} ${n === 1 ? one : many}`;
  });
  const moved = change.figures.slice(0, MAX_FIGURES_IN_SUMMARY).map((f) => {
    const unit = f.label.includes("%") ? "%" : "";
    return `${shortLabel(f.label)} moved from ${f.from}${unit} to ${f.to}${unit}`;
  });
  const parts = [...found, ...moved];
  if (!parts.length) return "";
  const line = `${topic.charAt(0).toUpperCase()}${topic.slice(1)}: ${parts.join(", ")}`;
  return line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…` : line;
}

/** What to say about sources that added nothing this week, or undefined when every source found something. */
export function missedNote(read: readonly DatasetSource[]): string | undefined {
  const notRead = read.filter((s) => s.status === "failed" || s.status === "unavailable").map((s) => s.label);
  const nothing = read.filter((s) => s.status === "empty").map((s) => s.label);
  const lines = [
    notRead.length ? `Could not be read this week, so the last results were kept: ${notRead.join(", ")}.` : "",
    nothing.length ? `Found nothing this week, so the last results were kept: ${nothing.join(", ")}.` : "",
  ].filter(Boolean);
  return lines.length ? lines.join(" ") : undefined;
}
