import { describe, expect, it } from "vitest";
import { EmailProviderError, QueuedEmailSender, type EmailSender } from "../src/server/email.js";
import { ExpiringSet, SendLog } from "../src/server/expiring.js";

const noWait = () => Promise.resolve();

describe("queued email", () => {
  it("returns at once, retries when the provider says slow down, and delivers every message", async () => {
    let calls = 0;
    const got: string[] = [];
    const flaky: EmailSender = { send: async (m) => { calls++; if (calls % 3 === 1) throw new EmailProviderError(429); got.push(m.to); } };
    const q = new QueuedEmailSender(flaky, { sleep: noWait });
    for (let i = 0; i < 10; i++) await q.send({ to: `p${i}@x.co`, subject: "s", text: "t" });
    await q.idle();
    expect(got).toHaveLength(10);
    expect(q.stats).toMatchObject({ sent: 10, failed: 0 });
    expect(q.stats.retried).toBeGreaterThan(0);
  });

  it("gives up on a refused message (bad address) without blocking the rest", async () => {
    const got: string[] = [];
    const picky: EmailSender = { send: async (m) => { if (m.to.startsWith("bad")) throw new EmailProviderError(422); got.push(m.to); } };
    const q = new QueuedEmailSender(picky, { sleep: noWait });
    await q.send({ to: "bad@x.co", subject: "s", text: "t" });
    await q.send({ to: "good@x.co", subject: "s", text: "t" });
    await q.idle();
    expect(got).toEqual(["good@x.co"]);
    expect(q.stats).toMatchObject({ sent: 1, failed: 1, retried: 0 });
  });
});

describe("one-time link memory", () => {
  it("forgets used links once they have expired", () => {
    const clock = { t: 0 };
    const used = new ExpiringSet(() => clock.t, 2);
    used.add("a", 1_000);
    used.add("b", 5_000);
    expect(used.has("a")).toBe(true);
    clock.t = 2_000;
    expect(used.has("a")).toBe(false);
    used.add("c", 9_000); // triggers a sweep
    expect(used.size).toBe(2);
  });
  it("drops send counts for addresses outside the hour", () => {
    const log = new SendLog(1_000, 2);
    log.record("a", 0);
    log.record("b", 0);
    log.record("c", 5_000);
    log.record("d", 5_000);
    expect(log.size).toBe(2);
    expect(log.recent("c", 5_500)).toHaveLength(1);
  });
});
