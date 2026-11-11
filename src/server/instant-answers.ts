import { matchInstant, type InstantTopic } from "../modules/workforce/instant.js";
import type { InstantAnswerer } from "../modules/workforce/index.js";
import type { RotaService } from "../modules/rota/index.js";
import type { Ledger } from "../modules/ledger/index.js";
import type { EnergyMeter } from "../modules/energy/index.js";
import type { BatchService } from "../modules/batch/service.js";
import type { WorkforceService } from "../modules/workforce/index.js";

interface Deps { rota: RotaService; ledger: Ledger; energy: EnergyMeter; batch: BatchService; workforce: WorkforceService; now: () => Date }

const FOOTER = "\n\n(Straight from your records: no AI was used, so it cost no energy.)";
const n0 = (n: number) => n.toLocaleString("en-GB");

/** Money in minor units, in the business's currency when it has one. */
function money(minor: number, currency?: string): string {
  const major = minor / 100;
  try {
    return currency ? new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(major) : major.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch { return major.toFixed(2); }
}

/** Today's date (YYYY-MM-DD) on the business's own clock. */
function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Builds the workforce's instant answerer from the real services. Any problem (no books yet, no staff, a missing
 * permission) returns undefined, so the question simply goes the normal route and is answered there.
 */
export function makeInstantAnswerer(d: Deps): InstantAnswerer {
  return (userId, workspaceId, brief) => {
    const topic = matchInstant(brief);
    if (!topic) return undefined;
    try {
      const text = answer(d, topic, userId, workspaceId);
      return text ? text + FOOTER : undefined;
    } catch {
      return undefined;
    }
  };
}

function answer(d: Deps, topic: InstantTopic, userId: string, ws: string): string | undefined {
  const tz = d.batch.scheduleOf(ws).timezone;
  const today = localDate(d.now(), tz);
  const currency = d.workforce.profileOf(userId, ws)?.currency;
  switch (topic) {
    case "who_in_today": {
      const week = d.rota.week(userId, ws, today);
      if (week.staff.length === 0) return undefined;
      const mine = week.shifts.filter((s) => s.date === today);
      if (mine.length === 0) return "Nobody is on the rota today.";
      const name = (id: string | null | undefined) => week.staff.find((p) => p.id === id)?.name ?? "OPEN (nobody assigned yet)";
      const lines = mine.map((s) => `- ${s.start} to ${s.end}: ${name(s.staffId)}${s.role ? ` (${s.role})` : ""}`);
      return `On the rota today:\n${lines.join("\n")}`;
    }
    case "hours_this_week": {
      const w = d.rota.week(userId, ws, today);
      if (w.staff.length === 0) return undefined;
      const cost = w.totalCostMinor !== null ? ` Labour cost: ${money(w.totalCostMinor, currency)}.` : " Labour cost is not shown because someone with hours has no pay rate on file.";
      return `This week (${w.weekStart} to ${w.weekEnd}): ${w.totalHours} hours across ${w.shifts.length} shifts, ${w.openShifts} still open.${cost}`;
    }
    case "cash_runway": {
      const r = d.ledger.runway(userId, ws, today);
      const trend = r.runwayMonths === null ? "Cash is not shrinking, so runway is not limited." : `At the current burn of ${money(r.monthlyBurn, currency)} a month, that lasts about ${r.runwayMonths} months.`;
      return `Cash in the bank: ${money(r.cashNow, currency)} (as of ${today}). ${trend}`;
    }
    case "energy_left": {
      const t = d.energy.teamEnergy(userId, ws);
      if (!t) return undefined;
      const when = t.refillsAt ? `It refills ${new Date(t.refillsAt).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}.` : "That covers the rest of your trial.";
      const top = t.topUpLeft > 0 ? ` You also have ${n0(t.topUpLeft)} top-up energy saved.` : "";
      return `Your team has ${n0(t.left)} energy left (${t.percentUsed}% of ${n0(t.pool)} used); ${n0(t.leftToday)} of it is available today. ${when}${top}`;
    }
    case "next_batch": {
      const b = d.batch.forClient(userId, ws);
      if (b.queued === 0) return `Nothing is waiting for a batch. Your next batch would run ${b.nextRunLabel}.`;
      return `${b.queued} task${b.queued === 1 ? " is" : "s are"} waiting. The next batch runs ${b.nextRunLabel}. You can run it sooner from the Tasks screen.`;
    }
  }
}
