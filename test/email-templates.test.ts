import { describe, expect, it } from "vitest";
import { sampleEmails } from "../src/server/email-samples.js";
import { brandFrom, renderEmail } from "../src/server/email-templates.js";

const brand = { baseUrl: "https://maizagents.com" };

describe("email templates", () => {
  const all = Object.entries(sampleEmails(brand));

  it.each(all)("%s has html with logo, plain text and no external CSS", (_n, m) => {
    expect(m.html).toContain("https://maizagents.com/logo.png");
    expect(m.html).toContain("<table");
    expect(m.html).not.toMatch(/<link |<style|<script/);
    expect(m.text.length).toBeGreaterThan(40);
    expect(m.text).toContain("MAIZ Agents");
    expect(m.subject.length).toBeGreaterThan(5);
  });

  it("escapes anything dynamic", () => {
    const { html, text } = renderEmail({ audience: "owner", preheader: "p", heading: "<b>x</b>", paragraphs: ['<img src=x onerror="a()"> & more'], button: { label: "Go", url: 'https://a.test/?q="1"&r=2' } }, brand);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; more");
    expect(html).toContain('href="https://a.test/?q=&quot;1&quot;&amp;r=2"');
    expect(text).toContain('<img src=x onerror="a()"> & more');
  });

  it("names the legal entity and the registered office in every footer", () => {
    const content = { audience: "customer" as const, preheader: "p", heading: "h", paragraphs: ["x"] };
    const withOffice = renderEmail(content, brandFrom({ appUrl: "https://maizagents.com" }));
    expect(withOffice.html).toContain("MAIZ AI Ltd");
    expect(withOffice.html).toContain("company number 17579512");
    expect(withOffice.html).toContain("Registered office: 20 Wenlock Road, London, N1 7GU, England.");
    expect(withOffice.text).toContain("registered in England and Wales");
    expect(withOffice.text).toContain("Registered office: 20 Wenlock Road, London, N1 7GU, England.");
    expect(renderEmail(content, brand).html).not.toContain("Registered office");
  });

  it("shows the support address only when configured", () => {
    const content = { audience: "customer" as const, preheader: "p", heading: "h", paragraphs: ["x"] };
    expect(renderEmail(content, brand).html).not.toContain("mailto:");
    expect(renderEmail(content, { ...brand, supportEmail: "help@maizagents.com" }).html).toContain("mailto:help@maizagents.com");
  });

  it("keeps the real link time limits in the wording", () => {
    const s = sampleEmails(brand);
    expect(s["sign-in-link"]!.text).toContain("15 minutes");
    expect(s["confirm-email"]!.text).toContain("1 hour");
    expect(s["password-reset"]!.text).toContain("30 minutes");
  });
});
