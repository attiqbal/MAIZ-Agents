import { brightpay } from "./connectors/brightpay.js";
import { square } from "./connectors/square.js";
import { parseTillCsv, tillFile } from "./connectors/till-csv.js";
import { webhookBridge } from "./connectors/webhook.js";
import { stripe } from "./connectors/stripe.js";
import { xero } from "./connectors/xero.js";
import { IntegrationError, type Availability, type Capability, type Category, type Connector } from "./types.js";

/** Holds every connector. A new app is one `register()` call; nothing else in core changes. */
export class ConnectorRegistry {
  private byKey = new Map<string, Connector>();

  register(c: Connector): void {
    if (!/^[a-z0-9-]{2,40}$/.test(c.key)) throw new IntegrationError(`bad connector key ${c.key}`);
    if (this.byKey.has(c.key)) throw new IntegrationError(`connector ${c.key} is already registered`);
    if (c.availability === "live" && c.auth.kind !== "webhook" && !c.read) throw new IntegrationError(`${c.key} is live but cannot read`);
    if (c.auth.kind === "file" && !c.parseFile) throw new IntegrationError(`${c.key} takes files but cannot parse them`);
    this.byKey.set(c.key, c);
  }

  get(key: string): Connector | undefined {
    return this.byKey.get(key);
  }

  require(key: string): Connector {
    const c = this.byKey.get(key);
    if (!c) throw new IntegrationError("unknown app");
    return c;
  }

  list(): Connector[] {
    return [...this.byKey.values()];
  }
}

/**
 * Apps with a public or partner API that we have not written a live connector for yet.
 * They are listed honestly and work through their own CSV export until the connector lands.
 * Facts checked 2026-11 against each vendor's developer site; re-check before building.
 */
const tillByFile = (key: string, name: string, availability: Availability, note: string, regions?: string[]): Connector => ({
  key, name, category: "till", availability, capabilities: ["sales.read"], note, regions,
  summary: `Sales from ${name}. Upload the sales export today; direct connection is on the way.`,
  auth: { kind: "file", accepts: ".csv", howToExport: [`In ${name}'s back office, open Reports, then Sales.`, "Export the dates you want as CSV.", "Upload the file here."] },
  parseFile: parseTillCsv,
});

export const PLANNED: readonly Connector[] = [
  tillByFile("sumup", "SumUp", "planned", "SumUp has a public OAuth API for transaction history. Direct connection is next on our list."),
  tillByFile("zettle", "Zettle by PayPal", "planned", "Zettle has a public OAuth API for purchases. Direct connection is planned."),
  tillByFile("epos-now", "Epos Now", "planned", "Epos Now has a REST API with an API key and secret from your back office. Direct connection is planned.", ["GB", "IE", "US"]),
  tillByFile("lightspeed", "Lightspeed", "partner", "Lightspeed's APIs need approval as a partner. Until then, use the sales export."),
  tillByFile("clover", "Clover", "planned", "Clover has a public API through its app market. Direct connection is planned."),
  tillByFile("toast", "Toast", "partner", "Toast opens its API to approved partners only. Until then, use the sales export.", ["US", "GB", "IE"]),
];

/** Apps with no direct connector yet and no useful file export: the card offers Zapier or Make meanwhile. */
const viaBridge = (key: string, name: string, category: Category, capabilities: Capability[], availability: Availability, summary: string, note: string, regions?: string[]): Connector => ({
  key, name, category, capabilities, availability, summary, note: `${note} Until then, connect it through Zapier or Make.`, regions, auth: { kind: "bridge" },
});

/** The apps most small businesses use, beyond the ones we connect directly. Checked 2026-11. */
export const COMMON_APPS: readonly Connector[] = [
  // Accounting
  viaBridge("quickbooks", "QuickBooks Online", "accounting", ["accounts.read"], "planned", "Your books in QuickBooks: profit and loss month by month.", "QuickBooks has a public OAuth API with a Profit and Loss report. Direct connection is next after Xero."),
  viaBridge("sage", "Sage Accounting", "accounting", ["accounts.read"], "planned", "Your books in Sage Accounting (Sage Business Cloud).", "Sage Accounting has a public OAuth API. Direct connection is planned.", ["GB", "IE", "US", "CA", "ES", "FR", "DE"]),
  viaBridge("freeagent", "FreeAgent", "accounting", ["accounts.read"], "planned", "Your books in FreeAgent.", "FreeAgent has a public OAuth API. Direct connection is planned.", ["GB"]),
  viaBridge("zoho-books", "Zoho Books", "accounting", ["accounts.read"], "planned", "Your books in Zoho Books.", "Zoho Books has a public OAuth API. Direct connection is planned."),
  viaBridge("myob", "MYOB", "accounting", ["accounts.read"], "planned", "Your books in MYOB.", "MYOB has a public API that now uses granular scopes. Direct connection is planned.", ["AU", "NZ"]),
  viaBridge("freshbooks", "FreshBooks", "accounting", ["accounts.read"], "planned", "Invoices and expenses in FreshBooks.", "FreshBooks has a public OAuth API. Direct connection is planned."),
  // Payments and online shops
  viaBridge("paypal", "PayPal", "payments", ["sales.read"], "planned", "PayPal payments, refunds and fees.", "PayPal has a public Transaction Search API. Direct connection is planned."),
  viaBridge("shopify", "Shopify", "ecommerce", ["sales.read"], "planned", "Online shop orders, refunds and payouts from Shopify.", "Shopify has a public Admin API for apps. Direct connection is planned."),
  viaBridge("woocommerce", "WooCommerce", "ecommerce", ["sales.read"], "planned", "Orders from your WooCommerce shop.", "WooCommerce has a REST API with keys from your site. Direct connection is planned."),
  viaBridge("gocardless", "GoCardless", "payments", ["sales.read"], "planned", "Direct Debit payments collected by GoCardless.", "GoCardless has a public API. Direct connection is planned.", ["GB", "IE", "FR", "DE", "AU"]),
  // Payroll and HR
  viaBridge("gusto", "Gusto", "payroll", ["payroll.read"], "partner", "US payroll from Gusto.", "Gusto's API is for approved partners.", ["US"]),
  viaBridge("staffology", "Staffology Payroll", "payroll", ["payroll.read"], "planned", "UK payroll from Staffology (IRIS).", "Staffology has a public payroll API. Direct connection is planned.", ["GB"]),
  viaBridge("deel", "Deel", "payroll", ["payroll.read"], "planned", "International payroll and contractors from Deel.", "Deel has a public API. Direct connection is planned."),
];

/** The registry the platform uses, with every connector we ship. */
export function defaultRegistry(): ConnectorRegistry {
  const r = new ConnectorRegistry();
  for (const c of [xero, square, stripe, brightpay, tillFile, webhookBridge, ...PLANNED, ...COMMON_APPS]) r.register(c);
  return r;
}
