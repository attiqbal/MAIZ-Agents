import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnv } from "../src/server/config.js";
import { clientIp, limitFor, RateLimiter } from "../src/server/rate-limit.js";
import { createStatic, headersFor, parseHeaders } from "../src/server/static.js";

const goodProd = {
  NODE_ENV: "production",
  SESSION_SECRET: "x".repeat(40),
  DATABASE_URL: "postgres://a",
  DATABASE_APP_URL: "postgres://b",
  TOKEN_KEY: "a".repeat(64),
  RESEND_API_KEY: "re_x",
  EMAIL_FROM: "MAIZ <hi@example.com>",
  APP_URL: "https://app.example.com",
  ANTHROPIC_API_KEY: "sk-x",
};

describe("start-up checks", () => {
  it("accepts a complete production setup", () => expect(checkEnv(goodProd)).toEqual([]));
  it("accepts an empty development setup", () => expect(checkEnv({})).toEqual([]));
  it("refuses production without the AI key, database or https address", () => {
    const p = checkEnv({ ...goodProd, ANTHROPIC_API_KEY: "", DATABASE_URL: "", APP_URL: "http://x" });
    expect(p.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
    expect(p.join("\n")).toMatch(/DATABASE_URL/);
    expect(p.join("\n")).toMatch(/https/);
  });
  it("refuses dev sign-in, a short secret or a bad token key", () => {
    const p = checkEnv({ ...goodProd, ALLOW_DEV_AUTH: "1", SESSION_SECRET: "short", TOKEN_KEY: "zz" }).join("\n");
    expect(p).toMatch(/ALLOW_DEV_AUTH/);
    expect(p).toMatch(/SESSION_SECRET/);
    expect(p).toMatch(/TOKEN_KEY/);
  });
  it("refuses half a Slack setup", () => expect(checkEnv({ SLACK_CLIENT_ID: "1" })[0]).toMatch(/Slack/));
});

describe("rate limits", () => {
  it("blocks after the limit and resets after the window", () => {
    let t = 0;
    const r = new RateLimiter(() => t);
    const lim = { max: 2, windowMs: 1000 };
    expect([r.allow("a", lim), r.allow("a", lim), r.allow("a", lim)]).toEqual([true, true, false]);
    expect(r.allow("b", lim)).toBe(true);
    t = 1000;
    expect(r.allow("a", lim)).toBe(true);
  });
  it("is tight on sign-in, off for Slack events and GETs", () => {
    expect(limitFor("POST", "/api/signin/start")?.max).toBe(10);
    expect(limitFor("POST", "/api/slack/events")).toBeUndefined();
    expect(limitFor("GET", "/api/org")).toBeUndefined();
  });
  it("uses the proxy-added address, not one the client forged", () => {
    expect(clientIp({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, "10.0.0.1", true)).toBe("1.2.3.4");
    expect(clientIp({ "x-forwarded-for": "6.6.6.6" }, "10.0.0.1", false)).toBe("10.0.0.1");
  });
});

describe("website files", () => {
  const root = mkdtempSync(join(tmpdir(), "site-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "home");
  writeFileSync(join(root, "pricing.html"), "pricing");
  writeFileSync(join(root, "404.html"), "missing");
  writeFileSync(join(root, "assets", "a.js"), "js");
  writeFileSync(join(root, "_headers"), "# c\n/*\n  X-Frame-Options: DENY\n\n/assets/*\n  Cache-Control: immutable\n");
  writeFileSync(join(tmpdir(), "secret.txt"), "nope");
  const serve = createStatic(root)!;

  it("serves pages with and without .html, and the home page", () => {
    expect(serve("/").body.toString()).toBe("home");
    expect(serve("/pricing").body.toString()).toBe("pricing");
    expect(serve("/pricing.html").headers["Content-Type"]).toMatch(/text\/html/);
  });
  it("applies the _headers rules", () => {
    expect(serve("/").headers["X-Frame-Options"]).toBe("DENY");
    expect(serve("/assets/a.js").headers["Cache-Control"]).toBe("immutable");
    expect(headersFor(parseHeaders("/x\n  A: 1\n"), "/y")).toEqual({});
  });
  it("answers 404 for missing files, the _headers file and path traversal", () => {
    expect(serve("/nope").status).toBe(404);
    expect(serve("/_headers").status).toBe(404);
    expect(serve("/../secret.txt").status).toBe(404);
    expect(serve("/%2e%2e/secret.txt").status).toBe(404);
  });
});
