import type { Availability, Capability, Category, Connector, ProviderSetup } from "./types.js";

/**
 * Customer-focused apps we list but do not read directly yet. Two honest kinds:
 *  - approval: the provider must review and approve MAIZ first. `setup` holds the owner's steps and the usual wait.
 *  - planned: a self-serve public API exists; the connector is not written. Zapier or Make works meanwhile.
 * Facts checked 2026-11 from each provider's developer pages; confirm current rules before applying, they change.
 */
const entry = (key: string, name: string, category: Category, capabilities: Capability[], availability: Availability, summary: string, note: string, setup?: ProviderSetup, regions?: string[]): Connector => ({
  key, name, category, capabilities, availability, summary, regions, setup,
  note: `${note} Until then, connect it through Zapier or Make.`,
  auth: { kind: "bridge" },
});

const approval = (console: ProviderSetup["console"], steps: string[], wait: string): ProviderSetup => ({ console, steps, approval: wait });

export const APPROVAL_APPS: readonly Connector[] = [
  entry("google-business-profile", "Google Business Profile", "customers", ["reviews.read"], "approval", "New Google reviews and your average star rating.", "Google gives Business Profile API access only after a request that it reviews.",
    approval({ href: "https://developers.google.com/my-business/content/prereqs", label: "Business Profile API: request access" }, [
      "Check your Business Profile has been verified and active for 60 days or more.",
      "Fill in Google's Business Profile API access request form with the Google Cloud project number, then enable the APIs once it is approved.",
      "Add the business.manage scope to the Google app, then add the client ID and secret here.",
    ], "Usually one to two weeks."),
  ),
  entry("trustpilot", "Trustpilot", "customers", ["reviews.read"], "approval", "New Trustpilot reviews and your TrustScore.", "Trustpilot's business APIs need an API key from your Trustpilot Business account on a paid plan.",
    approval({ href: "https://developers.trustpilot.com/", label: "Trustpilot developers" }, [
      "Each client with a Trustpilot Business plan can make their own API key under Integrations, API. Until a key flow is built, use Zapier or Make.",
    ], "No MAIZ-side approval, but it needs the client's paid plan."),
  ),
  entry("linkedin-pages", "LinkedIn Pages", "marketing", [], "approval", "Post to and read analytics for your company LinkedIn Page.", "LinkedIn only opens its Pages APIs to approved partners. Reading other people's profiles is not offered at all.",
    approval({ href: "https://www.linkedin.com/developers/apps", label: "LinkedIn developer apps" }, [
      "Create a LinkedIn app tied to a company Page.",
      "Request the Community Management API product. LinkedIn asks for a description of the use and a demo video.",
      "Once approved, add the client ID and secret here.",
    ], "Usually two to six weeks, and LinkedIn can say no."),
  ),
  entry("tiktok", "TikTok", "marketing", [], "approval", "Post approved videos and read your account's performance.", "TikTok's Content Posting API needs an audit before posts can be public.",
    approval({ href: "https://developers.tiktok.com/", label: "TikTok for Developers" }, [
      "Create an app, add the Login Kit and Content Posting API products, and list your website and privacy pages.",
      "Submit the app for review with a demo video. Until the Content Posting audit passes, posts from the API are private.",
    ], "Review takes days to weeks; the posting audit can take longer."),
  ),
  entry("google-ads", "Google Ads", "marketing", [], "approval", "Spend, clicks and cost per lead from your Google Ads account (read-only).", "Google Ads needs a developer token that Google approves.",
    approval({ href: "https://ads.google.com/aw/apicenter", label: "Google Ads: API Center (manager account)" }, [
      "Open a Google Ads manager account and apply for a developer token (API Center). Ask for Basic access for read-only reporting.",
      "Add the adwords scope to the Google app, then add the developer token and client ID here.",
    ], "Basic access is usually decided within a few working days."),
  ),
  entry("meta-ads", "Meta Ads", "marketing", [], "approval", "Spend, reach and cost per lead from your Facebook and Instagram ads (read-only).", "Reading ad accounts needs the ads_read permission, which Meta reviews.",
    approval({ href: "https://developers.facebook.com/apps/", label: "Meta for Developers: your apps" }, [
      "In the Meta app used for the Page and Instagram, request Advanced Access to ads_read in App Review.",
      "Meta asks for a screencast of the feature and a privacy page. See docs/META-APP-REVIEW.md for the wording used for the other permissions.",
    ], "Usually a few days to two weeks."),
  ),
  entry("amazon-seller", "Amazon Seller Central", "ecommerce", ["sales.read"], "approval", "Orders and sales from your Amazon seller account.", "Amazon's Selling Partner API needs a developer profile that Amazon approves, and a security review for sensitive data.",
    approval({ href: "https://sellercentral.amazon.com/", label: "Seller Central: Develop Apps" }, [
      "Register as a developer in Seller Central (Apps and Services, Develop Apps) and describe the use. Choose only the order and report roles, no buyer personal data.",
      "Create the app, then add its client ID and secret here.",
    ], "Usually one to four weeks."),
    ["US", "GB", "DE", "FR", "IT", "ES", "CA"]),
  entry("etsy", "Etsy", "ecommerce", ["sales.read"], "approval", "Orders and sales from your Etsy shop.", "Etsy gives personal keys quickly but needs approval for commercial use by other sellers.",
    approval({ href: "https://www.etsy.com/developers/register", label: "Etsy developers: register an app" }, [
      "Register an app and ask for commercial access, describing that you read receipts for the sellers who connect.",
    ], "Usually a week or two."),
  ),
  entry("ebay", "eBay", "ecommerce", ["sales.read"], "approval", "Orders and sales from your eBay account.", "eBay lets you apply for a production keyset after you pass a compliance check.",
    approval({ href: "https://developer.ebay.com/", label: "eBay developers" }, [
      "Create a developer account and keyset. Ask for a production keyset and OAuth consent for the Sell Fulfillment API (read-only scope).",
    ], "Usually a few days."),
  ),
  entry("docusign", "DocuSign", "teamwork", [], "approval", "See which agreements are waiting for a signature.", "DocuSign apps must pass a go-live review before they can connect other accounts.",
    approval({ href: "https://developers.docusign.com/", label: "DocuSign developer centre" }, [
      "Build and test in the developer sandbox, then request Go-Live: DocuSign checks the calls made in the sandbox.",
    ], "Usually one to two weeks."),
  ),
  entry("indeed", "Indeed", "teamwork", [], "approval", "Applications to your job adverts.", "Indeed opens its employer APIs to approved partners only.",
    approval({ href: "https://docs.indeed.com/", label: "Indeed partner docs" }, [
      "Apply to Indeed's partner programme with your use case. Without approval, forward applications by email into Zapier or Make.",
    ], "Partner decision; no fixed time."),
  ),
  entry("pinterest", "Pinterest", "marketing", [], "approval", "Pins and board performance for your business account.", "Pinterest gives trial access first; upgrading to standard needs a demo video.",
    approval({ href: "https://developers.pinterest.com/apps/", label: "Pinterest developer apps" }, [
      "Create an app, request Trial access, then Standard access with a screencast of the OAuth flow.",
    ], "Usually a few days to two weeks."),
  ),
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
  planned("canva", "Canva", "marketing", [], "Make designs from your brand with Canva.", "Canva's Connect API is for approved integrations."),
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
