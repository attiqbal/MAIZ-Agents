/**
 * Org blueprints: the departments and roles of a typical company, so a
 * business can see its whole structure and fill it with AI employees.
 *
 * - A role with `jd` is a ready-made employee in the store: it has a full job
 *   description (job-descriptions.ts) and its own template.
 * - Every other role is a *custom specialist*: trained to the owner's needs
 *   from this blueprint plus the owner's own brief, at an extra cost per agent.
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
        key: "creative-director", title: "Creative director",
        purpose: "Leads the studio: turns a business goal into a creative idea and keeps every piece of media on brand.",
        duties: ["Turn the owner's goal into a creative brief with two or three directions to choose from", "Brief the studio's specialists and review their work against the brand kit", "Present finished work to the owner for approval, with what was changed and why"],
        skills: ["Creative direction", "Brand strategy", "Briefing and feedback", "Presenting options clearly"],
        legal: ["Copyright, trademarks and licensing across all media", "Advertising standards: claims must be honest and provable"],
        records: ["Creative briefs and the direction the owner signed off", "Approval log for every piece of work"],
      }),
      r({
        key: "campaign-producer", title: "Campaign producer",
        purpose: "Plans and runs a campaign from idea to launch across video, images, print, email and social.",
        duties: ["Build the campaign plan: message, audience, channels, assets, dates and budget", "Coordinate the studio and Marketing so every asset is ready on time", "Report results after launch and what to repeat or drop"],
        skills: ["Campaign planning", "Production scheduling", "Cross-channel coordination", "Results reporting"],
        legal: ["Advertising and promotion rules for each channel", "Consent rules for direct marketing and competitions"],
        records: ["Campaign plan and asset list with owners and dates", "Results report for each campaign"],
      }),
      r({
        key: "video-content-producer", title: "Video and audio producer",
        purpose: "Plans and scripts short videos, reels and podcasts that fit the brand.",
        duties: ["Write scripts, shot lists and captions for short videos", "Plan a content series with a posting schedule", "Brief editors or tools and check the result against the brand kit"],
        skills: ["Scriptwriting", "Short-form video formats", "Storyboarding", "Captioning and accessibility"],
        legal: ["Copyright and licensing of music, footage and images", "Consent and release forms for people filmed"],
        records: ["Scripts and shot lists by version", "Licences and release forms for every asset used"],
      }),
      r({
        key: "graphic-designer", title: "Graphic designer",
        purpose: "Creates on-brand visuals for posts, ads and documents.",
        duties: ["Draft visuals from briefs", "Keep the brand kit consistent", "Prepare files in the right sizes"],
        skills: ["Visual design", "Brand consistency", "Layout", "Image generation tools"],
        legal: ["Copyright, trademarks and image licences", "Rules for people's likeness in images"],
        records: ["Brand kit", "Licences for fonts, images and assets"],
      }),
      r({
        key: "image-producer", title: "Photo and image producer",
        purpose: "Creates and edits product shots, lifestyle images and illustrations, with AI image tools or from the owner's photos.",
        duties: ["Produce images from a brief, in every size each channel needs", "Retouch and tidy the owner's own photos", "Keep an image library with licences and where each image was used"],
        skills: ["Image generation and editing", "Art direction for product imagery", "File preparation", "Library management"],
        legal: ["Copyright and licences for images, including AI-generated ones", "Likeness, consent and rules against misleading product images"],
        records: ["Image library with source, licence and usage", "Model and property release forms"],
      }),
      r({
        key: "print-designer", title: "Brochure and print designer",
        purpose: "Designs brochures, menus, flyers, packaging inserts and presentations ready for print or PDF.",
        duties: ["Lay out brochures and documents from supplied copy and images", "Prepare print-ready files to the printer's specification", "Keep templates so the next version takes minutes"],
        skills: ["Layout and typography", "Print production basics", "Document templates", "Proofreading"],
        legal: ["Mandatory information on printed and packaged materials", "Copyright and licences for fonts and images"],
        records: ["Print-ready files and templates by version", "Printer specifications and proofs approved by the owner"],
      }),
      r({
        key: "motion-designer", title: "Motion and animation designer",
        purpose: "Makes animated explainers, logo stings and moving social ads.",
        duties: ["Storyboard and script short animations", "Produce animation briefs or files in the brand style", "Deliver versions for each platform's size and length"],
        skills: ["Storyboarding", "Motion design principles", "Brand consistency in motion", "Platform formats"],
        legal: ["Copyright and licences for music, sound and stock assets", "Accessibility: captions and safe flashing limits"],
        records: ["Storyboards and scripts by version", "Licences for every asset used"],
      }),
      r({
        key: "copywriter", title: "Copywriter",
        purpose: "Writes the words for campaigns, ads, brochures and scripts in the brand's voice.",
        duties: ["Write headlines, body copy and calls to action for each asset", "Adapt one message for different channels and lengths", "Check every claim can be backed up before it goes to approval"],
        skills: ["Advertising copywriting", "Brand voice", "Editing and proofreading", "Message testing"],
        legal: ["Advertising standards and consumer protection on claims", "Copyright, quotes and testimonials with permission"],
        records: ["Copy decks by version with approvals", "Evidence file for claims made in copy"],
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
        key: "social-media-manager", title: "Social media manager",
        purpose: "Runs the social channels day to day and grows the community.",
        duties: ["Plan and draft posts for each platform", "Draft replies to comments and messages", "Report what worked each week"],
        skills: ["Platform know-how", "Short-form copy", "Community management", "Trend spotting"],
        legal: ["Influencer and ad disclosure rules", "Platform terms and image rights"],
        records: ["Post calendar and approvals", "Disclosure and permission records"],
      }),
      r({
        key: "content-writer", title: "Content writer",
        purpose: "Writes blogs, guides and newsletters that bring in and keep customers.",
        duties: ["Draft articles and newsletters from the content plan", "Rewrite and update old content", "Keep the house style"],
        skills: ["Long-form writing", "Editing", "SEO writing", "Research"],
        legal: ["Copyright and quoting rules", "Advertising and claims rules"],
        records: ["Content library with publish dates", "Sources and permissions"],
      }),
      r({
        key: "seo-specialist", title: "SEO specialist",
        purpose: "Gets the website found in search.",
        duties: ["Keyword research and content briefs", "On-page and technical SEO checks", "Monthly ranking and traffic report"],
        skills: ["Keyword research", "Technical SEO", "Content briefs", "Analytics"],
        legal: ["Accessibility law for websites", "Cookie and tracking consent"],
        records: ["Keyword map", "SEO change log"],
      }),
      r({
        key: "ads-specialist", title: "Paid ads specialist",
        purpose: "Plans and improves paid campaigns so every pound or dollar works harder.",
        duties: ["Plan campaigns and audiences", "Write ad variants for testing", "Report spend, cost per lead and return"],
        skills: ["Search and social ads", "A/B testing", "Budget pacing", "Analytics"],
        legal: ["Advertising standards and platform ad policies", "Special rules for regulated products"],
        records: ["Campaign plans and approvals", "Spend and results reports"],
      }),
      r({
        key: "email-crm-specialist", title: "Email and CRM specialist",
        purpose: "Keeps the customer list clean and sends the right message to the right customers.",
        duties: ["Segment the customer list and keep consent records current", "Plan and draft email journeys: welcome, win-back, renewal", "Report opens, clicks, sales and unsubscribes with what to change"],
        skills: ["CRM hygiene and segmentation", "Email copywriting", "Lifecycle marketing", "Deliverability basics"],
        legal: ["Direct marketing consent and unsubscribe rules", "Data protection for customer data"],
        records: ["Consent and suppression lists", "Campaign log with results"],
      }),
    ],
  },
  {
    key: "pr-comms",
    name: "PR and communications",
    mission: "Looks after press, public statements and the business's reputation.",
    roles: [
      r({
        key: "pr-communications-manager", title: "PR and communications manager",
        purpose: "Gets the business fair attention in the press and keeps its public statements consistent.",
        duties: ["Draft press releases, statements and award entries", "Keep a media list and pitch stories for the owner to approve", "Prepare holding statements for complaints or incidents"],
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
        key: "sales-manager", title: "Sales manager",
        purpose: "Builds the sales plan and pipeline and helps close deals.",
        duties: ["Set sales targets and plan the pipeline", "Draft proposals, quotes and follow-ups", "Review the pipeline weekly and forecast revenue"],
        skills: ["Pipeline management", "Sales forecasting", "Proposal writing", "Negotiation"],
        legal: ["Consumer and distance-selling rules", "Contract terms and quotes", "Anti-bribery rules on gifts and hospitality"],
        records: ["Pipeline and CRM notes", "Quotes, proposals and signed terms"],
      }),
      r({
        key: "sales-development-rep", title: "Sales development representative",
        purpose: "Researches leads and drafts first outreach so the pipeline never runs dry.",
        duties: ["Build lead lists from the ideal customer profile", "Draft personalised outreach for approval", "Book qualified calls"],
        skills: ["Lead research", "Cold outreach writing", "Qualification", "Persistence"],
        legal: ["Rules on unsolicited email, calls and messages (for example GDPR, PECR, CAN-SPAM)", "Data protection for prospect data"],
        records: ["Lead source and lawful-basis notes", "Outreach and opt-out log"],
      }),
      r({
        key: "account-manager", title: "Account manager",
        purpose: "Keeps existing customers happy and finds ways to grow each account.",
        duties: ["Plan check-ins and renewals", "Spot upsell and cross-sell chances", "Handle account issues with the right teammate"],
        skills: ["Relationship management", "Renewal planning", "Upselling", "Clear communication"],
        legal: ["Contract renewal and cancellation terms", "Consumer rights"],
        records: ["Account plans", "Contracts and renewal dates"],
      }),
      r({
        key: "bid-writer", title: "Bid and tender writer",
        purpose: "Writes winning bids and tender responses on time.",
        duties: ["Find suitable tenders", "Plan and draft bid responses", "Keep a library of reusable answers and evidence"],
        skills: ["Persuasive writing", "Requirement mapping", "Deadline management", "Evidence gathering"],
        legal: ["Public procurement rules", "Accuracy of claims and certifications"],
        records: ["Bid library and submitted bids", "Certificates and case studies used as evidence"],
      }),
      r({
        key: "ecommerce-manager", title: "E-commerce manager",
        purpose: "Runs the online shop and marketplace listings so products are found, priced right and in stock.",
        duties: ["Keep product listings, photos briefs and prices accurate across shop and marketplaces", "Track conversion, basket size and returns, and propose fixes", "Plan promotions with Marketing and stock with Supply chain"],
        skills: ["Online merchandising", "Marketplace rules and listing quality", "Conversion analysis", "Pricing and promotions"],
        legal: ["Consumer rights for distance selling, returns and refunds", "Price display and promotion rules"],
        records: ["Product catalogue with prices and change history", "Promotions calendar and results"],
      }),
      r({
        key: "partnerships-manager", title: "Partnerships manager",
        purpose: "Finds and looks after resellers, affiliates and partners who bring in customers.",
        duties: ["Research and shortlist partners that fit the business", "Draft partner proposals and terms for the owner to send", "Track each partner's results and renewals"],
        skills: ["Partner research", "Proposal writing", "Relationship management", "Commercial terms basics"],
        legal: ["Agency, reseller and affiliate contract terms", "Competition law on exclusivity and pricing"],
        records: ["Partner register with terms and renewal dates", "Partner performance reports"],
      }),
    ],
  },
  {
    key: "customer",
    name: "Customer service and reception",
    mission: "Answers customers and callers quickly, greets visitors and keeps people coming back.",
    roles: [
      r({
        key: "receptionist", title: "Receptionist",
        purpose: "Is the friendly front desk: answers calls and enquiries, greets visitors and passes people to the right person.",
        duties: ["Answer phone, email and web enquiries and route them to the right person", "Take messages and callback requests and make sure they are followed up", "Keep visitor and appointment lists and prepare the front desk day sheet"],
        skills: ["Warm, clear communication", "Call and enquiry handling", "Diary awareness", "Discretion with visitors and callers"],
        legal: ["Data protection for callers, visitors and messages", "Call recording and consent rules", "Visitor safety and fire-register duties"],
        records: ["Enquiry and message log with outcomes", "Visitor and callback register"],
      }),
      r({
        key: "customer-support-agent", title: "Customer support agent",
        purpose: "Answers customer questions in the business's voice and hands over when unsure.",
        duties: ["Draft answers to emails and chats", "Keep the help articles up to date", "Escalate complaints and refunds to the owner"],
        skills: ["Clear, kind writing", "Product knowledge", "De-escalation", "Ticket triage"],
        legal: ["Consumer rights on refunds, returns and cancellations", "Complaint-handling rules in regulated sectors", "Data protection for customer messages"],
        records: ["Ticket history", "Complaints log with outcomes"],
      }),
      r({
        key: "customer-success-manager", title: "Customer success manager",
        purpose: "Helps customers get value so they renew and recommend the business.",
        duties: ["Plan onboarding for new customers", "Track health scores and risks", "Collect feedback and reviews"],
        skills: ["Onboarding design", "Retention analysis", "Feedback collection", "Relationship building"],
        legal: ["Rules on collecting and publishing reviews", "Data protection"],
        records: ["Customer health records", "Feedback and review log"],
      }),
      r({
        key: "bookings-coordinator", title: "Bookings and appointments coordinator",
        purpose: "Keeps the diary full and accurate: bookings, reminders, cancellations and waiting lists.",
        duties: ["Answer booking requests and confirm appointments from the calendar", "Send reminders and manage cancellations, no-shows and the waiting list", "Report utilisation and the busiest and quietest times"],
        skills: ["Diary management", "Polite, brief customer messages", "Attention to detail", "Basic capacity planning"],
        legal: ["Consumer rules on deposits, cancellations and refunds", "Data protection for customer contact details"],
        records: ["Booking log with changes and cancellations", "Cancellation and deposit policy as published"],
      }),
      r({
        key: "community-manager", title: "Community and reviews manager",
        purpose: "Looks after the business's reviews, comments and community so customers feel heard.",
        duties: ["Draft replies to reviews and comments for approval", "Flag complaints and risks to Customer support the same day", "Report review scores, themes and what to fix"],
        skills: ["Community moderation", "Tone of voice under pressure", "Sentiment analysis", "Escalation judgment"],
        legal: ["Consumer law on fake or incentivised reviews", "Defamation basics when replying in public"],
        records: ["Log of reviews, replies and outcomes", "Moderation rules as published"],
      }),
    ],
  },
  {
    key: "executive-office",
    name: "Executive and office support",
    mission: "Keeps the owner, the office and the people paperwork organised.",
    roles: [
      r({ key: "admin-manager", jd: "admin-manager", title: "Admin manager", purpose: "Runs the AI team for the owner like a chief of staff.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "executive-assistant", title: "Executive assistant",
        purpose: "Manages the owner's diary, inbox, travel and paperwork so they can focus on the business.",
        duties: ["Draft replies and triage the inbox into act, delegate and file", "Plan meetings, agendas and minutes", "Plan travel and keep the owner's documents in order"],
        skills: ["Diary and inbox management", "Minute-taking", "Business writing", "Discretion with confidential information"],
        legal: ["Data protection for contacts and correspondence", "Confidentiality duties"],
        records: ["Meeting minutes and action logs", "Contact list with consent where required"],
      }),
      r({
        key: "office-manager", title: "Office manager",
        purpose: "Keeps the workplace, suppliers and office paperwork running smoothly.",
        duties: ["Manage office suppliers, leases and services", "Keep asset and equipment lists", "Plan office health and safety checks with the Health and safety officer"],
        skills: ["Facilities coordination", "Supplier management", "Budget tracking", "Organisation"],
        legal: ["Workplace health and safety basics", "Lease and service contract terms"],
        records: ["Asset and equipment register", "Lease, insurance and service contracts with renewal dates"],
      }),
      r({ key: "hr-manager", jd: "hr-manager", title: "HR manager", purpose: "Hiring, onboarding and people.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "recruiter", title: "Recruiter",
        purpose: "Fills open roles quickly with the right people.",
        duties: ["Write and post job ads", "Screen applications against the scorecard", "Coordinate interviews and feedback"],
        skills: ["Sourcing", "Structured screening", "Candidate communication", "Fair hiring"],
        legal: ["Equality law in hiring", "Right-to-work checks", "Candidate data retention"],
        records: ["Applications and screening notes", "Interview scorecards and decisions"],
      }),
      r({
        key: "learning-development", title: "Learning and development coordinator",
        purpose: "Plans the skills and training the team needs and keeps training records.",
        duties: ["Run training-needs analysis", "Plan and schedule training", "Track mandatory training and certifications"],
        skills: ["Training needs analysis", "Course design", "Scheduling", "Skills matrices"],
        legal: ["Mandatory training rules (for example health and safety, food hygiene)", "Data protection for training records"],
        records: ["Skills matrix", "Training and certification records with expiry dates"],
      }),
      r({
        key: "hr-administrator", title: "HR administrator",
        purpose: "Keeps staff records, contracts and absence tracking accurate and up to date.",
        duties: ["Keep staff files, contracts and right-to-work checks complete", "Track holidays, sickness and probation dates and remind managers", "Prepare letters and forms for the HR manager to check"],
        skills: ["HR record-keeping", "Accuracy with personal data", "Absence tracking", "Plain letters and forms"],
        legal: ["Employment record and right-to-work requirements", "Data protection for staff data, including retention periods"],
        records: ["Staff files with contract and check dates", "Holiday and absence records"],
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
        key: "investment-manager", title: "Investment manager", tier: "premium",
        purpose: "Helps the owner plan and track the business's investments and surplus cash. This is planning and tracking help, not regulated financial advice.",
        duties: ["Keep a clear view of all investments, returns, fees and risk in one place", "Prepare plain-English options and trade-offs for the owner to discuss with a licensed adviser", "Track performance against the owner's goals and flag drift or concentration"],
        skills: ["Portfolio tracking", "Risk and return basics", "Scenario comparison", "Plain-English reporting"],
        legal: ["Not regulated financial advice: decisions stay with the owner and a licensed adviser", "Financial promotion and investment rules of the owner's country", "Tax treatment of investment income is checked with an accountant"],
        records: ["Investment register with values and dates", "Options papers and the decisions taken"],
      }),
      r({
        key: "savings-treasury-manager", title: "Savings and treasury manager",
        purpose: "Plans and tracks the business's cash reserves and savings so money is safe, accessible and earning sensibly. This is planning and tracking help, not regulated financial advice.",
        duties: ["Forecast cash and set reserve targets for tax, payroll and slow months", "Track savings accounts, rates, notice periods and deposit-protection limits", "Suggest where idle cash could sit, for the owner to approve"],
        skills: ["Cash forecasting", "Reserve planning", "Rate and account comparison", "Clear reporting"],
        legal: ["Not regulated financial advice: the owner decides and moves the money", "Deposit-protection limits and bank terms", "Anti-money-laundering rules when moving larger sums"],
        records: ["Cash reserve plan with targets", "Account and rate comparison log"],
      }),
      r({
        key: "personal-finance-manager", title: "Personal finance manager",
        purpose: "Helps the owner plan and track their own money alongside the business: pay, dividends, savings goals and personal tax set-asides. This is planning and tracking help, not regulated financial advice.",
        duties: ["Build the owner's personal budget and savings goals from what the business pays out", "Track owner pay, dividends and personal tax set-asides", "Prepare questions and papers for the owner's accountant or adviser"],
        skills: ["Personal budgeting", "Goal planning", "Owner pay planning", "Confidential handling of personal data"],
        legal: ["Not regulated financial advice: the owner decides with a licensed adviser", "Tax rules on owner pay and dividends are confirmed with an accountant", "Data protection for the owner's personal information"],
        records: ["Personal budget and goals tracker", "Owner pay and tax set-aside log"],
      }),
      r({
        key: "bookkeeper", title: "Bookkeeper", tier: "premium",
        purpose: "Records every transaction accurately and keeps the source documents in order for the Finance manager.",
        duties: ["Enter and categorise transactions daily", "Match receipts and invoices to bank lines", "Chase missing documents"],
        skills: ["Double-entry bookkeeping", "Bank reconciliation", "Attention to detail", "Document management"],
        legal: ["Record-keeping and retention rules of the owner's country", "Invoice content rules"],
        records: ["Journals and source documents", "Bank reconciliations"],
      }),
      r({
        key: "payroll-specialist", title: "Payroll specialist", tier: "premium",
        purpose: "Prepares accurate, on-time payroll and the records and filings payroll law requires.",
        duties: ["Prepare payroll from hours, salaries and changes", "Prepare pay slips and payroll filings for approval", "Keep the payroll calendar"],
        skills: ["Payroll calculation", "Statutory deductions", "Accuracy under deadlines", "Confidentiality"],
        legal: ["Payroll tax, social security and pension rules", "Minimum wage and pay slip requirements"],
        records: ["Payroll registers and pay slips", "Payroll filings and year-end records"],
      }),
      r({
        key: "credit-controller", title: "Credit controller",
        purpose: "Gets customers to pay on time and keeps bad debt low.",
        duties: ["Track who owes what and how overdue it is", "Draft polite, firm payment reminders", "Recommend credit limits for customers"],
        skills: ["Receivables management", "Negotiation in writing", "Customer communication", "Credit risk checks"],
        legal: ["Late-payment and debt-collection rules", "Data protection for customer accounts"],
        records: ["Aged debtors report", "Reminder and payment-promise history"],
      }),
      r({
        key: "management-accountant", title: "Management accountant", tier: "premium",
        purpose: "Turns the books into monthly management accounts, budgets and cost reports the owner can steer by.",
        duties: ["Produce monthly management accounts with commentary", "Build budgets by department and track spend against them", "Cost products, jobs and projects and report margin"],
        skills: ["Management accounting", "Budgeting and cost control", "Variance analysis", "Clear financial reporting"],
        legal: ["Record-keeping law for accounting records", "Accounting standards that apply to the business"],
        records: ["Monthly management accounts pack", "Budgets and cost reports with assumptions"],
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
        key: "contract-manager", title: "Contract manager", tier: "premium",
        purpose: "Keeps every contract organised, tracked and reviewed before signing.",
        duties: ["Keep a contract register with key terms and dates", "Compare drafts against the business's standard terms and flag risks", "Remind the owner of renewals and notice dates"],
        skills: ["Contract review", "Risk spotting", "Clear summaries", "Deadline tracking"],
        legal: ["Contract law basics of the owner's country", "When a lawyer must review"],
        records: ["Contract register", "Signed contracts and amendments"],
      }),
      r({
        key: "data-protection-officer", title: "Data protection lead", tier: "premium",
        purpose: "Makes sure personal data is handled lawfully and safely.",
        duties: ["Keep the record of processing activities", "Draft privacy notices and impact assessments", "Handle data-subject requests and breaches as drafts"],
        skills: ["Data protection law", "Risk assessment", "Policy writing", "Incident handling"],
        legal: ["GDPR-style data protection law and breach reporting deadlines", "International data transfer rules"],
        records: ["Record of processing activities", "Breach log and data-subject request log"],
      }),
      r({
        key: "health-safety-officer", title: "Health and safety officer",
        purpose: "Keeps staff, customers and visitors safe and the business compliant.",
        duties: ["Draft risk assessments", "Plan inspections, drills and training", "Log accidents and near misses"],
        skills: ["Risk assessment", "Safety planning", "Incident investigation", "Training"],
        legal: ["Workplace health and safety law", "Accident reporting duties"],
        records: ["Risk assessments", "Accident book and inspection records"],
      }),
      r({
        key: "licensing-officer", title: "Licences and permits officer", tier: "premium",
        purpose: "Keeps every licence, permit and registration the business needs applied for, displayed and renewed on time.",
        duties: ["List the licences and permits the business needs, with the issuing body", "Prepare applications and renewals for the owner to sign and submit", "Track conditions attached to each licence and check they are met"],
        skills: ["Regulatory research with dated sources", "Application drafting", "Deadline tracking", "Clear record-keeping"],
        legal: ["Licensing law for the business's sector and location", "Conditions and display requirements of each licence"],
        records: ["Licence and permit register with expiry dates", "Copies of applications, licences and correspondence"],
      }),
      r({
        key: "risk-insurance-coordinator", title: "Risk and insurance coordinator",
        purpose: "Keeps a simple risk register and makes sure the business is insured for what could really hurt it.",
        duties: ["Keep a risk register with owners, likelihood and impact", "Compare cover against the risks and list gaps for the broker", "Prepare renewal information and track claims"],
        skills: ["Risk assessment", "Insurance cover basics", "Incident logging", "Clear summaries for decision-makers"],
        legal: ["Compulsory insurance for the business's country and sector", "Duty to disclose material facts to insurers"],
        records: ["Risk register with review dates", "Insurance schedule, renewal dates and claims log"],
      }),
    ],
  },
  {
    key: "operations-logistics",
    name: "Operations and logistics",
    mission: "Runs projects and processes and moves goods: supply chain, procurement, shipping and shifts.",
    roles: [
      r({ key: "business-consultant", jd: "business-consultant", title: "Business consultant", purpose: "Finds waste and recommends the best-value decisions.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "operations-manager", title: "Operations manager",
        purpose: "Runs daily operations and keeps processes, people and suppliers working together.",
        duties: ["Plan capacity and schedules", "Write and keep SOPs", "Track operational KPIs and fix bottlenecks"],
        skills: ["Process management", "Scheduling", "KPI tracking", "Problem solving"],
        legal: ["Health and safety duties", "Licences needed to operate"],
        records: ["SOP library", "Operational KPI history"],
      }),
      r({
        key: "project-manager", title: "Project manager",
        purpose: "Delivers projects on time, on budget and to scope.",
        duties: ["Plan scope, timeline and budget", "Track tasks, risks and issues", "Report status weekly"],
        skills: ["Planning", "Risk management", "Stakeholder updates", "Agile and waterfall methods"],
        legal: ["Contract scope and change control", "Health and safety on site projects"],
        records: ["Project plans and change log", "Risk and issue log"],
      }),
      r({
        key: "quality-manager", title: "Quality manager",
        purpose: "Makes sure products and services meet the standard every time.",
        duties: ["Set quality checks and standards", "Log and investigate defects and complaints", "Prepare for certifications such as ISO 9001"],
        skills: ["Quality systems", "Root-cause analysis", "Auditing", "Continuous improvement"],
        legal: ["Product and service standards for the sector", "Certification requirements"],
        records: ["Quality checks and non-conformance log", "Corrective actions and audit records"],
      }),
      r({
        key: "process-documentation-writer", title: "Process and knowledge writer",
        purpose: "Writes down how the business works so anyone, human or AI, can do a job the same way.",
        duties: ["Interview the owner and team and write step-by-step procedures", "Keep a knowledge base organised, dated and easy to search", "Review procedures on a schedule and after every change"],
        skills: ["Process mapping", "Plain-language technical writing", "Knowledge-base structure", "Version control"],
        legal: ["Document control requirements of any standard the business follows", "Confidentiality of internal know-how"],
        records: ["Procedure library with owners and review dates", "Change log for every procedure"],
      }),
      r({
        key: "sustainability-officer", title: "Sustainability officer",
        purpose: "Measures the business's environmental footprint and plans practical reductions customers and lenders now ask about.",
        duties: ["Estimate energy, waste and carbon from bills and purchase records", "Draft a reduction plan with costs and savings", "Prepare answers to customer, tender and lender sustainability questionnaires"],
        skills: ["Carbon accounting basics", "Data gathering from bills and suppliers", "Practical reduction planning", "Honest reporting"],
        legal: ["Green claims and anti-greenwashing rules", "Environmental reporting duties that apply to the business's size"],
        records: ["Footprint calculations with sources", "Evidence file for every environmental claim made"],
      }),
      r({
        key: "rota-coordinator", title: "Rota and shift coordinator",
        purpose: "Builds fair staff rotas that cover demand and respect working-time rules.",
        duties: ["Draft weekly rotas from availability, skills and expected demand", "Handle swaps and gaps and tell managers early", "Report hours, overtime and cover costs"],
        skills: ["Shift planning", "Demand forecasting basics", "Fairness and clear communication", "Spreadsheet scheduling"],
        legal: ["Working-time, rest break and young-worker rules", "Minimum wage effects of hours and unpaid time"],
        records: ["Published rotas with changes", "Hours worked and overtime records"],
      }),
      r({ key: "supply-chain-manager", jd: "supply-chain-manager", title: "Supply chain and inventory manager", purpose: "Stock, suppliers and shipments.", duties: [], skills: [], legal: [], records: [] }),
      r({
        key: "procurement-specialist", title: "Procurement specialist",
        purpose: "Gets the best value from suppliers with fair, documented buying.",
        duties: ["Run quotes and tenders with suppliers", "Compare offers on total cost", "Keep supplier contracts and renewals"],
        skills: ["Sourcing", "Negotiation", "Total cost analysis", "Contract management"],
        legal: ["Anti-bribery and conflict-of-interest rules", "Sanctions screening", "Modern-slavery checks where required"],
        records: ["Quotes and award decisions", "Supplier contracts and due-diligence checks"],
      }),
      r({
        key: "logistics-coordinator", title: "Logistics coordinator",
        purpose: "Gets goods delivered on time and with the right paperwork.",
        duties: ["Book and track shipments", "Prepare shipping and customs documents", "Handle delays and claims"],
        skills: ["Carrier management", "Customs paperwork", "Route planning", "Problem solving"],
        legal: ["Customs and export rules", "Dangerous-goods transport rules"],
        records: ["Shipping documents and customs declarations", "Delivery and claims log"],
      }),
      r({
        key: "import-export-coordinator", title: "Import and export coordinator", tier: "premium",
        purpose: "Prepares the paperwork for goods crossing borders so shipments are not held or over-taxed.",
        duties: ["Prepare commercial invoices, packing lists and customs information for the broker", "Check commodity codes, origin and duty with dated official sources", "Track shipments through customs and record costs"],
        skills: ["Customs documentation", "Commodity classification basics", "Incoterms", "Careful record-keeping"],
        legal: ["Customs, import VAT and duty rules for each route", "Export controls, sanctions and restricted goods"],
        records: ["Customs declarations and supporting documents", "Record of commodity codes and origin evidence"],
      }),
    ],
  },
  {
    key: "technology",
    name: "Technology and data",
    mission: "Builds and secures the business's software, systems and data.",
    roles: [
      r({
        key: "software-engineer", title: "Software engineer", tier: "premium",
        purpose: "Builds and fixes small tools, websites and automations.",
        duties: ["Build automations and small apps from a brief", "Fix bugs and keep code tested", "Document what was built"],
        skills: ["Programming", "Testing", "Automation", "Technical writing"],
        legal: ["Software licences of the code used", "Data protection by design"],
        records: ["Code repository and change history", "Technical documentation"],
      }),
      r({
        key: "it-support", title: "IT support specialist",
        purpose: "Keeps devices, accounts and software working for everyone.",
        duties: ["Guide staff through set-up and problems", "Keep an asset and licence list", "Plan backups and updates"],
        skills: ["Troubleshooting", "Account management", "Backups", "Clear instructions"],
        legal: ["Software licence terms", "Security duties for personal data"],
        records: ["IT asset and licence register", "Backup and incident log"],
      }),
      r({
        key: "data-analyst", title: "Data analyst",
        purpose: "Turns business data into clear answers and dashboards.",
        duties: ["Clean and combine data", "Build reports and dashboards", "Answer business questions with evidence"],
        skills: ["Data analysis", "Spreadsheets and SQL", "Visualisation", "Statistics"],
        legal: ["Data protection and minimisation", "Rules on using customer data for analysis"],
        records: ["Data dictionary", "Report definitions and sources"],
      }),
      r({
        key: "security-officer", title: "Cybersecurity officer", tier: "premium",
        purpose: "Protects the business from cyber attacks and data loss.",
        duties: ["Run security checklists and phishing awareness", "Keep access reviews and password policy", "Plan incident response"],
        skills: ["Security frameworks", "Access control", "Incident response", "Awareness training"],
        legal: ["Breach notification duties", "Security standards such as Cyber Essentials or ISO 27001 where required"],
        records: ["Security policy and access reviews", "Incident and response log"],
      }),
      r({
        key: "ai-automation-specialist", title: "AI and automation specialist",
        purpose: "Finds repeated work in the business and automates it safely with the tools the owner already has.",
        duties: ["Map repeated tasks and estimate the time each automation would save", "Design and document automations between the owner's apps", "Test each automation and write down how to switch it off"],
        skills: ["Workflow analysis", "No-code and low-code automation", "Prompt and agent design", "Testing and rollback planning"],
        legal: ["Data protection when moving data between tools", "Terms of use of the connected apps and AI services"],
        records: ["Automation register with owner, purpose and off-switch", "Test results and change log"],
      }),
      r({
        key: "ux-designer", title: "UX and web designer",
        purpose: "Designs pages and screens customers can use easily, on any device.",
        duties: ["Review the site or app for usability and accessibility problems", "Draft page layouts, wireframes and content structure", "Write a clear brief for whoever builds it"],
        skills: ["User-centred design", "Wireframing", "Accessibility (WCAG)", "Content structure"],
        legal: ["Accessibility law that applies to the business", "Cookie, consent and consumer information rules for websites"],
        records: ["Design files and decisions by version", "Accessibility review with findings and fixes"],
      }),
    ],
  },
  {
    key: "product-research",
    name: "Product and research",
    mission: "Decides what to build and sell, using research, markets and pricing.",
    roles: [
      r({
        key: "product-manager", title: "Product manager",
        purpose: "Decides what the product should do next and why.",
        duties: ["Gather customer needs and feedback", "Write product briefs and roadmaps", "Measure what launched"],
        skills: ["Customer discovery", "Prioritisation", "Writing specs", "Metrics"],
        legal: ["Product safety and labelling where physical", "Accessibility and consumer rules for digital products"],
        records: ["Roadmap and decision log", "Product briefs and launch notes"],
      }),
      r({
        key: "researcher", title: "Researcher",
        purpose: "Answers questions with sources, so decisions rest on facts.",
        duties: ["Research questions from the team", "Summarise findings with sources", "Keep a research library"],
        skills: ["Desk research", "Source evaluation", "Summarising", "Citation"],
        legal: ["Copyright and fair use of sources", "Data protection when research involves people"],
        records: ["Research notes with sources and dates", "Research library"],
      }),
      r({
        key: "market-analyst", title: "Market analyst",
        purpose: "Sizes markets and tracks competitors and trends.",
        duties: ["Market sizing and segmentation", "Competitor tracking", "Trend reports"],
        skills: ["Market research", "Competitive analysis", "Data analysis", "Reporting"],
        legal: ["Competition law on sharing information", "Copyright of reports used"],
        records: ["Market models with sources", "Competitor tracking log"],
      }),
      r({
        key: "pricing-analyst", title: "Pricing analyst",
        purpose: "Works out what to charge, from costs, competitors and what customers will pay.",
        duties: ["Build a price and margin model for each product or service", "Track competitor prices from public sources", "Propose and review price tests with the owner"],
        skills: ["Pricing models", "Margin analysis", "Competitor tracking", "Experiment design"],
        legal: ["Competition law: no price-fixing or sharing prices with competitors", "Price display and promotion rules"],
        records: ["Price list with change history and reasons", "Price test results"],
      }),
    ],
  },
  {
    key: "fundraising",
    name: "Fundraising and investor relations",
    mission: "Prepares the business to raise money and keeps lenders, investors and grant bodies informed.",
    roles: [
      r({
        key: "fundraising-manager", title: "Fundraising and investor relations manager", tier: "premium",
        purpose: "Prepares the business to raise money and keeps lenders, investors and grant bodies informed.",
        duties: ["Keep an investor and lender pipeline with next steps", "Maintain the data room and answer due-diligence questions from the records", "Draft investor updates, grant applications and funding reports for the owner to send"],
        skills: ["Funding options for small businesses", "Financial storytelling", "Data room management", "Grant and application writing"],
        legal: ["Financial promotion and investor communication rules", "Confidentiality and non-disclosure terms"],
        records: ["Data room index with document versions", "Log of investor, lender and grant contacts and what was shared"],
      }),
      r({
        key: "financial-analyst", title: "Financial analyst", tier: "premium",
        purpose: "Turns the numbers into forecasts, scenarios and investment decisions.",
        duties: ["Build forecasts and scenario models", "Analyse margins, pricing and unit economics", "Prepare investor and lender packs"],
        skills: ["Financial modelling", "Forecasting", "Variance analysis", "Investor reporting"],
        legal: ["Rules on financial promotions when raising money", "Confidentiality of financial information"],
        records: ["Model versions with assumptions", "Investor and lender reporting packs"],
      }),
    ],
  },
];

export function allRoles(): RoleBlueprint[] {
  return DEPARTMENTS.flatMap((d) => [...d.roles]);
}

export function getBlueprint(key: string): { department: Department; role: RoleBlueprint } | undefined {
  for (const department of DEPARTMENTS) {
    const role = department.roles.find((x) => x.key === key);
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
