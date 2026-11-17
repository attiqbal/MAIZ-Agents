import type { Availability, Capability, Category, Connector, ProviderSetup } from "./types.js";

/**
 * Customer-focused apps we list but do not read directly yet. Two honest kinds:
 *  - approval: the provider must review and approve MAIZ first. `setup` holds the owner's steps and the usual wait.
 *  - planned: a self-serve public API exists; the connector is not written. Zapier or Make works meanwhile.
 * Facts checked 2026-11 from each provider's developer pages; confirm current rules before applying, they change.
 * The apps that now have a connector (Google Business Profile, LinkedIn Pages, TikTok, ...) live in connectors/listed-*.ts.
 */
const entry = (key: string, name: string, category: Category, capabilities: Capability[], availability: Availability, summary: string, note: string, setup?: ProviderSetup, regions?: string[]): Connector => ({
  key, name, category, capabilities, availability, summary, regions, setup,
  note: `${note} Until then, connect it through Zapier or Make.`,
  auth: { kind: "bridge" },
});

const approval = (console: ProviderSetup["console"], steps: string[], wait: string): ProviderSetup => ({ console, steps, approval: wait });

export const APPROVAL_APPS: readonly Connector[] = [
  {
    ...entry("indeed", "Indeed", "teamwork", [], "partner", "Applications to your job adverts.", "Indeed opens its employer APIs to approved partners only."),
    unavailable: "Cannot be connected: Indeed's employer interfaces are only for approved partner companies, and there is no open sign-in for employers. Forward application emails into Zapier or Make instead.",
  },
];

const planned = (key: string, name: string, category: Category, capabilities: Capability[], summary: string, note: string, regions?: string[]) =>
  entry(key, name, category, capabilities, "planned", summary, note, undefined, regions);

export const PLANNED_CUSTOMER_APPS: readonly Connector[] = [
  // Sales and customers
  planned("zoho-crm", "Zoho CRM", "customers", ["crm.read"], "Leads and deals from Zoho CRM.", "Zoho CRM has a public OAuth API. Direct connection is planned."),
  planned("freshsales", "Freshsales", "customers", ["crm.read"], "Leads and deals from Freshsales.", "Freshsales has a public API with an API key. Direct connection is planned."),
  // Messaging and email
  planned("microsoft-teams", "Microsoft Teams", "messaging", [], "Let your AI team post in your Teams channels.", "Teams needs a bot registered in Azure and approved by each organisation's administrator. Planned as an employee channel, like Slack."),
  planned("telegram", "Telegram", "messaging", [], "Let customers or staff message your AI team on Telegram.", "Telegram bots are free and self-serve with a bot token. Planned as an employee channel, like Slack."),
  planned("discord", "Discord", "messaging", [], "Let your community message your AI team on Discord.", "Discord bots are self-serve. Planned as an employee channel, like Slack."),
  planned("klaviyo", "Klaviyo", "marketing", ["audience.read"], "Your email list and campaign results from Klaviyo.", "Klaviyo has a public API with a private key. Direct connection is planned."),
  // Websites and shops
  planned("wordpress", "WordPress", "marketing", [], "Publish approved posts to your WordPress site.", "WordPress.com and self-hosted sites both have public APIs. Planned for the promotion agent."),
  planned("wix", "Wix", "ecommerce", ["sales.read"], "Orders from your Wix shop.", "Wix has a public API for apps. Direct connection is planned."),
  // Marketing
  planned("buffer", "Buffer", "marketing", [], "Schedule approved posts through Buffer.", "Buffer is not giving out new API access at the moment, so use Zapier or Make."),
  planned("bing-webmaster", "Bing Webmaster Tools", "marketing", ["search.read"], "Your site's appearance in Bing search.", "Bing Webmaster has a public API with a key. Direct connection is planned."),
  planned("semrush", "Semrush", "marketing", ["search.read"], "Keyword rankings and competitors from Semrush.", "Semrush's API is for paid plans and uses API units. Planned."),
  planned("ahrefs", "Ahrefs", "marketing", ["search.read"], "Backlinks and rankings from Ahrefs.", "Ahrefs' API is for paid plans. Planned."),
  // Documents and teamwork
  planned("google-drive", "Google Drive, Docs and Sheets", "teamwork", [], "Let your team read documents you choose to share.", "Reading documents is a different feature from reading figures (it needs a knowledge-base store and a file picker) and Google's Drive scopes need verification. Planned as its own piece of work."),
  planned("microsoft-onedrive", "Microsoft 365 / OneDrive", "teamwork", [], "Let your team read documents you choose to share.", "Needs the same knowledge-base feature as Google Drive. Planned as its own piece of work."),
  planned("notion", "Notion", "teamwork", [], "Let your team read the Notion pages you share.", "Notion has a public API where you pick the pages. Needs the knowledge-base feature. Planned."),
  planned("airtable", "Airtable", "teamwork", [], "Counts and figures from your Airtable bases.", "Airtable has a public OAuth API. Planned."),
  planned("dropbox", "Dropbox", "teamwork", [], "Let your team read documents you choose to share.", "Needs the knowledge-base feature. Planned."),
  planned("monday", "monday.com", "teamwork", ["tasks.read"], "Open and overdue items on your monday.com boards.", "monday.com has a public API. Direct connection is planned."),
  // Money
  planned("truelayer", "Bank accounts (open banking)", "accounting", ["accounts.read"], "Read-only bank balances and transactions.", "Open banking must go through a regulated provider such as TrueLayer or GoCardless Bank Account Data; the provider holds the regulatory licence. Planned, with a pricing check first.", ["GB", "IE", "FR", "DE", "ES"]),
  planned("wise", "Wise", "payments", ["sales.read"], "Wise balances and transfers.", "Wise has a public API with a read-only personal token. Direct connection is planned."),
  planned("sumup-api", "SumUp (direct)", "till", ["sales.read"], "Sales from SumUp, read every day.", "SumUp has a public OAuth API. Direct connection is planned; the sales export works now."),
  // People
  planned("bamboohr", "BambooHR", "payroll", [], "Headcount and time off from BambooHR.", "BambooHR has a public API with a key. Direct connection is planned."),
  planned("personio", "Personio", "payroll", [], "Headcount and absences from Personio.", "Personio has a public API. Direct connection is planned.", ["GB", "DE", "ES", "FR", "IE"]),
];
