import { createCipheriv, createECDH, createPrivateKey, createSign, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

/**
 * Web Push without a dependency: VAPID (RFC 8292) to prove who is sending, and message encryption for the browser
 * that subscribed (RFC 8291, the "aes128gcm" content coding of RFC 8188). Pure functions over Node's crypto, so the
 * tests can decrypt what is produced here and check the signature.
 */
export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url. The browser needs this to subscribe. */
  publicKey: string;
  /** The private scalar (32 bytes), base64url. Stored encrypted, never sent anywhere. */
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  /** The browser's public key (65 bytes) and its 16-byte secret, both base64url, as PushSubscription.toJSON() gives them. */
  keys: { p256dh: string; auth: string };
}

const CURVE = "prime256v1";
const PUBLIC_KEY_BYTES = 65;
const AUTH_BYTES = 16;
const SALT_BYTES = 16;
/** One record holds the whole message. Push services accept up to 4096 bytes. */
const RECORD_SIZE = 4096;
/** The largest payload that still fits one record: record size, less the 16-byte tag and the one-byte delimiter. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 16 - 1 - 86;
const VAPID_LIFETIME_SECONDS = 12 * 3600;

const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x!), fromB64u(pub.y!)])), privateKey: priv.d! };
}

/** True when both halves look like a P-256 key pair in the form above. */
export function isVapidKeys(v: unknown): v is VapidKeys {
  const k = v as Partial<VapidKeys> | null;
  return typeof k?.publicKey === "string" && typeof k.privateKey === "string" && fromB64u(k.publicKey).length === PUBLIC_KEY_BYTES && fromB64u(k.privateKey).length === 32;
}

/** The Authorization header a push service checks: a short-lived ES256 token for that service's origin only. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string {
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey } });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_SECONDS, sub: subject })));
  const signature = createSign("SHA256").update(`${head}.${claims}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Encrypts `payload` so that only the subscribed browser can read it. Returns the request body for the push service. */
export function encryptPayload(target: PushTarget, payload: Buffer): Buffer {
  const uaPublic = fromB64u(target.keys.p256dh);
  const auth = fromB64u(target.keys.auth);
  if (uaPublic.length !== PUBLIC_KEY_BYTES || uaPublic[0] !== 4) throw new Error("the browser key is not a P-256 public key");
  if (auth.length !== AUTH_BYTES) throw new Error("the browser secret is not 16 bytes");
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("the message is too long for one push");
  const sender = createECDH(CURVE);
  const asPublic = sender.generateKeys();
  const shared = sender.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const salt = randomBytes(SALT_BYTES);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (here the only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(asPublic.length, SALT_BYTES + 4);
  return Buffer.concat([header, asPublic, sealed]);
}
