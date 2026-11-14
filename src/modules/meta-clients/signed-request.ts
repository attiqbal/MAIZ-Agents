import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta's deauthorize and data-deletion callbacks send `signed_request = <signature>.<payload>`, both base64url:
 * the signature is HMAC-SHA256 of the payload string with the app secret. Anything not signed by us is refused.
 */
export function parseSignedRequest(signed: unknown, appSecret: string): { user_id: string; [k: string]: unknown } | undefined {
  if (typeof signed !== "string" || signed.length > 4000) return undefined;
  const [sig, payload, ...rest] = signed.split(".");
  if (!sig || !payload || rest.length) return undefined;
  const want = createHmac("sha256", appSecret).update(payload).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return undefined; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data?.algorithm && String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return undefined;
    return typeof data?.user_id === "string" && /^\d{1,30}$/.test(data.user_id) ? data : undefined;
  } catch { return undefined; }
}

/** Builds one (used by tests and by the sandbox's "simulate Meta calling us" button). */
export function makeSignedRequest(payload: Record<string, unknown>, appSecret: string): string {
  const p = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: 0, ...payload })).toString("base64url");
  return `${createHmac("sha256", appSecret).update(p).digest("base64url")}.${p}`;
}
