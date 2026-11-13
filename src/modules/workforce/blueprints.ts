/**
 * Org blueprints: the departments and roles of a typical company, so a
 * business can see its whole structure and fill it with AI employees.
 *
 * - A role with `jd` is a ready-made employee in the store: it has a full job
 *   description (job-descriptions.ts) and its own template.
 * - Every other role is a *specialist hire* (12 in all, one per department),
 *   each merging several narrower jobs (`covers`). It is trained to the owner's
 *   needs from this blueprint plus the owner's own brief, at a monthly price.
 *   specialistJobDescription() turns the blueprint into a full JD so it works
 *   the same way as a ready-made employee.
 *
 * Pure data, no server imports: the website imports this file too.
 */
import type { JobDescription } from "./job-descriptions.js";

export interface RoleBlueprint {
  key: string;
  title: string;
  /** One sentence: why the role exists. */
  purpose: string;
  duties: readonly string[];
  skills: readonly string[];
  legal: readonly string[];
  records: readonly string[];
  /** Set when a ready-made employee with a full job description exists. */
  jd?: string;
  /** For a specialist hire: the jobs it merges, shown to the owner so they know what they get. */
  covers?: readonly string[];
  /** Model lane a specialist needs. Premium for work where accuracy is critical. */
  tier?: "standard" | "premium";
}

export interface Department {
  key: string;
  name: string;
  /** What the department does for the business, in one line. */
  mission: string;
  roles: readonly RoleBlueprint[];
}

/** How custom specialists are sold. The price itself is set in pricing, not here. */
export const CUSTOM_SPECIALIST = {
  title: "Custom specialist",
  summary:
    "Need a role that is not here? Describe the job. Your Admin manager designs a specialist for it, MAIZ checks the job description and sets the price, and then you decide whether to hire it. Nothing is trained or charged before that.",
  steps: [
    "Pick a role from the blueprint, or describe the one you need",
    "Your Admin manager drafts its job description and asks what it should know about your business",
    "MAIZ reviews the job description and confirms the price per agent",
    "You choose whether to hire it at that price",
    "The specialist is trained and joins your team, with the same approval rules as everyone else",
  ],
} as const;

const r = (b: RoleBlueprint) => b;

export const DEPARTMENTS: readonly Department[] = [
  {
    key: "creative-studio",
    name: "Creative studio",
    mission: "Designs, films, writes and brands everything the business shows the world.",
    roles: [
      r({
        key: "creative-studio", title: "Creative studio",
        purpose: "Designs, films and writes everything the business shows the world: brand, campaigns, video, images, print and copy.",
        covers: ["Creative director", "Campaign producer", "Video and audio producer", "Graphic designer", "Photo and image producer", "Brochure and print designer", "Motion and animation designer", "Copywriter"],
        duties: ["Turn the owner's goal into a creative brief with two or three directions to choose from", "Build the campaign plan: message, audience, channels, assets, dates and budget", "Write scripts, shot lists and captions for short videos", "Draft visuals from briefs", "Produce images from a brief, in every size each channel needs", "Lay out brochures and documents from supplied copy and images", "Storyboard and script short animations", "Write headlines, body copy and calls to action for each asset", "Brief the studio's specialists and review their work against the brand kit", "Coordinate the studio and Marketing so every asset is ready on time"],
        skills: ["Creative direction", "Campaign planning", "Scriptwriting", "Visual design", "Image generation and editing", "Layout and typography", "Storyboarding", "Advertising copywriting"],
        legal: ["Copyright, trademarks and licensing across all media", "Advertising and promotion rules for each channel", "Copyright and licensing of music, footage and images", "Copyright, trademarks and image licences", "Copyright and licences for images, including AI-generated ones", "Mandatory information on printed and packaged materials", "Copyright and licences for music, sound and stock assets", "Advertising standards and consumer protection on claims"],
        records: ["Creative briefs and the direction the owner signed off", "Campaign plan and asset list with owners and dates", "Scripts and shot lists by version", "Brand kit", "Image library with source, licence and usage", "Print-ready files and templates by version", "Storyboards and scripts by version", "Copy decks by version with approvals"],
      }),
    ],
  },
  {
    key: "social-content",
    name: "Social media and content",
    mission: "Keeps the business visible online with posts, articles, search, ads and email.",
    roles: [
      r({ key: "marketing-manager", jd: "marketing-manager", title: "Marketing manager", purpose: "Owns the marketing plan and brand voice.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "social-media-content", title: "Social media and content",
        purpose: "Keeps the business visible online: posts, articles, search, ads, newsletters and CRM follow-up.",
        covers: ["Social media manager", "Content writer", "SEO specialist", "Paid ads specialist", "Email and CRM specialist"],
        duties: ["Plan and draft posts for each platform", "Draft articles and newsletters from the content plan", "Keyword research and content briefs", "Plan campaigns and audiences", "Segment the customer list and keep consent records current", "Draft replies to comments and messages", "Rewrite and update old content", "On-page and technical SEO checks", "Write ad variants for testing", "Plan and draft email journeys: welcome, win-back, renewal"],
        skills: ["Platform know-how", "Long-form writing", "Keyword research", "Search and social ads", "CRM hygiene and segmentation", "Short-form copy", "Editing", "Technical SEO"],
        legal: ["Influencer and ad disclosure rules", "Copyright and quoting rules", "Accessibility law for websites", "Advertising standards and platform ad policies", "Direct marketing consent and unsubscribe rules", "Platform terms and image rights", "Advertising and claims rules", "Cookie and tracking consent"],
        records: ["Post calendar and approvals", "Content library with publish dates", "Keyword map", "Campaign plans and approvals", "Consent and suppression lists", "Disclosure and permission records", "Sources and permissions", "SEO change log"],
      }),
    ],
  },
  {
    key: "pr-comms",
    name: "PR and communications",
    mission: "Looks after press, public statements and the business's reputation.",
    roles: [
      r({
        key: "pr-communications", title: "PR and communications",
        purpose: "Looks after press, announcements and the business's public reputation.",
        covers: ["PR and communications manager"],
        duties: ["Draft press releases, statements and award entries", "Keep a media list and pitch stories for the owner to approve", "Prepare holding statements for complaints or incidents", "Track press and online mentions and draft replies for the owner to approve"],
        skills: ["Press writing", "Media relations", "Reputation and crisis communication", "Message consistency"],
        legal: ["Defamation and advertising standards", "Disclosure rules for endorsements and sponsored content"],
        records: ["Press releases and statements as issued", "Media contact log and coverage record"],
      }),
    ],
  },
  {
    key: "sales-bd",
    name: "Sales and business development",
    mission: "Finds customers, wins deals and builds partnerships.",
    roles: [
      r({
        key: "sales-business-development", title: "Sales and business development",
        purpose: "Finds customers, writes proposals and bids, follows up leads and builds partnerships and online sales.",
        covers: ["Sales manager", "Sales development representative", "Account manager", "Bid and tender writer", "E-commerce manager", "Partnerships manager"],
        duties: ["Set sales targets and plan the pipeline", "Build lead lists from the ideal customer profile", "Plan check-ins and renewals", "Find suitable tenders", "Keep product listings, photos briefs and prices accurate across shop and marketplaces", "Research and shortlist partners that fit the business", "Draft proposals, quotes and follow-ups", "Draft personalised outreach for approval", "Spot upsell and cross-sell chances", "Plan and draft bid responses"],
        skills: ["Pipeline management", "Lead research", "Relationship management", "Persuasive writing", "Online merchandising", "Partner research", "Sales forecasting", "Cold outreach writing"],
        legal: ["Consumer and distance-selling rules", "Rules on unsolicited email, calls and messages (for example GDPR, PECR, CAN-SPAM)", "Contract renewal and cancellation terms", "Public procurement rules", "Consumer rights for distance selling, returns and refunds", "Agency, reseller and affiliate contract terms", "Contract terms and quotes", "Data protection for prospect data"],
        records: ["Pipeline and CRM notes", "Lead source and lawful-basis notes", "Account plans", "Bid library and submitted bids", "Product catalogue with prices and change history", "Partner register with terms and renewal dates", "Quotes, proposals and signed terms", "Outreach and opt-out log"],
      }),
    ],
  },
  {
    key: "customer",
    name: "Customer service and reception",
    mission: "Answers customers and callers quickly, greets visitors and keeps people coming back.",
    roles: [
      r({
        key: "customer-service-reception", title: "Customer service and reception",
        purpose: "Answers calls, enquiries, chats and complaints, keeps bookings in order and greets visitors.",
        covers: ["Receptionist", "Customer support agent", "Customer success manager", "Bookings and appointments coordinator", "Community and reviews manager"],
        duties: ["Answer phone, email and web enquiries and route them to the right person", "Draft answers to emails and chats", "Plan onboarding for new customers", "Answer booking requests and confirm appointments from the calendar", "Draft replies to reviews and comments for approval", "Take messages and callback requests and make sure they are followed up", "Keep the help articles up to date", "Track health scores and risks", "Send reminders and manage cancellations, no-shows and the waiting list", "Flag complaints and risks to Customer support the same day"],
        skills: ["Warm, clear communication", "Clear, kind writing", "Onboarding design", "Diary management", "Community moderation", "Call and enquiry handling", "Product knowledge", "Retention analysis"],
        legal: ["Data protection for callers, visitors and messages", "Consumer rights on refunds, returns and cancellations", "Rules on collecting and publishing reviews", "Consumer rules on deposits, cancellations and refunds", "Consumer law on fake or incentivised reviews", "Call recording and consent rules", "Complaint-handling rules in regulated sectors", "Data protection"],
        records: ["Enquiry and message log with outcomes", "Ticket history", "Customer health records", "Booking log with changes and cancellations", "Log of reviews, replies and outcomes", "Visitor and callback register", "Complaints log with outcomes", "Feedback and review log"],
      }),
    ],
  },
  {
    key: "executive-office",
    name: "Executive and office support",
    mission: "Keeps the owner, the office and the people paperwork organised.",
    roles: [
      r({ key: "admin-manager", jd: "admin-manager", title: "Admin manager", purpose: "Runs the AI team for the owner like a chief of staff.", duties: [], skills: [], legal: [], records: [] }),
      r({ key: "hr-manager", jd: "hr-manager", title: "HR manager", purpose: "Hiring, onboarding and people.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "executive-office-support", title: "Executive and office support",
        purpose: "Runs the owner's diary, inbox and travel, keeps the office running and handles hiring and staff admin.",
        covers: ["Executive assistant", "Office manager", "Recruiter", "Learning and development coordinator", "HR administrator"],
        duties: ["Draft replies and triage the inbox into act, delegate and file", "Manage office suppliers, leases and services", "Write and post job ads", "Run training-needs analysis", "Keep staff files, contracts and right-to-work checks complete", "Plan meetings, agendas and minutes", "Keep asset and equipment lists", "Screen applications against the scorecard", "Plan and schedule training", "Track holidays, sickness and probation dates and remind managers"],
        skills: ["Diary and inbox management", "Facilities coordination", "Sourcing", "Training needs analysis", "HR record-keeping", "Minute-taking", "Supplier management", "Structured screening"],
        legal: ["Data protection for contacts and correspondence", "Workplace health and safety basics", "Equality law in hiring", "Mandatory training rules (for example health and safety, food hygiene)", "Employment record and right-to-work requirements", "Confidentiality duties", "Lease and service contract terms", "Right-to-work checks"],
        records: ["Meeting minutes and action logs", "Asset and equipment register", "Applications and screening notes", "Skills matrix", "Staff files with contract and check dates", "Contact list with consent where required", "Lease, insurance and service contracts with renewal dates", "Interview scorecards and decisions"],
      }),
    ],
  },
  {
    key: "wealth-savings",
    name: "Wealth and savings",
    mission: "Helps the owner plan and track investments, savings and cash. Planning and tracking help, not regulated financial advice.",
    roles: [
      r({ key: "finance-manager", jd: "finance-manager", title: "Finance manager", purpose: "Owns the books and cash.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "wealth-savings", title: "Wealth and savings", tier: "premium",
        purpose: "Helps the owner plan and track investments, savings, cash, books, payroll and money owed. This is planning and tracking help, not regulated financial advice.",
        covers: ["Investment manager", "Savings and treasury manager", "Personal finance manager", "Bookkeeper", "Payroll specialist", "Credit controller", "Management accountant"],
        duties: ["Keep a clear view of all investments, returns, fees and risk in one place", "Forecast cash and set reserve targets for tax, payroll and slow months", "Build the owner's personal budget and savings goals from what the business pays out", "Enter and categorise transactions daily", "Prepare payroll from hours, salaries and changes", "Track who owes what and how overdue it is", "Produce monthly management accounts with commentary", "Prepare plain-English options and trade-offs for the owner to discuss with a licensed adviser", "Track savings accounts, rates, notice periods and deposit-protection limits", "Track owner pay, dividends and personal tax set-asides"],
        skills: ["Portfolio tracking", "Cash forecasting", "Personal budgeting", "Double-entry bookkeeping", "Payroll calculation", "Receivables management", "Management accounting", "Risk and return basics"],
        legal: ["Not regulated financial advice: the owner decides, with a licensed adviser where needed", "Record-keeping and retention rules of the owner's country", "Payroll tax, social security and pension rules", "Late-payment and debt-collection rules", "Record-keeping law for accounting records", "Financial promotion and investment rules of the owner's country"],
        records: ["Investment register with values and dates", "Cash reserve plan with targets", "Personal budget and goals tracker", "Journals and source documents", "Payroll registers and pay slips", "Aged debtors report", "Monthly management accounts pack", "Options papers and the decisions taken"],
      }),
    ],
  },
  {
    key: "fundraising",
    name: "Fundraising and investor relations",
    mission: "Prepares the business to raise money and keeps lenders, investors and grant bodies informed.",
    roles: [
      r({
        key: "fundraising-investor-relations", title: "Fundraising and investor relations", tier: "premium",
        purpose: "Prepares the business to raise money: forecasts, investor and lender packs, grants and updates.",
        covers: ["Fundraising and investor relations manager", "Financial analyst"],
        duties: ["Keep an investor and lender pipeline with next steps", "Build forecasts and scenario models", "Maintain the data room and answer due-diligence questions from the records", "Analyse margins, pricing and unit economics"],
        skills: ["Funding options for small businesses", "Financial modelling", "Financial storytelling", "Forecasting"],
        legal: ["Financial promotion and investor communication rules", "Rules on financial promotions when raising money", "Confidentiality and non-disclosure terms", "Confidentiality of financial information"],
        records: ["Data room index with document versions", "Model versions with assumptions", "Log of investor, lender and grant contacts and what was shared", "Investor and lender reporting packs"],
      }),
    ],
  },
  {
    key: "legal-contracts",
    name: "Legal and contracts",
    mission: "Keeps contracts, licences, data protection, safety and insurance in order.",
    roles: [
      r({ key: "compliance-manager", jd: "compliance-manager", title: "Compliance manager", purpose: "Keeps the business on the right side of the rules.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "legal-contracts", title: "Legal and contracts", tier: "premium",
        purpose: "Keeps contracts, policies, licences, data protection, health and safety and insurance in order.",
        covers: ["Contract manager", "Data protection lead", "Health and safety officer", "Licences and permits officer", "Risk and insurance coordinator"],
        duties: ["Keep a contract register with key terms and dates", "Keep the record of processing activities", "Draft risk assessments", "List the licences and permits the business needs, with the issuing body", "Keep a risk register with owners, likelihood and impact", "Compare drafts against the business's standard terms and flag risks", "Draft privacy notices and impact assessments", "Plan inspections, drills and training", "Prepare applications and renewals for the owner to sign and submit", "Compare cover against the risks and list gaps for the broker"],
        skills: ["Contract review", "Data protection law", "Risk assessment", "Regulatory research with dated sources", "Risk spotting", "Safety planning", "Application drafting", "Insurance cover basics"],
        legal: ["Contract law basics of the owner's country", "GDPR-style data protection law and breach reporting deadlines", "Workplace health and safety law", "Licensing law for the business's sector and location", "Compulsory insurance for the business's country and sector", "When a lawyer must review", "International data transfer rules", "Accident reporting duties"],
        records: ["Contract register", "Record of processing activities", "Risk assessments", "Licence and permit register with expiry dates", "Risk register with review dates", "Signed contracts and amendments", "Breach log and data-subject request log", "Accident book and inspection records"],
      }),
    ],
  },
  {
    key: "operations-logistics",
    name: "Operations and logistics",
    mission: "Runs projects and processes and moves goods: supply chain, procurement, shipping and shifts.",
    roles: [
      r({ key: "business-consultant", jd: "business-consultant", title: "Business consultant", purpose: "Finds waste and recommends the best-value decisions.", duties: [], skills: [], legal: [], records: [] }),
      r({ key: "supply-chain-manager", jd: "supply-chain-manager", title: "Supply chain and inventory manager", purpose: "Stock, suppliers and shipments.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "operations-logistics", title: "Operations and logistics", tier: "premium",
        purpose: "Runs projects, processes, quality and shifts, and manages suppliers, purchasing, stock and shipping.",
        covers: ["Operations manager", "Project manager", "Quality manager", "Process and knowledge writer", "Sustainability officer", "Rota and shift coordinator", "Supply chain and inventory manager", "Procurement specialist", "Logistics coordinator", "Import and export coordinator"],
        duties: ["Plan capacity and schedules", "Plan scope, timeline and budget", "Set quality checks and standards", "Interview the owner and team and write step-by-step procedures", "Estimate energy, waste and carbon from bills and purchase records", "Draft weekly rotas from availability, skills and expected demand", "Run quotes and tenders with suppliers", "Book and track shipments", "Prepare commercial invoices, packing lists and customs information for the broker", "Write and keep SOPs"],
        skills: ["Process management", "Planning", "Quality systems", "Process mapping", "Carbon accounting basics", "Shift planning", "Sourcing", "Carrier management"],
        legal: ["Health and safety duties", "Contract scope and change control", "Product and service standards for the sector", "Document control requirements of any standard the business follows", "Green claims and anti-greenwashing rules", "Working-time, rest break and young-worker rules", "Anti-bribery and conflict-of-interest rules", "Customs and export rules"],
        records: ["SOP library", "Project plans and change log", "Quality checks and non-conformance log", "Procedure library with owners and review dates", "Footprint calculations with sources", "Published rotas with changes", "Quotes and award decisions", "Shipping documents and customs declarations"],
      }),
    ],
  },
  {
    key: "technology",
    name: "Technology and data",
    mission: "Builds and secures the business's software, systems and data.",
    roles: [
      r({
        key: "technology-data", title: "Technology and data", tier: "premium",
        purpose: "Looks after software, IT, security, data, dashboards, automation and the website.",
        covers: ["Software engineer", "IT support specialist", "Data analyst", "Cybersecurity officer", "AI and automation specialist", "UX and web designer"],
        duties: ["Build automations and small apps from a brief", "Guide staff through set-up and problems", "Clean and combine data", "Run security checklists and phishing awareness", "Map repeated tasks and estimate the time each automation would save", "Review the site or app for usability and accessibility problems", "Fix bugs and keep code tested", "Keep an asset and licence list", "Build reports and dashboards", "Keep access reviews and password policy"],
        skills: ["Programming", "Troubleshooting", "Data analysis", "Security frameworks", "Workflow analysis", "User-centred design", "Testing", "Account management"],
        legal: ["Software licences of the code used", "Software licence terms", "Data protection and minimisation", "Breach notification duties", "Data protection when moving data between tools", "Accessibility law that applies to the business", "Data protection by design", "Security duties for personal data"],
        records: ["Code repository and change history", "IT asset and licence register", "Data dictionary", "Security policy and access reviews", "Automation register with owner, purpose and off-switch", "Design files and decisions by version", "Technical documentation", "Backup and incident log"],
      }),
    ],
  },
  {
    key: "product-research",
    name: "Product and research",
    mission: "Decides what to build and sell, using research, markets and pricing.",
    roles: [
      r({
        key: "product-research", title: "Product and research",
        purpose: "Researches markets, competitors and prices and plans what to build and sell next.",
        covers: ["Product manager", "Researcher", "Market analyst", "Pricing analyst"],
        duties: ["Gather customer needs and feedback", "Research questions from the team", "Market sizing and segmentation", "Build a price and margin model for each product or service", "Write product briefs and roadmaps", "Summarise findings with sources", "Competitor tracking", "Track competitor prices from public sources"],
        skills: ["Customer discovery", "Desk research", "Market research", "Pricing models", "Prioritisation", "Source evaluation", "Competitive analysis", "Margin analysis"],
        legal: ["Product safety and labelling where physical", "Copyright and fair use of sources", "Competition law on sharing information", "Competition law: no price-fixing or sharing prices with competitors", "Accessibility and consumer rules for digital products", "Data protection when research involves people", "Copyright of reports used", "Price display and promotion rules"],
        records: ["Roadmap and decision log", "Research notes with sources and dates", "Market models with sources", "Price list with change history and reasons", "Product briefs and launch notes", "Research library", "Competitor tracking log", "Price test results"],
      }),
    ],
  },
];

/**
 * The 12 specialist hires: one per department, each merging the narrower roles that used to be
 * sold one by one. Package employees stay in their department but are not specialist hires.
 */
export function specialistHires(): { department: Department; role: RoleBlueprint }[] {
  return DEPARTMENTS.flatMap((department) => department.roles.filter((role) => role.covers).map((role) => ({ department, role })));
}

/** Old one-job specialist keys, mapped to the specialist hire that now does that work. */
export const LEGACY_SPECIALIST_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["creative-director", "campaign-producer", "video-content-producer", "graphic-designer", "image-producer", "print-designer", "motion-designer", "copywriter"].map((k) => [k, "creative-studio"])),
  ...Object.fromEntries(["social-media-manager", "content-writer", "seo-specialist", "ads-specialist", "email-crm-specialist"].map((k) => [k, "social-media-content"])),
  ...Object.fromEntries(["pr-communications-manager"].map((k) => [k, "pr-communications"])),
  ...Object.fromEntries(["sales-manager", "sales-development-rep", "account-manager", "bid-writer", "ecommerce-manager", "partnerships-manager"].map((k) => [k, "sales-business-development"])),
  ...Object.fromEntries(["receptionist", "customer-support-agent", "customer-success-manager", "bookings-coordinator", "community-manager"].map((k) => [k, "customer-service-reception"])),
  ...Object.fromEntries(["executive-assistant", "office-manager", "recruiter", "learning-development", "hr-administrator"].map((k) => [k, "executive-office-support"])),
  ...Object.fromEntries(["investment-manager", "savings-treasury-manager", "personal-finance-manager", "bookkeeper", "payroll-specialist", "credit-controller", "management-accountant"].map((k) => [k, "wealth-savings"])),
  ...Object.fromEntries(["fundraising-manager", "financial-analyst"].map((k) => [k, "fundraising-investor-relations"])),
  ...Object.fromEntries(["contract-manager", "data-protection-officer", "health-safety-officer", "licensing-officer", "risk-insurance-coordinator"].map((k) => [k, "legal-contracts"])),
  ...Object.fromEntries(["operations-manager", "project-manager", "quality-manager", "process-documentation-writer", "sustainability-officer", "rota-coordinator", "procurement-specialist", "logistics-coordinator", "import-export-coordinator"].map((k) => [k, "operations-logistics"])),
  ...Object.fromEntries(["software-engineer", "it-support", "data-analyst", "security-officer", "ai-automation-specialist", "ux-designer"].map((k) => [k, "technology-data"])),
  ...Object.fromEntries(["product-manager", "researcher", "market-analyst", "pricing-analyst"].map((k) => [k, "product-research"])),
};

export function allRoles(): RoleBlueprint[] {
  return DEPARTMENTS.flatMap((d) => [...d.roles]);
}

export function getBlueprint(key: string): { department: Department; role: RoleBlueprint } | undefined {
  const resolved = LEGACY_SPECIALIST_KEYS[key] ?? key;
  for (const department of DEPARTMENTS) {
    const role = department.roles.find((x) => x.key === resolved);
    if (role) return { department, role };
  }
  return undefined;
}

/** A full job description for a custom specialist, built from its blueprint. */
export function specialistJobDescription(key: string): JobDescription | undefined {
  const b = getBlueprint(key);
  if (!b || b.role.jd) return undefined;
  return jobDescriptionFromRole(b.role, b.department.name);
}

/**
 * Turns any role blueprint into a full job description. Used for blueprint specialists and for
 * new roles the Admin manager designs (custom-roles.ts), so every specialist works to the same
 * structure and the same limits on what it may do.
 */
export function jobDescriptionFromRole(role: RoleBlueprint, departmentName: string): JobDescription {
  const department = { name: departmentName };
  return {
    key: role.key,
    jobTitle: role.title,
    department: department.name,
    reportsTo: "Owner",
    worksWith: ["Admin manager (routing, training and check-ins)", "Any teammate whose job description covers related work"],
    purpose: `${role.purpose} Trained as a custom specialist for this business from the role blueprint and the owner's brief.`,
    responsibilities: [
      { area: "Core duties", duties: role.duties },
      { area: "Documentation and legal records", duties: ["Keep every document and record listed below complete and up to date", "Know the legal requirements of the job and say when a rule must be confirmed for the owner's country"] },
    ],
    legal: role.legal,
    records: role.records,
    competencies: role.skills.map((skill) => ({ skill, level: "Advanced" as const, detail: "Applied to the owner's business and checked by the owner." })),
    knowledge: [`Good practice for the ${role.title} role`, "The business profile and the owner's training notes"],
    tools: [{ name: "Business profile and setup answers", status: "available" }],
    deliverables: role.duties.map((d) => ({ name: d, cadence: "As agreed with the owner", energy: role.tier === "premium" ? ([15, 45] as const) : ([5, 20] as const) })),
    kpis: ["Work accepted by the owner first time", "Required records always complete and up to date", "Deadlines agreed with the owner met"],
    authority: {
      autonomous: ["Draft work within this role", "Keep this role's records up to date"],
      needsApproval: ["Send, publish, submit or share anything outside the workspace", "Contact anyone outside the business"],
      never: ["Spend or move money", "Sign or submit anything", "Give legal, tax or medical advice", "Invent facts, figures or rules"],
    },
    escalate: ["Anything with legal, tax, safety or financial risk: tell the owner and recommend a qualified professional"],
    handover: ["A short brief of what you need this role to do", "Any documents, templates or examples you already use", "Who in your team it works with"],
  };
}
