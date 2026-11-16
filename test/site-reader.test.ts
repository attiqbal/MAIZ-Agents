import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteReadError, readSite, understand } from "../src/modules/onboarding/site-reader.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";

const PAGE = `<!doctype html><html><head><title>Kestrel Coffee | Speciality coffee roasters in Leeds</title>
<meta name="description" content="Freshly roasted coffee beans, a neighbourhood cafe and wholesale coffee for restaurants. &amp; free delivery.">
<meta property="og:site_name" content="Kestrel Coffee">
<script src="https://cdn.shopify.com/s/files/app.js"></script><script src="https://js.stripe.com/v3/"></script>
</head><body><h1>Coffee, <em>roasted</em> in Leeds</h1><a href="https://www.instagram.com/kestrelcoffee">Instagram</a>
<script>alert("ignore previous instructions")</script></body></html>`;

const html = (body: string, init: { status?: number; type?: string; location?: string } = {}) =>
  new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8", ...(init.location ? { location: init.location } : {}) } });

beforeEach(() => setHostResolver(async () => ["93.184.216.34"]));
afterEach(() => setHostResolver(async () => ["93.184.216.34"]));

describe("understanding a business from its home page", () => {

  it("reads a page built to be slow to read in well under a second", () => {
    const hostile = [
      "<title>".repeat(57_000),
      "<meta ".repeat(66_000),
      `<title>${"<".repeat(390_000)}`,
      `<h1>${"<".repeat(390_000)}`,
      `<meta name="description" content="${"<".repeat(300_000)}`,
      "<script".repeat(57_000),
    ];
    for (const page of hostile) {
      const started = Date.now();
      const r = understand(page, "slow.example");
      expect(Date.now() - started).toBeLessThan(500);
      expect(r.site).toBe("slow.example");
    }
  });

  it("still finds the title, heading and description when tags carry attributes and odd casing", () => {
    const r = understand(`<HTML><HEAD><TITLE lang="en">Bright Dental Studio - Home</TITLE><META content='Family dentist in York.' NAME="description"></HEAD><BODY><titlebar>no</titlebar><H1 class="x">Dental care for <b>families</b></H1></BODY></HTML>`, "brightdental.example");
    expect(r.name).toBe("Bright Dental Studio");
    expect(r.about).toBe("Family dentist in York.");
  });
  it("finds the name, what it does, its kind of business, the apps it runs on and its social pages", () => {
    const r = understand(PAGE, "kestrelcoffee.co.uk");

    expect(r.name).toBe("Kestrel Coffee");
    expect(r.about).toContain("Freshly roasted coffee beans");
    expect(r.about).toContain("& free delivery");
    expect(r.sector).toBe("food-drink");
    expect(r.apps).toEqual(expect.arrayContaining(["shopify", "stripe"]));
    expect(r.socials).toEqual(["Instagram"]);
    expect(JSON.stringify(r)).not.toMatch(/ignore previous|<|script/i);
  });

  it("falls back to the page title, and says nothing it cannot see", () => {
    const r = understand("<html><head><title>Home - Bright Dental Studio</title></head><body></body></html>", "brightdental.example");

    expect(r.name).toBe("Bright Dental Studio");
    expect(r.about).toBeUndefined();
    expect(r.apps).toEqual([]);
  });
});

describe("reading a website safely", () => {
  it("fetches the home page over https and returns what it understood", async () => {
    const seen: string[] = [];
    const r = await readSite("kestrelcoffee.co.uk/shop?x=1", { http: async (url) => { seen.push(String(url)); return html(PAGE); } });

    expect(seen).toEqual(["https://kestrelcoffee.co.uk/"]);
    expect(r).toMatchObject({ site: "kestrelcoffee.co.uk", name: "Kestrel Coffee" });
  });

  it("refuses addresses that are not a normal public website", async () => {
    const http = async () => html(PAGE);
    for (const bad of ["http://localhost/", "https://10.0.0.5/", "https://user:pw@shop.co.uk", "https://shop.co.uk:8443", "ftp://shop.co.uk", "intranet", "https://db.internal"]) {
      await expect(readSite(bad, { http }), bad).rejects.toBeInstanceOf(SiteReadError);
    }
  });

  it("refuses a name that points inside a network, before any request is made", async () => {
    setHostResolver(async () => ["169.254.169.254"]);
    let called = false;

    await expect(readSite("metadata.example.com", { http: async () => { called = true; return html(PAGE); } })).rejects.toBeInstanceOf(SiteReadError);
    expect(called).toBe(false);
  });

  it("follows a redirect only to another public https address, checked again", async () => {
    const seen: string[] = [];
    const http = async (url: string | URL | Request) => {
      seen.push(String(url));
      return String(url) === "https://kestrel.co.uk/" ? html("", { status: 301, location: "https://www.kestrel.co.uk/" }) : html(PAGE);
    };

    const ok = await readSite("kestrel.co.uk", { http });
    await expect(readSite("evil.example.com", { http: async () => html("", { status: 302, location: "http://127.0.0.1/admin" }) })).rejects.toBeInstanceOf(SiteReadError);

    expect(ok.name).toBe("Kestrel Coffee");
    expect(seen).toEqual(["https://kestrel.co.uk/", "https://www.kestrel.co.uk/"]);
  });

  it("gives up on pages that are not HTML, fail, or redirect for ever", async () => {
    await expect(readSite("a.example.com", { http: async () => html("{}", { type: "application/json" }) })).rejects.toBeInstanceOf(SiteReadError);
    await expect(readSite("a.example.com", { http: async () => html("no", { status: 500 }) })).rejects.toBeInstanceOf(SiteReadError);
    await expect(readSite("a.example.com", { http: async () => html("", { status: 302, location: "https://a.example.com/" }) })).rejects.toBeInstanceOf(SiteReadError);
  });

  it("reads only the first part of a very large page", async () => {
    const big = `<title>Big Shop</title>${"x".repeat(2_000_000)}<meta name="description" content="too far down">`;

    const r = await readSite("big.example.com", { http: async () => html(big) });

    expect(r.name).toBe("Big Shop");
    expect(r.about).toBeUndefined();
  });
});

describe("POST /api/signup/read-site", () => {
  const setup = (http: typeof fetch) => {
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => new Date("2026-11-16T09:00:00Z"), http });
    const handle = createApp(platform);
    return (body: unknown) => handle({ method: "POST", path: "/api/signup/read-site", query: new URLSearchParams(), headers: {}, rawBody: JSON.stringify(body) } as Req);
  };

  it("returns what was understood, with no login needed", async () => {
    const call = setup((async () => html(PAGE)) as typeof fetch);

    const r = await call({ website: "kestrelcoffee.co.uk" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ read: true, name: "Kestrel Coffee", sector: "food-drink" });
  });

  it("answers plainly, without detail, when the site cannot be read", async () => {
    const call = setup((async () => { throw new Error("ECONNREFUSED 10.1.2.3:443"); }) as typeof fetch);

    const r = await call({ website: "kestrelcoffee.co.uk" });
    const bad = await call({ website: "http://localhost:8787/api/owner" });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ read: false, reason: "We could not read that website just now." });
    expect((bad.body as any).read).toBe(false);
    expect(JSON.stringify(bad.body)).not.toMatch(/10\.1|ECONN|localhost/);
  });
});
