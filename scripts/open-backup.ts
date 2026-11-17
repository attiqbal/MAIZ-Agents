/**
 * Opens a MAIZ Agents backup file with the recovery key, for a real restore after the server has been lost
 * (docs/BACKUPS.md, "Restoring for real"). It needs nothing but this repository and the key: no server, no database.
 *
 *   MAIZ_RECOVERY_KEY='XXXXX-XXXXX-...' npm run backup:open -- maiz-nightly-20261116T031000Z.backup maiz.dump
 *
 * Writes the plain database dump to the second path (for pg_restore) and, next to it, <dump>.server-keys.env with the
 * TOKEN_KEY the old server used. Both are readable by you only. Delete them when the restore is done.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { BackupError } from "../src/modules/backup/types.js";
import { openSealed, parseRecoveryKey, readHeader } from "../src/modules/backup/seal.js";

async function main(): Promise<number> {
  const [source, dest] = process.argv.slice(2);
  if (!source || !dest) {
    console.error("Usage: MAIZ_RECOVERY_KEY='...' npm run backup:open -- <backup file> <where to write the dump>");
    return 2;
  }
  const { header } = await readHeader(source);
  console.log(`Backup made ${header.madeAt} (${header.kind}). It needs the recovery key with id ${header.keyId}.`);
  let typed = process.env.MAIZ_RECOVERY_KEY;
  if (!typed) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    typed = await rl.question("Recovery key: ");
    rl.close();
  }
  const opened = await openSealed(source, dest, [parseRecoveryKey(typed)]);
  console.log(`Opened. The database dump is in ${dest}`);
  const keys = Object.entries(opened.serverKeys ?? {});
  if (keys.length) {
    const file = `${dest}.server-keys.env`;
    writeFileSync(file, `${keys.map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600, flag: "wx" });
    console.log(`The old server's ${keys.map(([k]) => k).join(", ")} is in ${file}. Copy it into deploy/.env on the new server.`);
  } else {
    console.log("This backup does not carry the old server's TOKEN_KEY. Use the copy from your password manager.");
  }
  console.log("Delete both files when the restore is done.");
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e: unknown) => {
  console.error(e instanceof BackupError ? e.message : e);
  process.exitCode = 1;
});
