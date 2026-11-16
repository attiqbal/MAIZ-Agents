import { describe, expect, it } from "vitest";
import { JobStore } from "../src/modules/agents/jobs.js";
import { MAX_JOBS_KEPT, type AgentJob } from "../src/modules/agents/types.js";

const START = Date.parse("2026-11-16T08:00:00Z");
const job = (n: number, at: number): AgentJob => ({
  id: `job_${n}`, workspaceId: "ws_1", connectionId: "conn_1", employee: "marketing-manager", brief: "Write a post", urgent: false,
  status: "done", estimate: 10, energyUsed: 10, energyDay: new Date(at).toISOString().slice(0, 10), createdAt: new Date(at).toISOString(),
});

describe("the jobs an outside tool has sent", () => {
  it("never forgets today's finished jobs, so a busy tool cannot push them out and win back its daily limit", () => {
    const store = new JobStore(() => undefined);
    const many = MAX_JOBS_KEPT + 60;

    // One job a minute, all on the same day: more than the store normally keeps.
    for (let n = 0; n < many; n++) store.save(job(n, START + n * 60_000));

    expect(store.of("conn_1")).toHaveLength(many);
    expect(store.usedOn("conn_1", "2026-11-16")).toBe(many * 10);
  });

  it("forgets the oldest finished jobs once they are more than a day old", () => {
    const store = new JobStore(() => undefined);
    for (let n = 0; n < MAX_JOBS_KEPT; n++) store.save(job(n, START + n * 60_000));

    // Three days later the tool is busy again.
    const later = START + 3 * 24 * 3_600_000;
    for (let n = 0; n < 5; n++) store.save(job(1_000 + n, later + n * 60_000));

    expect(store.of("conn_1")).toHaveLength(MAX_JOBS_KEPT);
    expect(store.get("job_0")).toBeUndefined();
    expect(store.get("job_1004")).toBeDefined();
  });
});
