import { describe, expect, it } from "vitest";
import { SHOP_EMPLOYEE_KEYS, SHOP_RULES, checkShopCopy, shopCopyNote } from "../src/modules/ecommerce/rules.js";

describe("shop copy check", () => {
  it("flags false urgency, invented social proof, health claims and refusals of the 14 day right", () => {
    const text = [
      "Only 3 left in stock! Selling fast.",
      "Offer ends in 02:14:55 so hurry.",
      "12 people are viewing this right now.",
      '"Best mug I ever owned" - Sarah K, verified buyer',
      "Clinically proven to cure back pain.",
      "All sales final. No returns.",
    ].join("\n");
    const kinds = new Set(checkShopCopy(text).map((f) => f.kind));
    expect(kinds).toEqual(new Set(["urgency", "social-proof", "claim", "returns"]));
  });

  it("leaves honest copy alone", () => {
    const text = "A 350ml stoneware mug, hand finished. Delivery takes 5 to 8 working days from our supplier. Return it within 14 days of receiving it.";
    expect(checkShopCopy(text)).toEqual([]);
    expect(shopCopyNote(text)).toBeUndefined();
  });

  it("writes a plain note naming each problem once, and says how to carry on", () => {
    const note = shopCopyNote("Only 2 left! Only 5 left! Selling fast.")!;
    expect(note).toMatch(/^Check before you use this/);
    expect(note.match(/false urgency/gi)).toHaveLength(1);
    expect(note).toMatch(/Compliance manager/);
  });

  it("is not fooled by capital letters or extra spaces", () => {
    expect(checkShopCopy("ONLY   4   LEFT").length).toBeGreaterThan(0);
  });
});

describe("the shared shop rules", () => {
  it("cover approval, fake reviews, fake urgency, invented facts, delivery times, claims, UK seller rules and local rules", () => {
    const all = SHOP_RULES.join(" ").toLowerCase();
    for (const word of ["approval", "fake review", "countdown", "only 3 left", "invent", "delivery time", "supplier", "14 days", "vat", "product safety", "restricted", "compliance manager", "legal advice"]) {
      expect(all, word).toContain(word);
    }
  });
  it("names the four shop employees", () => {
    expect([...SHOP_EMPLOYEE_KEYS].sort()).toEqual(["dropshipping-agent", "marketplace-manager", "online-shop-manager", "shop-care-agent"]);
  });
});
