import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { DbAdmin, ProgramRunner, RunOptions } from "../src/modules/backup/index.js";
import { ProgramMissing } from "../src/modules/backup/index.js";
import { signV4 } from "../src/modules/backup/sigv4.js";
import type { TableCounts } from "../src/modules/backup/types.js";

/** Stand-ins for everything the backup feature touches outside the process: the storage service, the database programs and the database. */

export const STORAGE = { host: "abc123.r2.cloudflarestorage.com", bucket: "maiz-backups", keyId: "KEYID123456", secret: "s3cr3t/with+odd=chars", region: "auto" };
export const STORAGE_FORM = { address: `https://${STORAGE.host}`, bucket: STORAGE.bucket, keyId: STORAGE.keyId, secret: STORAGE.secret };

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const errorXml = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;

export interface FakeCall { method: string; url: string; headers: Record<string, string>; bytes: number }

/**
 * An S3-compatible storage service in memory. It checks every request the way the real ones do: the signature must
 * match the address and headers that were actually sent, and the body must match the SHA-256 that was signed.
 */
export function fakeStorage(opts: { pageSize?: number } = {}) {
  const objects = new Map<string, { body: Buffer; lastModified: string }>();
  const calls: FakeCall[] = [];
  const state: { fail?: (c: FakeCall) => { status: number; code?: string } | "network" | undefined; clock: () => Date; deniedDelete: boolean } = { clock: () => new Date(), deniedDelete: false };

  const http = (async (input: string | URL, init: { method?: string; headers?: Record<string, string>; body?: Blob | Uint8Array; redirect?: string } = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body === undefined ? Buffer.alloc(0) : init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : Buffer.from(init.body);
    const call: FakeCall = { method, url: url.toString(), headers, bytes: body.length };
    calls.push(call);
    const reply = (status: number, text = "", extra: Record<string, string> = {}) => new Response(status === 204 || status === 304 ? null : text, { status, headers: { "content-type": "application/xml", ...extra } });
    const forced = state.fail?.(call);
    if (forced === "network") throw new TypeError("fetch failed");
    if (forced) return reply(forced.status, forced.code ? errorXml(forced.code) : "");
    if (url.protocol !== "https:" || url.host !== STORAGE.host || init.redirect !== "manual") return reply(400, errorXml("BadRequest"));

    // Signature: sign again from what arrived and compare.
    const stamp = headers["x-amz-date"] ?? "";
    const at = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    const { authorization, ...signedHeaders } = headers;
    delete signedHeaders["x-amz-date"]; delete signedHeaders["x-amz-content-sha256"];
    const path = url.pathname.split("/").map(decodeURIComponent).join("/");
    const expected = signV4({ method, host: url.host, path, query: Object.fromEntries(url.searchParams), headers: signedHeaders, payloadHash: headers["x-amz-content-sha256"] ?? "", accessKeyId: STORAGE.keyId, secretAccessKey: STORAGE.secret, region: STORAGE.region, now: at });
    if (!authorization?.includes(`Credential=${STORAGE.keyId}/`)) return reply(403, errorXml("InvalidAccessKeyId"));
    if (authorization !== expected.headers.authorization || expected.url !== url.toString()) return reply(403, errorXml("SignatureDoesNotMatch"));
    if (headers["x-amz-content-sha256"] !== createHash("sha256").update(body).digest("hex")) return reply(400, errorXml("XAmzContentSHA256Mismatch"));

    const [, bucket, ...rest] = path.split("/");
    if (bucket !== STORAGE.bucket) return reply(404, errorXml("NoSuchBucket"));
    const key = rest.join("/");
    if (method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = Number(url.searchParams.get("continuation-token") ?? 0);
      const size = opts.pageSize ?? 1000;
      const page = all.slice(from, from + size);
      const more = from + size < all.length;
      return reply(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + size}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k)!.lastModified}</LastModified><ETag>&quot;x&quot;</ETag><Size>${objects.get(k)!.body.length}</Size></Contents>`).join("")}</ListBucketResult>`);
    }
    if (!key) return reply(400, errorXml("BadRequest"));
    if (method === "PUT") { objects.set(key, { body, lastModified: state.clock().toISOString() }); return reply(200); }
    if (method === "GET") { const o = objects.get(key); return o ? new Response(o.body as unknown as BodyInit, { status: 200, headers: { "content-length": String(o.body.length) } }) : reply(404, errorXml("NoSuchKey")); }
    if (method === "DELETE") { if (state.deniedDelete) return reply(403, errorXml("AccessDenied")); objects.delete(key); return reply(204); }
    return reply(405, errorXml("MethodNotAllowed"));
  }) as unknown as typeof fetch;

  return { http, objects, calls, state, keys: () => [...objects.keys()].sort() };
}

/** What a real `pg_dump -Fc` file starts with. */
export const FAKE_DUMP = Buffer.concat([Buffer.from("PGDMP"), Buffer.from("fake dump of the MAIZ database ".repeat(200))]);

/**
 * pg_dump and pg_restore that touch nothing: pg_dump writes FAKE_DUMP to its output, pg_restore remembers the file it
 * was given. `plan` changes how the next runs end.
 */
export function fakePrograms() {
  const runs: { program: string; args: string[]; env: Record<string, string> }[] = [];
  const restored: { database: string; dump: Buffer }[] = [];
  const plan: { missing?: boolean; dump?: Buffer; dumpFails?: { code: number; stderr: string }; restoreFails?: { code: number; stderr: string }; version?: string; hold?: Promise<void> } = {};
  const run: ProgramRunner = async (program: string, args: readonly string[], o: RunOptions = {}) => {
    runs.push({ program, args: [...args], env: { ...(o.env ?? {}) } });
    if (plan.missing) throw new ProgramMissing(program);
    if (args.includes("--version")) { o.stdout?.end(`${program} (PostgreSQL) ${plan.version ?? "16.4 (Debian 16.4-1.pgdg120+1)"}\n`); return { code: 0, stderr: "" }; }
    if (plan.hold) await plan.hold;
    if (program === "pg_dump") {
      if (plan.dumpFails) { o.stdout?.end(Buffer.from("PGDMP partial")); return plan.dumpFails; }
      o.stdout?.end(plan.dump ?? FAKE_DUMP);
      return { code: 0, stderr: "" };
    }
    if (program === "pg_restore") {
      if (plan.restoreFails) return plan.restoreFails;
      const { readFileSync } = await import("node:fs");
      restored.push({ database: args[args.indexOf("--dbname") + 1]!, dump: readFileSync(args[args.length - 1]!) });
      return { code: 0, stderr: "" };
    }
    return { code: 127, stderr: "unknown program" };
  };
  return { run, runs, restored, plan };
}

/** The database side of a restore test: throwaway databases are just names in a set, with counts the test chooses. */
export function fakeDb(live: TableCounts = { clients: 3, records: 240, migrations: 4 }) {
  const databases = new Set<string>();
  const log: string[] = [];
  const state: { live: TableCounts; restored: TableCounts | Error; createFails?: Error; liveAsOf: (iso: string) => number } = { live, restored: { ...live }, liveAsOf: () => live.clients };
  const db: DbAdmin = {
    async createDatabase(name) { log.push(`create ${name}`); if (state.createFails) throw state.createFails; databases.add(name); },
    async dropDatabase(name) { log.push(`drop ${name}`); databases.delete(name); },
    async listDatabases(prefix) { return [...databases].filter((d) => d.startsWith(prefix)); },
    async counts(name) { if (!databases.has(name)) throw new Error(`database "${name}" does not exist`); if (state.restored instanceof Error) throw state.restored; return state.restored; },
    async clientsBefore(iso) { return state.liveAsOf(iso); },
  };
  return { db, databases, log, state };
}

/** Writes a file the way a crashed run would have left it. */
export const leftover = (path: string): void => writeFileSync(path, "left by a run that was cut off");
