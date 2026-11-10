import { describe, expect, it } from "vitest";
import { CATALOGUE, MAX_QTY, getItem, quote } from "../src/modules/store/cart.js";

describe("store cart", () => {
  it("sells add-ons and specialists monthly and tasks once, never the basic package", () => {
    expect(getItem("supply-chain-manager")?.billing).toBe("monthly");
    expect(getItem("payroll-specialist")?.billing).toBe("monthly");
    expect(getItem("web-developer:month")).toMatchObject({ billing: "once", priceGbp: 349, days: 30, energy: 12000 });
    expect(getItem("web-developer:sprint")).toMatchObject({ billing: "once", priceGbp: 99, days: 7 });
    expect(getItem("finance-manager")).toBeUndefined();
    expect(getItem("admin-manager")).toBeUndefined();
    expect(new Set(CATALOGUE.map((i) => i.key)).size).toBe(CATALOGUE.length);
  });

  it("splits monthly and one-off totals and merges repeated lines", () => {
    const q = quote([{ key: "supply-chain-manager", qty: 1 }, { key: "web-developer:sprint", qty: 2 }, { key: "web-developer:sprint", qty: 1 }]);
    expect(q.monthlyGbp).toBe(12);
    expect(q.onceGbp).toBe(297);
    expect(q.dueTodayGbp).toBe(309);
    expect(q.lines.find((l) => l.key === "web-developer:sprint")?.qty).toBe(3);
  });

  it("rejects unknown items and bad quantities, and caps quantity", () => {
    const q = quote([{ key: "nope" }, { key: "growth-consultant:month", qty: 0 }, { key: "growth-consultant:month", qty: 1.5 }, { key: "content-creator:month", qty: 99 }, null]);
    expect(q.rejected.map((r) => r.key)).toEqual(["nope", "growth-consultant:month", "growth-consultant:month", ""]);
    expect(q.lines).toEqual([expect.objectContaining({ key: "content-creator:month", qty: MAX_QTY })]);
  });
});

describe("billing labels", () => {
  it("say plainly which items recur and which are one-off, and which roles are core", async () => {
    const { BILLING_INFO, KIND_LABEL, isCoreRole } = await import("../src/modules/store/cart.js");
    expect(BILLING_INFO.monthly.label).toContain("Recurring");
    expect(BILLING_INFO.once.label).toContain("One-off");
    expect(KIND_LABEL.consultant).toBe("Consultant pass");
    expect(isCoreRole("finance-manager") && isCoreRole("admin-manager")).toBe(true);
    expect(isCoreRole("supply-chain-manager") || isCoreRole("web-developer:month")).toBe(false);
    for (const i of CATALOGUE) expect(isCoreRole(i.key), i.key).toBe(false);
  });
});
