/**
 * What the Connections page remembers about each service besides its details: when each saved detail was last
 * changed, and the result of the last test. Kept as one record through the same encrypted store as the details, so
 * a reload or a restart still shows "last changed" and "last tested". It never holds a secret: test messages are
 * redacted before they reach here, and a "changed" entry is only a field name and a time.
 */
export interface StoredTest { ok: boolean; message: string; details: string[]; at: string }
export interface ConnMeta { changed: Record<string, Record<string, string>>; tests: Record<string, StoredTest> }

/** The store key for this record. It can never clash with a connection key, which has no colon. */
export const META_STORE_KEY = "conn:meta";

const MAX_MESSAGE = 600;
const MAX_DETAILS = 8;
const isIso = (x: unknown): x is string => typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x));
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export const packMeta = (m: ConnMeta): string => JSON.stringify(m);

function readTest(x: unknown): StoredTest | undefined {
  if (!isRecord(x) || typeof x.ok !== "boolean" || typeof x.message !== "string" || !isIso(x.at)) return undefined;
  const details = Array.isArray(x.details) ? x.details.filter((d): d is string => typeof d === "string").slice(0, MAX_DETAILS).map((d) => d.slice(0, MAX_MESSAGE)) : [];
  return { ok: x.ok, message: x.message.slice(0, MAX_MESSAGE), details, at: x.at };
}

/**
 * Reads a stored record back. Nothing in it is trusted: only services and fields that exist today are kept
 * (`fieldsOf` returns a service's field names, or undefined for an unknown service), and every value is checked.
 */
export function unpackMeta(secret: string, fieldsOf: (key: string) => readonly string[] | undefined): ConnMeta {
  const out: ConnMeta = { changed: {}, tests: {} };
  let raw: unknown;
  try { raw = JSON.parse(secret); } catch { return out; }
  if (!isRecord(raw)) return out;
  for (const [key, v] of Object.entries(isRecord(raw.changed) ? raw.changed : {})) {
    const fields = fieldsOf(key);
    if (!fields || !isRecord(v)) continue;
    const kept = Object.entries(v).filter((e): e is [string, string] => fields.includes(e[0]) && isIso(e[1]));
    if (kept.length) out.changed[key] = Object.fromEntries(kept);
  }
  for (const [key, v] of Object.entries(isRecord(raw.tests) ? raw.tests : {})) {
    const t = fieldsOf(key) ? readTest(v) : undefined;
    if (t) out.tests[key] = t;
  }
  return out;
}
