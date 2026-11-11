import { describe, expect, it } from "vitest";
import { SLOW_AFTER_S, VERY_SLOW_AFTER_S, workingMessage } from "../web/src/ask-status.js";

describe("ask bar working message", () => {
  it("stays short while the answer is normally still on its way", () => {
    expect(workingMessage("Finn", 0)).toBe("Finn is on it…");
    expect(workingMessage("Finn", SLOW_AFTER_S - 1)).toBe("Finn is on it…");
  });
  it("shows the seconds once a live answer is slower than usual", () => {
    expect(workingMessage("Finn", SLOW_AFTER_S)).toContain("8s");
  });
  it("explains the AI waking up, and that the answer is still coming, after the slow limit", () => {
    const msg = workingMessage("Finn", VERY_SLOW_AFTER_S);
    expect(msg).toContain("waking up");
    expect(msg).toContain("answer will appear");
  });
});
