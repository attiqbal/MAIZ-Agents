import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMPTY_SHA256, encodeRfc3986, signV4, signingKey } from "../src/modules/backup/sigv4.js";

/**
 * The example values Amazon publishes for Signature Version 4, so the signer is checked against the real thing
 * without calling anyone:
 *  - S3 API reference, "Signature Calculations for the Authorization Header: Transferring Payload in a Single Chunk"
 *    (the four examplebucket requests of 24 May 2013);
 *  - IAM user guide, "Examples of how to derive a signing key for Signature Version 4".
 */
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AT = new Date("2013-05-24T00:00:00Z");
const base = { host: "examplebucket.s3.amazonaws.com", accessKeyId: KEY_ID, secretAccessKey: SECRET, region: "us-east-1", now: AT };
const signatureOf = (authorization: string): string => /Signature=([0-9a-f]{64})$/.exec(authorization)![1]!;

describe("Signature Version 4, against Amazon's published examples", () => {
  it("derives the signing key of the IAM guide example", () => {
    const key = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
    expect(key.toString("hex")).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });

  it("signs the GET Object example (a Range header is signed too)", () => {
    const r = signV4({ ...base, method: "GET", path: "/test.txt", headers: { Range: "bytes=0-9" }, payloadHash: EMPTY_SHA256 });
    expect(r.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    expect(r.headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${KEY_ID}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
    expect(r.headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(r.headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);
  });

  it("signs the PUT Object example (the name has a character that must be escaped)", () => {
    const body = "Welcome to Amazon S3.";
    const payloadHash = createHash("sha256").update(body).digest("hex");
    expect(payloadHash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const r = signV4({ ...base, method: "PUT", path: "/test$file.text", headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash });
    expect(r.url).toBe("https://examplebucket.s3.amazonaws.com/test%24file.text");
    expect(signatureOf(r.headers.authorization!)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    expect(r.headers.authorization).toContain("SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,");
  });

  it("signs the GET Bucket Lifecycle example (a query name with no value)", () => {
    const r = signV4({ ...base, method: "GET", path: "/", query: { lifecycle: "" }, payloadHash: EMPTY_SHA256 });
    expect(r.url).toBe("https://examplebucket.s3.amazonaws.com/?lifecycle=");
    expect(signatureOf(r.headers.authorization!)).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });

  it("signs the List Objects example (query names are put in order)", () => {
    const r = signV4({ ...base, method: "GET", path: "/", query: { prefix: "J", "max-keys": "2" }, payloadHash: EMPTY_SHA256 });
    expect(r.url).toBe("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J");
    expect(signatureOf(r.headers.authorization!)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

describe("Signature Version 4, details", () => {
  it("escapes everything except letters, digits and - _ . ~", () => {
    expect(encodeRfc3986("a b/c+d=e&f~g*h'i(j)k!")).toBe("a%20b%2Fc%2Bd%3De%26f~g%2Ah%27i%28j%29k%21");
    expect(encodeRfc3986("é")).toBe("%C3%A9");
  });

  it("keeps the slashes of a path and escapes each part once", () => {
    const r = signV4({ ...base, method: "GET", path: "/bucket/folder name/file+1.backup", payloadHash: EMPTY_SHA256 });
    expect(r.url).toBe("https://examplebucket.s3.amazonaws.com/bucket/folder%20name/file%2B1.backup");
  });

  it("never returns a Host header (the HTTP client sets it) and never changes the headers it was given", () => {
    const headers = { "Content-Type": "application/octet-stream" };
    const r = signV4({ ...base, method: "PUT", path: "/x", headers, payloadHash: EMPTY_SHA256 });
    expect(Object.keys(r.headers).sort()).toEqual(["authorization", "content-type", "x-amz-content-sha256", "x-amz-date"]);
    expect(headers).toEqual({ "Content-Type": "application/octet-stream" });
  });

  it("gives a different signature for a different secret, region or time", () => {
    const sig = (over: Record<string, unknown>) => signatureOf(signV4({ ...base, method: "GET", path: "/test.txt", payloadHash: EMPTY_SHA256, ...over }).headers.authorization!);
    const first = sig({});
    expect(sig({ secretAccessKey: `${SECRET}x` })).not.toBe(first);
    expect(sig({ region: "auto" })).not.toBe(first);
    expect(sig({ now: new Date("2013-05-24T00:00:01Z") })).not.toBe(first);
    expect(sig({})).toBe(first);
  });
});
