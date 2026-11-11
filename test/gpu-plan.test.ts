import { describe, expect, it } from "vitest";
import { measuredTaskSeconds, planGpus, sizeForModel } from "../src/modules/batch/gpu-plan.js";

const base = { taskSeconds: 30, concurrencyPerGpu: 6, windowHours: 10, model: "Qwen/Qwen3-14B", current: { gpus: 1, sizeGb: 48 as const } };

describe("overnight GPU plan", () => {
  it("picks the smallest card that holds the model", () => {
    expect(sizeForModel("Qwen/Qwen3-8B")).toBe(24);
    expect(sizeForModel("Qwen/Qwen3-14B")).toBe(48);
    expect(sizeForModel("Qwen/Qwen3-32B-AWQ")).toBe(80);
    expect(sizeForModel("some-model")).toBe(48);
  });

  it("needs one GPU for a normal night and says so", () => {
    const p = planGpus({ ...base, pending: 400 }); // 400 x 30 s / 6 slots = 0.56 h
    expect(p).toMatchObject({ gpus: 1, sizeGb: 48 });
    expect(p.runHours).toBeCloseTo(0.56, 1);
    expect(p.advice).toMatch(/right for tonight/);
  });

  it("adds GPUs when the queue will not fit in the window, and warns about the current setting", () => {
    const p = planGpus({ ...base, pending: 12_000 }); // 12,000 x 30 / 6 = 16.7 h on one GPU
    expect(p.gpus).toBe(2);
    expect(p.current.finishesInWindow).toBe(false);
    expect(p.runHours).toBeLessThanOrEqual(10);
    expect(p.advice).toMatch(/past your 10-hour window.*Use 2 x 48 GB/);
  });

  it("costs the work, not the number of GPUs, and never plans more than 16", () => {
    const one = planGpus({ ...base, pending: 6_000 });
    const many = planGpus({ ...base, pending: 6_000, windowHours: 1 });
    expect(many.gpus).toBeGreaterThan(one.gpus);
    expect(many.costUsd).toBeCloseTo(one.costUsd, 6);
    expect(planGpus({ ...base, pending: 10_000_000 }).gpus).toBe(16);
  });

  it("handles an empty queue and a model that needs a bigger card", () => {
    expect(planGpus({ ...base, pending: 0 }).advice).toMatch(/Nothing is waiting/);
    const p = planGpus({ ...base, pending: 100, model: "Qwen/Qwen3-32B" });
    expect(p.advice).toMatch(/needs 80 GB/);
  });

  it("measures task time from finished runs", () => {
    const run = { startedAt: "2026-11-11T01:00:00Z", finishedAt: "2026-11-11T01:10:00Z", done: 120, failed: 0 }; // 600 s x 6 slots / 120 = 30 s
    expect(measuredTaskSeconds([run], 6)).toBe(30);
    expect(measuredTaskSeconds([], 6)).toBe(30);
  });
});
