import { BackupBusy, BackupError, NIGHTLY_TIME, type JobKind } from "../modules/backup/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });

/**
 * Public, for the uptime check (.github/workflows/uptime.yml): are backups fresh? Says only yes or no. It is "yes"
 * until backups are set up, so the check cannot fail before set-up; after that it is "no" (503) when the newest good
 * backup is more than 36 hours old.
 */
export function backupHealthRoute(req: Req, p: Platform): Res | undefined {
  if (req.method !== "GET" || req.path !== "/api/health/backups") return undefined;
  const { ok } = p.backup.health();
  return json(ok ? 200 : 503, { ok });
}

/**
 * The owner's Backups page: status, the storage details (typed in the browser, stored encrypted, the secret never
 * sent back), the recovery key (handed over once), "Back up now" and "Test a restore now". The two jobs answer at
 * once and carry on after the reply, because a backup can outlast one request; the page asks again until it is done.
 * Platform owner only: checked here and again in the service.
 */
export async function backupOwnerRoute(req: Req, userId: string, p: Platform, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (path !== "/api/owner/backups" && !path.startsWith("/api/owner/backups/")) return undefined;
  if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can manage backups" });
  const b = p.backup;
  const view = async () => ({ ...(await b.view(userId)), nightlyTime: NIGHTLY_TIME, persistent: p.hasStore() && p.healthy() });
  const start = async (what: JobKind): Promise<Res> => {
    const { done } = await b.begin(userId, what);
    return { status: 202, body: await view(), after: () => done };
  };
  try {
    if (method === "GET" && path === "/api/owner/backups") return json(200, await view());
    if (method === "PUT" && path === "/api/owner/backups/storage") { await b.saveStorage(userId, body()); return json(200, await view()); }
    if (method === "POST" && path === "/api/owner/backups/storage/remove") { b.removeStorage(userId); return json(200, await view()); }
    if (method === "POST" && path === "/api/owner/backups/recovery-key") {
      const { recoveryKey } = b.makeRecoveryKey(userId, { replace: body().replace === true });
      return json(201, { recoveryKey, view: await view() });
    }
    if (method === "POST" && path === "/api/owner/backups/recovery-key/saved") { b.confirmKeySaved(userId); return json(200, await view()); }
    if (method === "POST" && path === "/api/owner/backups/run") return await start("backup");
    if (method === "POST" && path === "/api/owner/backups/restore-test") return await start("restore_test");
  } catch (e) {
    if (e instanceof BackupBusy) return json(409, { error: e.message });
    if (e instanceof BackupError) return json(400, { error: e.message });
    throw e;
  }
  return json(404, { error: "not found" });
}
