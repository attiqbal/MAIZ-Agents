import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { EMPTY_SHA256, signV4 } from "./sigv4.js";
import { BackupError } from "./types.js";

/**
 * The four calls backups need from an S3-compatible storage service: put a file, fetch a file, list a folder and
 * delete a file. Path-style addresses (https://host/bucket/name), which Cloudflare R2, Backblaze B2, Hetzner Object
 * Storage and AWS S3 all accept. No redirect is ever followed: the key only goes to the address the owner typed.
 */
export interface S3Target { host: string; bucket: string; keyId: string; secret: string; region: string }
export interface S3Object { key: string; size: number; lastModified: string }

const SHORT_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 20 * 60_000;
const MAX_LIST_PAGES = 20;
/** One PUT takes up to 5 GB everywhere; stay under it. Bigger databases need uploading in parts, which is not built. */
export const MAX_UPLOAD_BYTES = 4_500_000_000;

const unxml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string): string | undefined => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? unxml(m[1]!) : undefined; };

/** What a refusal means, in words the owner can act on. */
function problem(status: number, code: string | undefined, what: "bucket" | "file"): BackupError {
  const detail = `storage answered ${status}${code ? ` ${code}` : ""}`;
  if (status === 401 || status === 403) return new BackupError("Your storage refused the key. Check the key id and the secret, and that the key may read, write and delete in this bucket.", detail);
  if (status === 404 && what === "file" && code !== "NoSuchBucket") return new BackupError("That backup is no longer in your storage.", detail);
  if (status === 404) return new BackupError("Your storage says there is no bucket with that name. Check the bucket name.", detail);
  if ((status >= 300 && status < 400) || code === "AuthorizationHeaderMalformed" || code === "PermanentRedirect" || code === "IllegalLocationConstraintException") return new BackupError("Your storage says this bucket lives in a different region. Check the region.", detail);
  if (status === 429 || status >= 500) return new BackupError("Your storage is having trouble at the moment. Try again in a few minutes.", detail);
  return new BackupError("Your storage did not accept the request. Check the details on this page.", detail);
}

export class S3Client {
  constructor(private readonly t: S3Target, private readonly http: typeof fetch, private readonly now: () => Date) {}

  private async call(method: string, key: string, o: { query?: Record<string, string>; body?: Blob | Uint8Array; sha256?: string; bytes?: number; timeoutMs?: number } = {}): Promise<Response> {
    const signed = signV4({
      method, host: this.t.host, path: `/${this.t.bucket}${key ? `/${key}` : ""}`, query: o.query,
      headers: o.body ? { "content-type": "application/octet-stream" } : {},
      payloadHash: o.sha256 ?? EMPTY_SHA256, accessKeyId: this.t.keyId, secretAccessKey: this.t.secret, region: this.t.region, now: this.now(),
    });
    try {
      return await this.http(signed.url, { method, headers: signed.headers, ...(o.body ? { body: o.body as BodyInit } : {}), redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? SHORT_TIMEOUT_MS) });
    } catch (e) {
      throw new BackupError("Your storage could not be reached. Check the address, then try again.", e instanceof Error ? e.name : undefined);
    }
  }

  private async refuse(res: Response, what: "bucket" | "file"): Promise<never> {
    const text = await res.text().catch(() => "");
    throw problem(res.status, tag(text.slice(0, 2_000), "Code")?.slice(0, 60).replace(/[^\w.-]/g, ""), what);
  }

  /** Stores a file. `sha256` is the SHA-256 of exactly these bytes, so the storage service refuses a damaged upload. */
  async put(key: string, body: Blob | Uint8Array, sha256: string): Promise<void> {
    const bytes = body instanceof Blob ? body.size : body.length;
    if (bytes > MAX_UPLOAD_BYTES) throw new BackupError("The backup is too big to send in one piece (over 4.5 GB). Ask your developer to add uploading in parts.");
    const res = await this.call("PUT", key, { body, sha256, timeoutMs: TRANSFER_TIMEOUT_MS });
    if (!res.ok) await this.refuse(res, "bucket");
    await res.arrayBuffer().catch(() => undefined);
  }

  /** Fetches a file straight to disk (only this user can read it). Returns its size. */
  async download(key: string, destPath: string): Promise<number> {
    const res = await this.call("GET", key, { timeoutMs: TRANSFER_TIMEOUT_MS });
    if (!res.ok || !res.body) await this.refuse(res, "file");
    const out = createWriteStream(destPath, { flags: "wx", mode: 0o600 });
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), out);
    } catch (e) {
      throw new BackupError("The backup could not be fetched from your storage. Try again in a few minutes.", e instanceof Error ? e.name : undefined);
    }
    return out.bytesWritten;
  }

  /** Every file whose name starts with `prefix`. */
  async list(prefix: string): Promise<S3Object[]> {
    const found: S3Object[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.call("GET", "", { query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) } });
      if (!res.ok) await this.refuse(res, "bucket");
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(m[1]!, "Key");
        if (key) found.push({ key, size: Number(tag(m[1]!, "Size") ?? 0), lastModified: tag(m[1]!, "LastModified") ?? "" });
      }
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
      if (!token) break;
    }
    return found;
  }

  async remove(key: string): Promise<void> {
    const res = await this.call("DELETE", key);
    if (!res.ok && res.status !== 404) await this.refuse(res, "file");
    await res.arrayBuffer().catch(() => undefined);
  }
}
