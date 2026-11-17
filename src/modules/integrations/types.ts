/**
 * Integrations connect a customer's business apps (payroll, tills, accounting) to MAIZ Agents.
 *
 * Adding an app means writing one Connector object and registering it. Core code never
 * knows about Square, BrightPay or any other app: it only knows the shapes in this file.
 * Every connector turns the app's data into the same few normalised records (a day of sales,
 * a payroll run), so employees and the ledger work the same whichever app it came from.
 */

/** What a connection can be used for. Employees are granted capabilities, never raw app access. */
export type Capability =
  | "sales.read" | "payroll.read" | "accounts.read" | "traffic.read" | "search.read"
  | "crm.read" | "support.read" | "inbox.read" | "bookings.read" | "audience.read" | "tasks.read" | "reviews.read" | "suppliers.read"
  | "social.read" | "ads.read" | "documents.read";

export type Category = "till" | "payroll" | "accounting" | "payments" | "ecommerce" | "marketing" | "bridge" | "customers" | "messaging" | "teamwork";

/**
 * How honest we can be about an app today.
 * - live: we call the app's public API.
 * - file: the app only exports files (CSV/Excel); the owner uploads them.
 * - partner: an API exists but only for approved partners; file import until we are approved.
 * - planned: public API exists, connector not written yet; file import works meanwhile.
 * - approval: a public API exists but the provider must review and approve MAIZ first (days to weeks). The owner
 *   follows `setup.approval` on the Connections page; clients use Zapier or Make until it is approved.
 */
export type Availability = "live" | "file" | "partner" | "planned" | "approval";

export type AuthSpec =
  | {
      kind: "oauth2";
      authorizeUrl: string;
      tokenUrl: string;
      scopes: readonly string[];
      /** Prefix of the environment variables holding our app's id and secret, e.g. SQUARE -> SQUARE_CLIENT_ID. */
      envPrefix: string;
      /** Extra query parameters some apps want on the authorize URL. */
      authorizeParams?: Record<string, string>;
      /** How the app wants our id and secret at its token address. Default: in the form body. */
      tokenAuth?: "basic" | "body";
      /** The provider wants (or allows) PKCE: a one-time proof sent with the sign-in and again with the code. */
      pkce?: boolean;
    }
  | { kind: "api_key"; fields: readonly { key: string; label: string; help?: string; /** Longest value accepted. Default 500; some tokens (Printify) are longer. */ maxLength?: number }[] }
  | { kind: "file"; accepts: string; howToExport: readonly string[] }
  /** Zapier, Make or any tool that can POST JSON to a URL. */
  | { kind: "webhook" }
  /** No direct connector yet: the card offers the webhook bridge (Zapier, Make) meanwhile. */
  | { kind: "bridge" };

/** Amounts are integers in minor units (pence, cents), like the ledger. */
export interface SalesDay {
  /** YYYY-MM-DD */
  date: string;
  currency: string;
  /** Takings including sales tax, excluding tips. */
  gross: number;
  /** Sales tax inside gross. 0 when the app does not say. */
  tax: number;
  tips: number;
  /** Card processing fees the till provider kept. */
  fees: number;
  refunds: number;
  transactions: number;
}

export interface PayrollRun {
  /** YYYY-MM-DD the staff were paid. */
  payDate: string;
  currency: string;
  /** Total gross pay. */
  gross: number;
  /** Income tax withheld (PAYE in the UK and Ireland). */
  incomeTax: number;
  /** Employee social insurance (NI in the UK, PRSI/USC in Ireland). */
  employeeInsurance: number;
  employerInsurance: number;
  employeePension: number;
  employerPension: number;
  /** Anything else taken from pay (student loan, attachments). */
  otherDeductions: number;
  net: number;
  headcount: number;
}

/** A month of the owner's own books kept in an accounting app. Read for context; never re-posted to our ledger. */
export interface AccountsMonth {
  /** YYYY-MM */
  month: string;
  currency: string;
  income: number;
  costOfSales: number;
  expenses: number;
  netProfit: number;
}

/** One day of a website's visits, from the owner's own analytics. Revenue is in minor units, like the ledger. */
export interface TrafficDay {
  /** YYYY-MM-DD */
  date: string;
  currency: string;
  sessions: number;
  users: number;
  newUsers: number;
  engagedSessions: number;
  /** Key events (what the owner marked as a goal: a sign-up, a purchase, an enquiry). */
  conversions: number;
  revenue: number;
  /** Visits by where they came from (organic search, direct, social ...), biggest first. */
  channels: { name: string; sessions: number; conversions: number }[];
}

/** One day of a website's appearance in Google search. */
export interface SearchDay {
  /** YYYY-MM-DD */
  date: string;
  clicks: number;
  impressions: number;
  /** Average position in the results (1 is the top), to one decimal. */
  position: number;
  /** The searches that brought the most clicks in the 28 days to this date. Only the newest day carries it. */
  topQueries?: { query: string; clicks: number; impressions: number; position: number }[];
}

/**
 * One day of customer-facing activity from an app that is not about money: leads and deals (CRM), support
 * tickets, the inbox, bookings, subscribers, tasks, reviews. `figures` are plain counts (or money in minor units,
 * or a rating times 100); `areas.ts` says what each figure is called. Numbers only, so nothing a customer typed
 * can ever reach an employee's instructions.
 */
export type ActivityArea = "crm" | "support" | "inbox" | "bookings" | "audience" | "tasks" | "reviews" | "supply" | "social" | "ads" | "documents";
export interface ActivityDay {
  /** YYYY-MM-DD */
  date: string;
  area: ActivityArea;
  currency: string;
  figures: Record<string, number>;
}

export interface Records {
  sales?: SalesDay[];
  payroll?: PayrollRun[];
  accounts?: AccountsMonth[];
  traffic?: TrafficDay[];
  search?: SearchDay[];
  activity?: ActivityDay[];
}

export interface ParsedFile extends Records {
  /** Plain-language problems the owner should see before confirming. */
  warnings: string[];
  /** Column headings we did not recognise (so the owner can tell us what they mean). */
  unmapped: string[];
}

export type Credentials =
  /** `tenant` is the organisation inside the app when one login can see several (Xero tenant id). */
  | { kind: "oauth2"; accessToken: string; refreshToken?: string; expiresAt?: string; tenant?: string }
  | { kind: "api_key"; values: Record<string, string> }
  | { kind: "webhook"; secret: string };

/** What a connector gets when it runs. Never holds anything from another customer. */
export interface ConnectorContext {
  credentials: Credentials;
  http: typeof fetch;
  now: () => Date;
  /** The organisation's base currency, used when an app does not say. */
  currency: string;
  /** MAIZ's own registration with the provider, for the few apps that want its id or an extra key on every call. */
  app?: OAuthApp;
}

export interface DateRange {
  from: string;
  to: string;
}

/** What the platform owner does once so every client can connect this app with one click (shown on the Connections page). */
export interface ProviderSetup {
  /** The provider's developer console, where the owner registers MAIZ. */
  console: { href: string; label: string };
  /** Plain steps, in order. Say what to look for, because provider screens change. */
  steps: readonly string[];
  /** Approval the provider wants before other businesses can connect, and how long it usually takes. */
  approval?: string;
}

/** An extra box on the owner's card beside the client id and secret (a developer token, an application id). */
export interface OwnerField { key: string; label: string; help: string; secret: boolean; required: boolean; placeholder?: string; pattern?: RegExp }

export interface Connector {
  /** Stable id, lower-case, used in URLs and storage. */
  key: string;
  name: string;
  category: Category;
  /** One line a non-technical owner understands. */
  summary: string;
  availability: Availability;
  capabilities: readonly Capability[];
  auth: AuthSpec;
  /** Honest note shown on the card, e.g. "BrightPay has no public API yet". */
  note?: string;
  /** Owner-side registration steps. Every OAuth connector and every `approval` entry has them. */
  setup?: ProviderSetup;
  /** Countries the app mainly serves (ISO codes); empty means global. */
  regions?: readonly string[];
  /** Pull data from the app's API. Only for live connectors. */
  read?(ctx: ConnectorContext, range: DateRange): Promise<Records>;
  /** Turn an exported file (CSV text) into records. */
  parseFile?(text: string, opts: FileOptions): ParsedFile;
  /** Exchange an OAuth code for credentials. Defaults to the standard form-encoded exchange. */
  exchangeCode?(http: typeof fetch, app: OAuthApp, code: string, params?: Record<string, string>): Promise<{ credentials: Credentials; externalAccount?: string }>;
  /** Check API-key values before saving them. Returns a plain-language problem, or undefined when fine. */
  validate?(values: Record<string, string>): string | undefined;
  /**
   * What the connected login can pick from (Google Analytics properties, Search Console sites). When there is
   * more than one, the owner chooses; the pick is kept as the credentials' `tenant`.
   */
  choices?(ctx: ConnectorContext): Promise<{ id: string; name: string }[]>;
  /** Set when there is no public way in at all. The owner's card says so plainly instead of promising a connection. */
  unavailable?: string;
  /** Extra boxes the owner fills in once. Their values reach the connector as `app.extra`. */
  ownerFields?: readonly OwnerField[];
  /** Builds the sign-in address when the provider does not follow the usual shape (Amazon, eBay, TikTok). */
  authorizeUrl?(app: OAuthApp, state: string, challenge?: string, values?: Record<string, string>): string;
  /**
   * Boxes the client fills in before the sign-in (Shopify's shop address). Checked with `validate`, kept in the signed
   * state, and handed back to `exchangeCode` as params beside the code.
   */
  connectFields?: readonly { key: string; label: string; help?: string }[];
  /** "none": the provider has no harmless way to check the owner's details, so the card's test says so. */
  ownerTest?: "none" | "salesforce";
  /** Swap a refresh token for a fresh access token. Called before `read` when the token has expired. */
  refresh?(http: typeof fetch, app: OAuthApp, credentials: Credentials): Promise<Credentials>;
}

export interface FileOptions {
  currency: string;
  /** Used when the file has no date column (some payroll summaries are one pay run per file). */
  date?: string;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Values of the connector's `ownerFields`. */
  extra?: Record<string, string>;
}

export class IntegrationError extends Error {}
