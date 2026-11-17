import { describe, expect, it } from "vitest";
import { AuditLog, EventBus, IdentityService, Ledger } from "../src/index.js";
import { IntegrationService, defaultRegistry } from "../src/modules/integrations/index.js";
import { freeAgentMonth } from "../src/modules/integrations/connectors/freeagent.js";

// FreeAgent against a FAKE server that answers in the shape FreeAgent's developer pages give. Not tried on a real account.
const APP = { clientId: "fa-id", clientSecret: "fa-secret", redirectUri: "https://app.test/api/integrations/callback" };
interface Seen { url: string; method: string; headers: Record<string, string>; body: string }

async function setup(answer: (s: Seen) => Response, now = () => new Date()) {
  const seen: Seen[] = [];
  const http = (async (url: any, init: any = {}) => {
    const s: Seen = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: String(init.body ?? "") };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  const audit = new AuditLog();
  const identity = new IdentityService(audit, new EventBus());
  const ledger = new Ledger(identity, audit);
  const ws = await identity.createWorkspace("owner", { name: "Kestrel", baseCurrency: "GBP" });
  ledger.open("owner", ws.id);
  const ig = new IntegrationService(identity, audit, ledger, defaultRegistry(), { http, now, oauthApps: { freeagent: APP } });
  return { ig, ws: ws.id, seen };
}
const summary = () => Response.json({ profit_and_loss_summary: { from: "2026-10-01", to: "2026-10-31", income: "3800.50", expenses: "8200", operating_profit: "-4399.50" } });

describe("FreeAgent", () => {
  it("turns a summary into one month of accounts, with no cost of sales line", () => {
    expect(freeAgentMonth({ profit_and_loss_summary: { income: "3800", expenses: "8200", operating_profit: "-4400" } }, "2026-10", "GBP")).toEqual({ month: "2026-10", currency: "GBP", income: 380000, costOfSales: 0, expenses: 820000, netProfit: -440000 });
    expect(freeAgentMonth({}, "2026-10", "GBP").netProfit).toBe(0);
  });

  it("sends the owner to FreeAgent with no scope, then swaps the code using Basic auth and keeps the tokens", async () => {
    const { ig, ws, seen } = await setup((s) => (s.url.endsWith("/v2/token_endpoint") ? Response.json({ access_token: "fa-a", refresh_token: "fa-r", expires_in: 3600 }) : summary()));
    const url = new URL(ig.authorizeUrl("owner", ws, "freeagent", "STATE"));
    expect(url.origin + url.pathname).toBe("https://api.freeagent.com/v2/approve_app");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.has("scope")).toBe(false);
    const conn = await ig.completeOAuth("owner", ws, "freeagent", "the-code");
    const call = seen[0]!;
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from("fa-id:fa-secret").toString("base64")}`);
    expect(new URLSearchParams(call.body).get("code")).toBe("the-code");
    expect(new URLSearchParams(call.body).has("client_secret")).toBe(false);
    expect(JSON.stringify(ig.list("owner", ws))).not.toContain("fa-a");
    expect(conn.status).toBe("connected");
  });

  it("reads each month of profit and loss with the bearer token and an app name", async () => {
    const { ig, ws, seen } = await setup((s) => (s.url.endsWith("/v2/token_endpoint") ? Response.json({ access_token: "fa-a", refresh_token: "fa-r", expires_in: 3600 }) : summary()));
    const conn = await ig.completeOAuth("owner", ws, "freeagent", "c");
    const out = await ig.sync("owner", ws, conn.id);
    expect(out.added).toBeGreaterThan(0);
    const read = seen.find((s) => s.url.includes("profit_and_loss/summary"))!;
    expect(read.headers.authorization).toBe("Bearer fa-a");
    expect(read.headers["user-agent"]).toBeTruthy();
    expect(read.url).toMatch(/from_date=\d{4}-\d{2}-01&to_date=\d{4}-\d{2}-\d{2}/);
  });

  it("renews an expired token and keeps the new refresh token", async () => {
    let n = 0;
    const clock = { d: new Date() };
    const { ig, ws, seen } = await setup((s) => {
      if (!s.url.endsWith("/v2/token_endpoint")) return summary();
      return Response.json(n++ === 0 ? { access_token: "old", refresh_token: "r1", expires_in: 3600 } : { access_token: "new", refresh_token: "r2", expires_in: 3600 });
    }, () => clock.d);
    const conn = await ig.completeOAuth("owner", ws, "freeagent", "c");
    clock.d = new Date(clock.d.getTime() + 2 * 3600_000);
    await ig.sync("owner", ws, conn.id);
    expect(new URLSearchParams(seen.filter((s) => s.url.endsWith("/token_endpoint"))[1]!.body).get("refresh_token")).toBe("r1");
    expect(seen.filter((s) => s.url.includes("profit_and_loss")).at(-1)!.headers.authorization).toBe("Bearer new");
  });

  it("says plainly when FreeAgent refuses the key, is rate limiting, or says no at the token address", async () => {
    for (const [status, words] of [[401, /connect FreeAgent again/], [429, /slow down/]] as const) {
      const { ig, ws } = await setup((s) => (s.url.endsWith("/v2/token_endpoint") ? Response.json({ access_token: "a", expires_in: 3600 }) : new Response("{}", { status })));
      const conn = await ig.completeOAuth("owner", ws, "freeagent", "c");
      await expect(ig.sync("owner", ws, conn.id)).rejects.toThrow(words);
    }
    const { ig, ws } = await setup(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(ig.completeOAuth("owner", ws, "freeagent", "c")).rejects.toThrow(/FreeAgent did not approve the connection \(it answered: invalid_grant\)/);
  });
});
