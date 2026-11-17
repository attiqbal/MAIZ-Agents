import pg from "pg";
import type { TableCounts } from "./types.js";

/**
 * The database side of a restore test: a throwaway database next to the live one, counted and then dropped.
 * Behind an interface so tests need no database.
 */
export interface DbAdmin {
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  /** Databases whose names start with `prefix` (copies a cut-off test left behind). */
  listDatabases(prefix: string): Promise<string[]>;
  /** Rows found in a restored copy. */
  counts(database: string): Promise<TableCounts>;
  /** How many clients the live database already had at that moment. */
  clientsBefore(iso: string): Promise<number>;
}

/** Every throwaway database is named like this, and nothing else is ever created or dropped. */
export const RESTORE_DB_PREFIX = "maiz_restore_test_";
const RESTORE_DB_NAME = /^maiz_restore_test_[a-z0-9]{1,40}$/;
const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 120_000;
/** Every table of db/*.sql that holds clients' or the platform's rows. */
const RECORD_TABLES = ["memberships", "employees", "journal_entries", "journal_lines", "energy_usage", "audit_log", "state_records", "platform_records"] as const;

function throwaway(name: string): string {
  if (!RESTORE_DB_NAME.test(name)) throw new Error(`refusing to touch a database named ${name}`);
  return `"${name}"`;
}

/** The real thing, through the same administrator address the app's storage uses (DATABASE_URL). */
export function pgAdmin(databaseUrl: string): DbAdmin {
  const urlFor = (database?: string): string => {
    if (!database) return databaseUrl;
    const u = new URL(databaseUrl);
    u.pathname = `/${database}`;
    return u.toString();
  };
  async function withClient<T>(database: string | undefined, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: urlFor(database), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, statement_timeout: QUERY_TIMEOUT_MS });
    await client.connect();
    try { return await fn(client); } finally { await client.end().catch(() => undefined); }
  }
  return {
    createDatabase: (name) => withClient(undefined, async (c) => { await c.query(`CREATE DATABASE ${throwaway(name)}`); }),
    dropDatabase: (name) => withClient(undefined, async (c) => { await c.query(`DROP DATABASE IF EXISTS ${throwaway(name)} WITH (FORCE)`); }),
    listDatabases: (prefix) => withClient(undefined, async (c) => {
      const r = await c.query("SELECT datname FROM pg_database WHERE left(datname, length($1)) = $1 ORDER BY datname", [prefix]);
      return r.rows.map((row: { datname: string }) => row.datname).filter((n) => RESTORE_DB_NAME.test(n));
    }),
    counts: (database) => withClient(throwaway(database) && database, async (c) => {
      // Count every row, or fail loudly: with row security in force a count could quietly come back as nought.
      await c.query("SET row_security = off");
      const records = RECORD_TABLES.map((t) => `(SELECT count(*) FROM ${t})`).join(" + ");
      const r = await c.query(`SELECT (SELECT count(*) FROM workspaces)::text AS clients, (${records})::text AS records, (SELECT count(*) FROM schema_migrations)::text AS migrations`);
      const row = r.rows[0] as { clients: string; records: string; migrations: string };
      return { clients: Number(row.clients), records: Number(row.records), migrations: Number(row.migrations) };
    }),
    clientsBefore: (iso) => withClient(undefined, async (c) => {
      const r = await c.query("SELECT count(*)::text AS n FROM workspaces WHERE created_at <= $1", [iso]);
      return Number((r.rows[0] as { n: string }).n);
    }),
  };
}
