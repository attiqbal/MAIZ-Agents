import { localParts, localToInstant } from "../batch/schedule.js";
import type { BackupState } from "./types.js";

/** When the nightly backup and the weekly restore test are due. Pure: the service passes in the time and what it remembers. */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** The nightly backup starts at 03:10 in the owner's time zone: after every client's midnight jobs, before anyone is at work. */
export const NIGHTLY_AT = { hour: 3, minute: 10 };
/** The weekly restore test starts an hour later, so it tests that night's backup. */
export const RESTORE_TEST_AT = { hour: 4, minute: 10 };
/** A nightly backup that fails is tried again each hour, this many times in all. */
export const NIGHTLY_TRIES = 3;
export const RETRY_GAP_MS = HOUR_MS;
export const RESTORE_TEST_EVERY_MS = 7 * DAY_MS;
/** No good backup for this long is a problem worth an alert, and turns the public health check false. */
export const STALE_AFTER_MS = 36 * HOUR_MS;
/** The same problem is reported at most once in this long. */
export const ALERT_GAP_MS = DAY_MS;

/** A time zone the server knows, or Europe/London. */
export function safeZone(zone: string | undefined): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone || "Europe/London" });
    return zone || "Europe/London";
  } catch {
    return "Europe/London";
  }
}

export interface LocalClock { date: string; minutes: number }
export function localClock(at: Date, zone: string): LocalClock {
  const l = localParts(at, zone);
  return { date: `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`, minutes: l.hh * 60 + l.mm };
}
const minutesOf = (t: { hour: number; minute: number }): number => t.hour * 60 + t.minute;

/** True when tonight's backup has not been made yet, or failed and is due another try. */
export function nightlyDue(state: BackupState, at: Date, zone: string): boolean {
  const local = localClock(at, zone);
  if (local.minutes < minutesOf(NIGHTLY_AT)) return false;
  const n = state.nightly;
  if (!n || n.date !== local.date) return true;
  return !n.done && n.attempts < NIGHTLY_TRIES && at.getTime() - Date.parse(n.lastAttemptAt) >= RETRY_GAP_MS;
}

/**
 * True when a restore test should start by itself: straight after the very first backup, then once a week, and the
 * day after a test that failed. Never more than one automatic test a day.
 */
export function restoreTestDue(state: BackupState, at: Date, zone: string): boolean {
  if (!state.lastBackup) return false;
  const now = at.getTime();
  if (state.autoRestoreAt && now - Date.parse(state.autoRestoreAt) < DAY_MS) return false;
  const last = state.lastRestoreTest;
  if (!last) return true;
  if (localClock(at, zone).minutes < minutesOf(RESTORE_TEST_AT)) return false;
  return !last.ok || now - Date.parse(last.at) >= RESTORE_TEST_EVERY_MS;
}

/** The next 03:10 in the owner's time zone, strictly after `at`. */
export function nextNightly(at: Date, zone: string): Date {
  const l = localParts(at, zone);
  const today = localToInstant(zone, l.y, l.m, l.d, NIGHTLY_AT.hour, NIGHTLY_AT.minute);
  if (today.getTime() > at.getTime()) return today;
  const t = localParts(new Date(Date.UTC(l.y, l.m - 1, l.d + 1, 12)), "UTC");
  return localToInstant(zone, t.y, t.m, t.d, NIGHTLY_AT.hour, NIGHTLY_AT.minute);
}

/** "16 November at 03:10" in the owner's time zone. */
export function sayWhen(iso: string, zone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "long" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${day} at ${time}`;
}
