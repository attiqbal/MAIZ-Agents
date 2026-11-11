/**
 * Integrations connect a customer's business apps (payroll, tills, accounting) to MAIZ Agents.
 *
 * Adding an app means writing one Connector object and registering it. Core code never
 * knows about Square, BrightPay or any other app: it only knows the shapes in this file.
 * Every connector turns the app's data into the same few normalised records (a day of sales,
 * a payroll run), so employees and the ledger work the same whichever app it came from.
 */

/** What a connection can be used for. Employees are granted capabilities, never raw app access. */
export type Capability = "sales.read" | "payroll.read" | "accounts.read";

export type Category = "till" | "payroll" | "accounting" | "payments" | "ecommerce" | "bridge";

/**
 * How honest we can be about an app today.
 * - live: we call the app's public API.
 * - file: the app only exports files (CSV/Excel); the owner uploads them.
 * - partner: an API exists but only for approved partners; file import until we are approved.
 * - planned: public API exists, connector not written yet; file import works meanwhile.
 */
export type Availability = "live" | "file" | "partner" | "planned";

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
    }
  | { kind: "api_key"; fields: readonly { key: string; label: string; help?: string }[] }
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

export interface Records {
  sales?: SalesDay[];
  payroll?: PayrollRun[];
  accounts?: AccountsMonth[];
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
}

export interface DateRange {
  from: string;
  to: string;
}

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
  /** Countries the app mainly serves (ISO codes); empty means global. */
  regions?: readonly string[];
  /** Pull data from the app's API. Only for live connectors. */
  read?(ctx: ConnectorContext, range: DateRange): Promise<Records>;
  /** Turn an exported file (CSV text) into records. */
  parseFile?(text: string, opts: FileOptions): ParsedFile;
  /** Exchange an OAuth code for credentials. Defaults to the standard form-encoded exchange. */
  exchangeCode?(http: typeof fetch, app: OAuthApp, code: string): Promise<{ credentials: Credentials; externalAccount?: string }>;
  /** Check API-key values before saving them. Returns a plain-language problem, or undefined when fine. */
  validate?(values: Record<string, string>): string | undefined;
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
}

export class IntegrationError extends Error {}
