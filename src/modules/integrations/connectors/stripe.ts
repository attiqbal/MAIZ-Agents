import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records, type SalesDay } from "../types.js";

/**
 * Stripe (online card payments), public API with a key.
 * We only accept a restricted key (rk_...) so the key can read and never charge, refund or pay out.
 * Reads balance transactions: charges and payments add to takings, refunds count as refunds, fees are Stripe's.
 * Zero-decimal currencies (JPY, KRW) are already whole units in Stripe; the ledger treats them as minor units too.
 */
const API = "https://api.stripe.com/v1";
const MAX_PAGES = 50;

interface BalanceTxn { amount?: number; fee?: number; currency?: string; created?: number; type?: string }

async function readStripe(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  if (ctx.credentials.kind !== "api_key") throw new IntegrationError("Stripe needs a restricted key");
  const key = ctx.credentials.values.restrictedKey!;
  const days = new Map<string, SalesDay>();
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API}/balance_transactions`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("created[gte]", String(Date.parse(`${range.from}T00:00:00Z`) / 1000));
    url.searchParams.set("created[lte]", String(Date.parse(`${range.to}T23:59:59Z`) / 1000));
    if (after) url.searchParams.set("starting_after", after);
    const res = await ctx.http(url.toString(), { headers: { authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("Stripe refused the key. Check it can read Balance, or create a new restricted key.");
    if (!res.ok) throw new IntegrationError(`Stripe answered ${res.status}`);
    const body = (await res.json()) as { data?: (BalanceTxn & { id: string })[]; has_more?: boolean };
    for (const t of body.data ?? []) add(days, t);
    after = body.data?.at(-1)?.id;
    if (!body.has_more || !after) break;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function add(days: Map<string, SalesDay>, t: BalanceTxn): void {
  if (!t.created || !t.currency) return;
  const kind = t.type ?? "";
  if (!["charge", "payment", "refund", "payment_refund"].includes(kind)) return; // payouts, transfers and top-ups are not sales
  const date = new Date(t.created * 1000).toISOString().slice(0, 10);
  const currency = t.currency.toUpperCase();
  const k = `${date}|${currency}`;
  const day = days.get(k) ?? { date, currency, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 };
  if (kind.includes("refund")) day.refunds += Math.abs(t.amount ?? 0);
  else { day.gross += t.amount ?? 0; day.transactions += 1; }
  day.fees += Math.abs(t.fee ?? 0);
  days.set(k, day);
}

export const stripe: Connector = {
  key: "stripe",
  name: "Stripe",
  category: "payments",
  summary: "Online card payments, refunds and Stripe's fees, read every day.",
  availability: "live",
  capabilities: ["sales.read"],
  note: "Uses a read-only restricted key, so it can never charge, refund or pay out.",
  auth: {
    kind: "api_key",
    fields: [{ key: "restrictedKey", label: "Stripe restricted key", help: "In Stripe, go to Developers, API keys, Create restricted key. Give it Read on Balance and nothing else, then paste the key that starts with rk_." }],
  },
  read: readStripe,
  validate(values) {
    const k = values.restrictedKey ?? "";
    if (/^sk_/.test(k)) return "That is a secret key with full access. Please create a restricted key (it starts with rk_) instead.";
    if (!/^rk_(live|test)_[A-Za-z0-9]{10,}$/.test(k)) return "That does not look like a Stripe restricted key (it starts with rk_live_ or rk_test_).";
    return undefined;
  },
};
