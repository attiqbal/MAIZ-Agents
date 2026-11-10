import { describe, expect, it } from "vitest";
import { CATALOGUE, MAX_QTY, getItem, quote } from "../src/modules/store/cart.js";

describe("store cart", () => {
  it("sells add-ons and specialists monthly and tasks once, never the basic package", () => {
    expect(getItem("supply-chain-manager")?.billing).toBe("monthly");
    expect(getItem("payroll-specialist")?.billing).toBe("monthly");
    expect(getItem("website-developer")).toMatchObject({ billing: "once", priceGbp: 249 });
    expect(getItem("finance-manager")).toBeUndefined();
    expect(getItem("admin-manager")).toBeUndefined();
    expect(new Set(CATALOGUE.map((i) => i.key)).size).toBe(CATALOGUE.length);
  });

  it("splits monthly and one-off totals and merges repeated lines", () => {
    const q = quote([{ key: "supply-chain-manager", qty: 1 }, { key: "website-fixer", qty: 2 }, { key: "website-fixer", qty: 1 }]);
    expect(q.monthlyGbp).toBe(12);
    expect(q.onceGbp).toBe(147);
    expect(q.dueTodayGbp).toBe(159);
    expect(q.lines.find((l) => l.key === "website-fixer")?.qty).toBe(3);
  });

  it("rejects unknown items and bad quantities, and caps quantity", () => {
    const q = quote([{ key: "nope" }, { key: "seo-auditor", qty: 0 }, { key: "seo-auditor", qty: 1.5 }, { key: "blog-writer", qty: 99 }, null]);
    expect(q.rejected.map((r) => r.key)).toEqual(["nope", "seo-auditor", "seo-auditor", ""]);
    expect(q.lines).toEqual([expect.objectContaining({ key: "blog-writer", qty: MAX_QTY })]);
  });
});
