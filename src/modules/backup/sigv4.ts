import { createHash, createHmac } from "node:crypto";

/**
 * Amazon's Signature Version 4, the way every S3-compatible storage service (Cloudflare R2, Backblaze B2, Hetzner
 * Object Storage, AWS S3) expects a request to be signed. Only what backups need: one request, signed in its headers.
 * Checked against Amazon's own published example values in test/backup-sigv4.test.ts.
 */
export interface SignRequest {
  method: string;
  /** Host name only, for example abc.r2.cloudflarestorage.com. */
  host: string;
  /** The path as plain text (not escaped), starting with a slash. */
  path: string;
  query?: Readonly<Record<string, string>>;
  /** Extra headers to send. Every one of them is signed. */
  headers?: Readonly<Record<string, string>>;
  /** SHA-256 of the body as hex (EMPTY_SHA256 when there is no body). */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Default "s3". */
  service?: string;
  now: Date;
}

export interface SignedRequest {
  /** The exact address to call: the escaping here is the escaping that was signed. */
  url: string;
  /** The headers to send, names in lower case. Host is left to the HTTP client. */
  headers: Record<string, string>;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const EMPTY_SHA256 = sha256Hex("");
const ALGORITHM = "AWS4-HMAC-SHA256";
const hmac = (key: string | Uint8Array, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** Escapes everything except letters, digits, hyphen, underscore, full stop and tilde (RFC 3986), as Amazon requires. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The key a day's requests are signed with: the secret is never used directly. */
export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
}

const canonicalPath = (path: string): string => path.split("/").map(encodeRfc3986).join("/") || "/";
const canonicalQuery = (query: Readonly<Record<string, string>>): string =>
  Object.entries(query).map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");

export function signV4(r: SignRequest): SignedRequest {
  const service = r.service ?? "s3";
  const stamp = r.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const sent: Record<string, string> = { "x-amz-content-sha256": r.payloadHash, "x-amz-date": stamp };
  for (const [name, value] of Object.entries(r.headers ?? {})) sent[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const signed: Record<string, string> = { ...sent, host: r.host };
  const names = Object.keys(signed).sort();
  const path = canonicalPath(r.path);
  const query = canonicalQuery(r.query ?? {});
  const canonical = [r.method.toUpperCase(), path, query, ...names.map((n) => `${n}:${signed[n]}`), "", names.join(";"), r.payloadHash].join("\n");
  const scope = `${day}/${r.region}/${service}/aws4_request`;
  const toSign = [ALGORITHM, stamp, scope, sha256Hex(canonical)].join("\n");
  const signature = hmac(signingKey(r.secretAccessKey, day, r.region, service), toSign).toString("hex");
  return {
    url: `https://${r.host}${path}${query ? `?${query}` : ""}`,
    headers: { ...sent, authorization: `${ALGORITHM} Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
  };
}
