import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupError } from "../src/modules/backup/types.js";
import { keyIdOf, makeRecoveryKey, openSealed, parseRecoveryKey, readHeader, recoveryKeyText, sealTo } from "../src/modules/backup/seal.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maiz-seal-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const META = { madeAt: "2026-11-16T03:10:00.000Z", kind: "nightly" as const };
const seal = (plain: Buffer, key: Buffer, extra: { serverKeys?: Record<string, string> } = {}) => sealTo(Readable.from([plain]), join(dir, "b.backup"), key, { ...META, ...extra });

describe("the recovery key", () => {
  it("is 32 random bytes, written as eleven groups of five that are easy to read out and type", () => {
    const k = makeRecoveryKey();
    expect(k.bytes).toHaveLength(32);
    expect(k.text).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(makeRecoveryKey().text).not.toBe(k.text);
    expect(parseRecoveryKey(k.text).equals(k.bytes)).toBe(true);
    expect(k.id).toBe(keyIdOf(k.bytes));
    expect(k.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is read back however it was typed: lower case, spaces, and O, I and L typed for 0 and 1", () => {
    const bytes = Buffer.alloc(32, 0);
    const text = recoveryKeyText(bytes);
    expect(text.startsWith("00000-")).toBe(true);
    const typed = ` ${text.toLowerCase().replace(/-/g, " ").replace(/0/, "o")} `;
    expect(parseRecoveryKey(typed).equals(bytes)).toBe(true);
  });

  it("says so when a character was mistyped or part is missing", () => {
    const k = makeRecoveryKey();
    const wrong = k.text.replace(/.$/, (c) => (c === "7" ? "8" : "7"));
    expect(() => parseRecoveryKey(wrong)).toThrow(BackupError);
    expect(() => parseRecoveryKey(k.text.slice(0, 40))).toThrow(/55 letters and numbers/);
    expect(() => parseRecoveryKey("")).toThrow(BackupError);
    expect(() => parseRecoveryKey(null)).toThrow(BackupError);
  });
});

describe("sealing and opening a backup file", () => {
  it("opens with the key it was sealed with and gives back exactly what went in", async () => {
    const key = makeRecoveryKey();
    const plain = randomBytes(300_000);
    const sealed = await seal(plain, key.bytes);
    const file = readFileSync(join(dir, "b.backup"));
    expect(sealed.bytes).toBe(file.length);
    expect(file.includes(plain.subarray(0, 64))).toBe(false);
    expect(file.subarray(0, 8).toString()).toBe("MAIZBKP1");
    const header = await openSealed(join(dir, "b.backup"), join(dir, "out"), [key.bytes]);
    expect(readFileSync(join(dir, "out")).equals(plain)).toBe(true);
    expect(header).toMatchObject({ v: 1, madeAt: META.madeAt, kind: "nightly", keyId: key.id });
    expect(statSync(join(dir, "out")).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "b.backup")).mode & 0o077).toBe(0);
  });

  it("reports the SHA-256 of the sealed file, which is what the storage service is told", async () => {
    const { createHash } = await import("node:crypto");
    const sealed = await seal(Buffer.from("hello"), makeRecoveryKey().bytes);
    expect(sealed.sha256).toBe(createHash("sha256").update(readFileSync(join(dir, "b.backup"))).digest("hex"));
  });

  it("uses a new salt every time, so the same data never seals to the same bytes", async () => {
    const key = makeRecoveryKey();
    await seal(Buffer.from("same"), key.bytes);
    const first = readFileSync(join(dir, "b.backup"));
    rmSync(join(dir, "b.backup"));
    await seal(Buffer.from("same"), key.bytes);
    expect(readFileSync(join(dir, "b.backup")).equals(first)).toBe(false);
  });

  it("refuses a different key in plain words and leaves nothing behind", async () => {
    await seal(Buffer.from("secret rows"), makeRecoveryKey().bytes);
    await expect(openSealed(join(dir, "b.backup"), join(dir, "out"), [makeRecoveryKey().bytes])).rejects.toThrow(/different recovery key/);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("picks the right key when the server still holds older ones", async () => {
    const old = makeRecoveryKey();
    const current = makeRecoveryKey();
    await seal(Buffer.from("made before the key changed"), old.bytes);
    await openSealed(join(dir, "b.backup"), join(dir, "out"), [current.bytes, old.bytes]);
    expect(readFileSync(join(dir, "out"), "utf8")).toBe("made before the key changed");
  });

  it("notices a single changed byte anywhere in the file and removes the half-opened copy", async () => {
    const key = makeRecoveryKey();
    await seal(randomBytes(5_000), key.bytes);
    const original = readFileSync(join(dir, "b.backup"));
    const { dataOffset } = await readHeader(join(dir, "b.backup"));
    for (const at of [dataOffset + 10, original.length - 1, 20]) {
      const copy = Buffer.from(original);
      copy[at] = copy[at]! ^ 1;
      writeFileSync(join(dir, "changed.backup"), copy);
      await expect(openSealed(join(dir, "changed.backup"), join(dir, "out"), [key.bytes])).rejects.toThrow(BackupError);
      expect(existsSync(join(dir, "out"))).toBe(false);
    }
  });

  it("refuses a file that is not a MAIZ backup, or is cut short", async () => {
    writeFileSync(join(dir, "other"), "PGDMP this is something else entirely");
    await expect(openSealed(join(dir, "other"), join(dir, "out"), [makeRecoveryKey().bytes])).rejects.toThrow(/not a MAIZ Agents backup/);
    const key = makeRecoveryKey();
    await seal(randomBytes(2_000), key.bytes);
    writeFileSync(join(dir, "short"), readFileSync(join(dir, "b.backup")).subarray(0, 30));
    await expect(openSealed(join(dir, "short"), join(dir, "out"), [key.bytes])).rejects.toThrow(BackupError);
  });

  it("carries the server's own keys inside, readable only with the recovery key", async () => {
    const key = makeRecoveryKey();
    await seal(Buffer.from("rows"), key.bytes, { serverKeys: { TOKEN_KEY: "ab".repeat(32) } });
    expect(readFileSync(join(dir, "b.backup")).includes("ab".repeat(32))).toBe(false);
    const header = await openSealed(join(dir, "b.backup"), join(dir, "out"), [key.bytes]);
    expect(header.serverKeys).toEqual({ TOKEN_KEY: "ab".repeat(32) });
    const plainHeader = await readHeader(join(dir, "b.backup"));
    expect(JSON.stringify(plainHeader.header)).not.toContain("TOKEN_KEY");
  });

  it("seals an empty input too (the caller decides whether an empty dump is a failure)", async () => {
    const key = makeRecoveryKey();
    await seal(Buffer.alloc(0), key.bytes);
    await openSealed(join(dir, "b.backup"), join(dir, "out"), [key.bytes]);
    expect(readFileSync(join(dir, "out"))).toHaveLength(0);
  });
});
