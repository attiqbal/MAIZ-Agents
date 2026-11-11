/**
 * What signup knows about each kind of business, as plain data.
 *
 * Signup asks three things by tapping, never by typing: what kind of business,
 * what the owner wants help with, and which apps they already use. This file holds
 * the choices and, for every sector, the sensible defaults, so a café owner and a
 * software founder both see their own words and nobody starts from a blank page.
 *
 * Pure (no Node imports), so the website imports it too and says the same thing.
 */

/** A result the owner wants, in their words. Never an AI feature. */
export type NeedKey =
  | "more-customers"
  | "know-my-numbers"
  | "get-paid"
  | "cut-costs"
  | "stay-legal"
  | "staff"
  | "stock"
  | "raise-money"
  | "online-presence"
  | "less-admin";

export interface Need {
  key: NeedKey;
  /** Shown on the chip. */
  label: string;
  /** The employee who leads on it. */
  lead: string;
  /** The first job that employee does for this need, shown before signup finishes. */
  firstJob: string;
  /** Goes into the "goals" answer of the setup form. */
  goal: string;
}

export const NEEDS: readonly Need[] = [
  { key: "more-customers", label: "Get more customers", lead: "marketing-manager", firstJob: "A 30-day plan to win customers, ready to approve", goal: "win more customers" },
  { key: "know-my-numbers", label: "Know my numbers", lead: "finance-manager", firstJob: "A cash snapshot: what came in, what went out, what is left", goal: "understand cash and profit" },
  { key: "get-paid", label: "Get paid on time", lead: "finance-manager", firstJob: "A list of who owes you money, with polite reminders drafted", goal: "get paid on time" },
  { key: "cut-costs", label: "Cut costs", lead: "business-consultant", firstJob: "A cost check with the three biggest savings", goal: "cut costs" },
  { key: "stay-legal", label: "Stay on the right side of the rules", lead: "compliance-manager", firstJob: "A compliance health check for your kind of business", goal: "stay compliant" },
  { key: "staff", label: "Hire and look after staff", lead: "hr-manager", firstJob: "A people basics checklist: contracts, holiday, policies", goal: "hire and look after staff" },
  { key: "stock", label: "Keep stock and suppliers in order", lead: "supply-chain-manager", firstJob: "A stock and supplier health check", goal: "keep stock and suppliers in order" },
  { key: "raise-money", label: "Raise money or get a loan", lead: "finance-manager", firstJob: "A funding readiness check: what a lender or investor will ask for", goal: "raise money" },
  { key: "online-presence", label: "Look better online", lead: "marketing-manager", firstJob: "A review of your website and social pages with quick fixes", goal: "improve the website and social pages" },
  { key: "less-admin", label: "Spend less time on admin", lead: "admin-manager", firstJob: "A list of the admin your team can take over this week", goal: "spend less time on admin" },
];

/** How an app connects today. Kept honest: it must match the integrations registry (a test checks). */
export type AppHow = "direct" | "file" | "bridge" | "chat";

export interface AppChoice {
  /** The integrations registry key, or "slack". */
  key: string;
  name: string;
  /** What the team gets from it, in a few words. */
  gives: string;
  how: AppHow;
  /** The employee who uses it first. */
  for: string;
  /** ISO country codes where it is offered. Empty means everywhere. */
  regions?: readonly string[];
}

export const APPS: readonly AppChoice[] = [
  { key: "slack", name: "Slack", gives: "Talk to your team where you already chat", how: "chat", for: "admin-manager" },
  { key: "xero", name: "Xero", gives: "Profit and loss, month by month", how: "direct", for: "finance-manager" },
  { key: "quickbooks", name: "QuickBooks", gives: "Profit and loss, month by month", how: "bridge", for: "finance-manager" },
  { key: "sage", name: "Sage", gives: "Your books in Sage", how: "bridge", for: "finance-manager" },
  { key: "freeagent", name: "FreeAgent", gives: "Your books in FreeAgent", how: "bridge", for: "finance-manager", regions: ["GB"] },
  { key: "stripe", name: "Stripe", gives: "Card payments, refunds and fees", how: "direct", for: "finance-manager" },
  { key: "paypal", name: "PayPal", gives: "Payments, refunds and fees", how: "bridge", for: "finance-manager" },
  { key: "gocardless", name: "GoCardless", gives: "Direct Debit payments", how: "bridge", for: "finance-manager", regions: ["GB", "IE", "FR", "DE", "AU", "US"] },
  { key: "square", name: "Square", gives: "Daily takings from your till", how: "direct", for: "finance-manager" },
  { key: "sumup", name: "SumUp", gives: "Daily takings from your card reader", how: "file", for: "finance-manager" },
  { key: "zettle", name: "Zettle", gives: "Daily takings from your card reader", how: "file", for: "finance-manager" },
  { key: "epos-now", name: "Epos Now", gives: "Daily takings from your till", how: "file", for: "finance-manager", regions: ["GB", "IE", "US"] },
  { key: "till-file", name: "Another till", gives: "Daily takings from any till's sales export", how: "file", for: "finance-manager" },
  { key: "shopify", name: "Shopify", gives: "Online orders, refunds and payouts", how: "bridge", for: "finance-manager" },
  { key: "woocommerce", name: "WooCommerce", gives: "Orders from your online shop", how: "bridge", for: "finance-manager" },
  { key: "brightpay", name: "BrightPay", gives: "Payroll totals for the books", how: "file", for: "hr-manager", regions: ["GB", "IE"] },
  { key: "gusto", name: "Gusto", gives: "Payroll totals for the books", how: "bridge", for: "hr-manager", regions: ["US"] },
  { key: "deel", name: "Deel", gives: "International payroll and contractors", how: "bridge", for: "hr-manager" },
];

export interface Sector {
  key: string;
  /** Shown on the tile. */
  label: string;
  /** Under the label, so owners recognise themselves. */
  examples: string;
  /** Words in a business description that point to this sector. Lower case. */
  words: readonly string[];
  /** Pre-ticked needs, most common first. The owner can change them. */
  needs: readonly NeedKey[];
  /** Apps offered first on the apps screen, most common first. */
  apps: readonly string[];
  /** Prefills the Compliance manager's industry question. */
  industry: string;
  /** Prefills "Who are your customers?" as a guess the owner can change. */
  customers: string;
  /** True when the business usually holds stock, so the stock add-on is worth offering. */
  holdsStock?: boolean;
}

export const SECTORS: readonly Sector[] = [
  {
    key: "food-drink", label: "Food and drink", examples: "Café, restaurant, takeaway, bar, bakery",
    words: ["cafe", "café", "coffee", "restaurant", "takeaway", "bar", "pub", "bakery", "catering", "food truck", "kitchen", "pizza", "diner", "bistro"],
    needs: ["know-my-numbers", "more-customers", "staff"], apps: ["square", "sumup", "epos-now", "xero", "brightpay", "slack"],
    industry: "Food and drink (food hygiene, allergens, alcohol licence if you serve it)", customers: "Local customers and regulars", holdsStock: true,
  },
  {
    key: "shop", label: "Shop", examples: "High-street shop, market stall, showroom",
    words: ["shop", "store", "boutique", "retail", "market stall", "florist", "gift", "newsagent", "showroom", "grocer"],
    needs: ["more-customers", "know-my-numbers", "stock"], apps: ["square", "sumup", "zettle", "xero", "till-file", "slack"],
    industry: "Retail (consumer rights, product safety)", customers: "Local shoppers", holdsStock: true,
  },
  {
    key: "online-store", label: "Online store", examples: "Sell products on your own site or a marketplace",
    words: ["online store", "online shop", "ecommerce", "e-commerce", "shopify", "etsy", "amazon", "dropship", "subscription box", "webshop"],
    needs: ["more-customers", "know-my-numbers", "stock"], apps: ["shopify", "woocommerce", "stripe", "paypal", "xero", "slack"],
    industry: "Online retail (distance selling, returns, product safety)", customers: "Online shoppers", holdsStock: true,
  },
  {
    key: "services", label: "Professional services", examples: "Agency, consultancy, accountant, law firm, architect",
    words: ["agency", "consult", "accountan", "bookkeep", "law firm", "solicitor", "legal", "architect", "recruit", "advisor", "adviser", "freelance", "studio"],
    needs: ["more-customers", "get-paid", "less-admin"], apps: ["xero", "quickbooks", "stripe", "gocardless", "slack"],
    industry: "Professional services (contracts, client data, any professional body rules)", customers: "Other businesses",
  },
  {
    key: "trades", label: "Trades and construction", examples: "Builder, electrician, plumber, cleaner, landscaper",
    words: ["builder", "building", "construction", "electric", "plumb", "roof", "joiner", "carpent", "landscap", "garden", "cleaning", "cleaner", "decorat", "handyman", "hvac", "heating"],
    needs: ["get-paid", "more-customers", "stay-legal"], apps: ["xero", "quickbooks", "sumup", "gocardless", "slack"],
    industry: "Trades and construction (health and safety, certificates, insurance)", customers: "Homeowners and local businesses",
  },
  {
    key: "health-beauty", label: "Health, beauty and fitness", examples: "Salon, barber, clinic, dentist, gym, therapist",
    words: ["salon", "barber", "beauty", "hair", "nail", "spa", "clinic", "dentist", "dental", "physio", "therap", "gym", "fitness", "yoga", "pilates", "massage", "wellness", "optician", "pharmacy", "vet"],
    needs: ["more-customers", "staff", "stay-legal"], apps: ["square", "sumup", "xero", "brightpay", "slack"],
    industry: "Health, beauty and fitness (client records, hygiene, professional registration)", customers: "Local clients who book appointments",
  },
  {
    key: "tech", label: "Software and tech", examples: "App, SaaS, IT services, startup",
    words: ["saas", "software", "app", "platform", "startup", "start-up", "tech", "developer", "it support", "it services", "ai ", "api", "fintech"],
    needs: ["more-customers", "raise-money", "know-my-numbers"], apps: ["stripe", "xero", "quickbooks", "deel", "slack"],
    industry: "Software and technology (data protection, terms of service)", customers: "Businesses that subscribe online",
  },
  {
    key: "creative", label: "Creative and media", examples: "Designer, photographer, video, events, creator",
    words: ["design", "photo", "video", "film", "music", "creator", "content", "event", "wedding", "print", "illustrat", "podcast", "writer", "artist"],
    needs: ["more-customers", "get-paid", "online-presence"], apps: ["stripe", "paypal", "xero", "freeagent", "slack"],
    industry: "Creative and media (copyright, licences, client contracts)", customers: "Clients who commission work",
  },
  {
    key: "education-care", label: "Education and care", examples: "Tutor, training, nursery, school club, care provider",
    words: ["tutor", "tuition", "training", "course", "school", "nursery", "childcare", "child care", "academy", "coach", "care home", "home care", "daycare"],
    needs: ["stay-legal", "more-customers", "staff"], apps: ["xero", "gocardless", "stripe", "brightpay", "slack"],
    industry: "Education and care (safeguarding, background checks, inspection rules)", customers: "Parents, learners and families",
  },
  {
    key: "property", label: "Property and hospitality", examples: "Lettings, estate agent, hotel, holiday let",
    words: ["property", "estate agent", "real estate", "letting", "landlord", "rental", "hotel", "guest house", "b&b", "airbnb", "holiday let", "hostel"],
    needs: ["more-customers", "know-my-numbers", "stay-legal"], apps: ["xero", "stripe", "gocardless", "quickbooks", "slack"],
    industry: "Property and accommodation (tenancy rules, safety certificates, client money)", customers: "Tenants, buyers and guests",
  },
  {
    key: "making-moving", label: "Making and moving goods", examples: "Manufacturer, wholesaler, importer, courier, farm",
    words: ["manufactur", "factory", "wholesale", "import", "export", "distribut", "warehouse", "logistic", "courier", "haulage", "transport", "delivery", "farm", "brewery", "workshop"],
    needs: ["stock", "know-my-numbers", "cut-costs"], apps: ["xero", "sage", "quickbooks", "stripe", "slack"],
    industry: "Manufacturing, wholesale and transport (product safety, customs, vehicle and driver rules)", customers: "Trade customers and stockists", holdsStock: true,
  },
  {
    key: "charity", label: "Charity or community group", examples: "Charity, club, social enterprise, church",
    words: ["charity", "non-profit", "nonprofit", "not-for-profit", "community", "social enterprise", "foundation", "church", "club", "association", "cic"],
    needs: ["raise-money", "stay-legal", "less-admin"], apps: ["xero", "quickbooks", "stripe", "paypal", "slack"],
    industry: "Charity or community group (charity law, fundraising rules, trustee duties)", customers: "Supporters, members and the people you help",
  },
  {
    key: "other", label: "Something else", examples: "Tell us in a few words",
    words: [],
    needs: ["more-customers", "know-my-numbers", "less-admin"], apps: ["xero", "quickbooks", "stripe", "square", "slack"],
    industry: "", customers: "",
  },
];

export const OTHER_SECTOR = "other";

export function getSector(key: string | undefined): Sector {
  return SECTORS.find((s) => s.key === key) ?? SECTORS.find((s) => s.key === OTHER_SECTOR)!;
}

export function getNeed(key: string): Need | undefined {
  return NEEDS.find((n) => n.key === key);
}

/** Country facts used to prefill, never to decide anything the owner cannot change. */
export interface CountryFacts {
  code: string;
  name: string;
  currency: string;
  /** Month the usual financial year starts, as the setup form spells it. */
  yearStart: string;
}

const EURO = (code: string, name: string): CountryFacts => ({ code, name, currency: "EUR", yearStart: "January" });

export const COUNTRIES: readonly CountryFacts[] = [
  { code: "GB", name: "United Kingdom", currency: "GBP", yearStart: "April" },
  { code: "IE", name: "Ireland", currency: "EUR", yearStart: "January" },
  { code: "US", name: "United States", currency: "USD", yearStart: "January" },
  { code: "CA", name: "Canada", currency: "CAD", yearStart: "January" },
  { code: "AU", name: "Australia", currency: "AUD", yearStart: "July" },
  { code: "NZ", name: "New Zealand", currency: "NZD", yearStart: "April" },
  { code: "IN", name: "India", currency: "INR", yearStart: "April" },
  { code: "PK", name: "Pakistan", currency: "PKR", yearStart: "July" },
  { code: "AE", name: "United Arab Emirates", currency: "AED", yearStart: "January" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", yearStart: "January" },
  { code: "SG", name: "Singapore", currency: "SGD", yearStart: "January" },
  { code: "ZA", name: "South Africa", currency: "ZAR", yearStart: "March" },
  { code: "NG", name: "Nigeria", currency: "NGN", yearStart: "January" },
  { code: "KE", name: "Kenya", currency: "KES", yearStart: "January" },
  EURO("DE", "Germany"), EURO("FR", "France"), EURO("ES", "Spain"), EURO("IT", "Italy"), EURO("NL", "Netherlands"), EURO("PT", "Portugal"), EURO("BE", "Belgium"), EURO("AT", "Austria"),
  { code: "SE", name: "Sweden", currency: "SEK", yearStart: "January" },
  { code: "CH", name: "Switzerland", currency: "CHF", yearStart: "January" },
  { code: "PL", name: "Poland", currency: "PLN", yearStart: "January" },
  { code: "BR", name: "Brazil", currency: "BRL", yearStart: "January" },
  { code: "MX", name: "Mexico", currency: "MXN", yearStart: "January" },
  { code: "JP", name: "Japan", currency: "JPY", yearStart: "April" },
];

export function countryFacts(code: string | undefined): CountryFacts | undefined {
  const c = (code ?? "").trim().toUpperCase();
  return COUNTRIES.find((x) => x.code === c);
}
