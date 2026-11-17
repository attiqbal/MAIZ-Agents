import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Running pg_dump and pg_restore. Behind an interface so tests never start a real program. */
export interface ProgramResult { code: number; stderr: string }
export interface RunOptions {
  /** Extra environment for the program (the database address and password travel here, never on the command line). */
  env?: Readonly<Record<string, string>>;
  /** Where the program's output goes. It is ended when the program stops. */
  stdout?: Writable;
  timeoutMs?: number;
}
export type ProgramRunner = (program: string, args: readonly string[], opts?: RunOptions) => Promise<ProgramResult>;

/** The program is not installed on this server. */
export class ProgramMissing extends Error {
  constructor(readonly program: string) { super(`${program} is not installed`); }
}

const STDERR_KEEP = 4_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Starts real programs. They get a small environment of their own (the search path, English messages and what the
 * caller passes), so none of the server's other secrets are handed to them. `binDir` is where the Postgres tools
 * live when they are not on the search path (PG_BIN_DIR).
 */
export function spawnRunner(binDir?: string): ProgramRunner {
  return (program, args, opts = {}) => new Promise<ProgramResult>((resolve, reject) => {
    const child = spawn(binDir ? join(binDir, program) : program, [...args], {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C", ...opts.env },
      stdio: ["ignore", opts.stdout ? "pipe" : "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stderr!.on("data", (d: Buffer) => { if (stderr.length < STDERR_KEEP) stderr += d.toString("utf8"); });
    const piped: Promise<unknown> = opts.stdout && child.stdout ? pipeline(child.stdout, opts.stdout).then(() => undefined, (e: unknown) => e) : Promise.resolve(undefined);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      opts.stdout?.destroy(e);
      reject(e.code === "ENOENT" || e.code === "EACCES" ? new ProgramMissing(program) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      void piped.then((pipeError) => {
        if (timedOut) resolve({ code: -1, stderr: `${program} was stopped because it took too long` });
        else if (pipeError) reject(pipeError);
        else resolve({ code: code ?? -1, stderr: stderr.slice(0, STDERR_KEEP) });
      });
    });
  });
}

/**
 * The environment pg_dump and pg_restore read a database address from, built from a postgres:// address.
 * `database` replaces the database name (the throwaway copy of a restore test).
 */
export function connectionEnv(databaseUrl: string, database?: string): Record<string, string> {
  const u = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: u.searchParams.get("host") || decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGDATABASE: database ?? (decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres"),
    PGCONNECT_TIMEOUT: "15",
  };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}
