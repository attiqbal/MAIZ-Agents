/**
 * Task-based employees: hired for one job, like a freelancer, instead of joining
 * the team. Each has a fixed price for a defined scope, an included energy
 * allowance, and one overage rule. The Admin manager hires, briefs and sets
 * them up; the owner approves at the listed points.
 *
 * Prices are draft list prices for the owner of MAIZ agents to confirm.
 * Pure data, no server imports: the website imports this file too.
 */
import type { JobDescription } from "./job-descriptions.js";

export interface TaskRole {
  key: string;
  title: string;
  category: string;
  /** One sentence: the job this hire does. */
  purpose: string;
  /** What the fixed price covers. */
  scope: readonly string[];
  /** What it does not cover (quoted separately). */
  notIncluded: readonly string[];
  deliverables: readonly string[];
  /** Where the owner must approve before work continues. */
  approvalPoints: readonly string[];
  skills: readonly string[];
  legal: readonly string[];
  records: readonly string[];
  /** Typical time from approved brief to final delivery. */
  turnaround: string;
  tier: "standard" | "premium";
  /** Fixed price in GBP for the scope above. */
  fixedGbp: number;
  /** Energy included in the fixed price. 1 energy = $0.001 of model cost. */
  includedEnergy: number;
}

/** Price of extra energy once a task's included energy is used up, in GBP per 100 energy. */
export const OVERAGE_GBP_PER_100_ENERGY = 1;
/** The Admin manager warns the owner when a task has used this share of its included energy. */
export const OVERAGE_WARNING_SHARE = 0.8;

export const OVERAGE_RULE = [
  `Your Admin manager tells you when the task has used ${OVERAGE_WARNING_SHARE * 100}% of its included energy.`,
  "When it is all used, work pauses. Nothing extra is charged until you choose: approve more energy up to a cap you set, cut the scope, or stop and keep what is done.",
  `Approved extra energy costs £${OVERAGE_GBP_PER_100_ENERGY} per 100 energy, taken from your wallet.`,
  "Redoing work because the employee got it wrong never counts against the allowance.",
] as const;

export interface UsageCheck {
  status: "within" | "warn" | "paused" | "overage";
  includedLeft: number;
  /** Energy used beyond the allowance (only with approval). */
  overageEnergy: number;
  overageGbp: number;
}

/**
 * Where a task stands against its allowance. `approvedExtra` is the extra energy the
 * owner has approved so far; without it, work pauses at the limit.
 */
export function checkTaskUsage(role: TaskRole, energyUsed: number, approvedExtra = 0): UsageCheck {
  const used = Math.max(0, Math.floor(energyUsed));
  const includedLeft = Math.max(0, role.includedEnergy - used);
  const overageEnergy = Math.max(0, used - role.includedEnergy);
  const overageGbp = Math.ceil(overageEnergy / 100) * OVERAGE_GBP_PER_100_ENERGY;
  if (used < role.includedEnergy * OVERAGE_WARNING_SHARE) return { status: "within", includedLeft, overageEnergy, overageGbp };
  if (used < role.includedEnergy) return { status: "warn", includedLeft, overageEnergy, overageGbp };
  if (overageEnergy < approvedExtra) return { status: "overage", includedLeft, overageEnergy, overageGbp };
  return { status: "paused", includedLeft, overageEnergy, overageGbp };
}

const t = (x: TaskRole) => x;

export const TASK_ROLES: readonly TaskRole[] = [
  // ---- Web and technology ----
  t({
    key: "website-developer", title: "Website developer", category: "Web and technology", tier: "premium",
    purpose: "Builds a small business website from your brief, ready to publish.",
    scope: ["Up to 5 pages (for example home, about, services, pricing, contact)", "Mobile-friendly design in your brand colours", "Contact form, basic SEO and analytics set-up", "Two rounds of changes"],
    notIncluded: ["Online shop or bookings system", "Logo design", "Domain and hosting fees", "Copywriting beyond the page text from your brief"],
    deliverables: ["Sitemap and page plan", "Design preview of the home page", "Finished website files and publishing guide", "Handover notes: how to edit and what was built"],
    approvalPoints: ["Sitemap and page plan", "Home page design preview", "Full site before publishing"],
    skills: ["Web development (HTML, CSS, JavaScript)", "Responsive design", "Accessibility (WCAG 2.2 AA)", "On-page SEO"],
    legal: ["Privacy notice and cookie consent", "Website accessibility law where it applies", "Copyright and licences for images and fonts"],
    records: ["Source files and change history", "Licences for assets used", "Handover notes"],
    turnaround: "5 to 10 working days", fixedGbp: 249, includedEnergy: 6000,
  }),
  t({
    key: "landing-page-builder", title: "Landing page builder", category: "Web and technology", tier: "standard",
    purpose: "Builds one high-converting landing page for a product, offer or campaign.",
    scope: ["One page with copy, layout and a clear call to action", "Sign-up or contact form", "One round of changes"],
    notIncluded: ["Paid ads set-up", "Payment checkout"],
    deliverables: ["Page copy", "Finished page and publishing guide"],
    approvalPoints: ["Copy and layout", "Page before publishing"],
    skills: ["Conversion copywriting", "Web development", "A/B test planning"],
    legal: ["Advertising and claims rules", "Privacy notice for the form"],
    records: ["Page source and copy versions", "Form consent wording"],
    turnaround: "2 to 4 working days", fixedGbp: 79, includedEnergy: 1500,
  }),
  t({
    key: "website-fixer", title: "Website fixer", category: "Web and technology", tier: "standard",
    purpose: "Fixes a batch of problems or small changes on an existing website.",
    scope: ["Up to 10 small fixes or changes from one list", "Speed and broken-link check", "Before and after notes"],
    notIncluded: ["Redesigns or new pages", "Work on sites we cannot access safely"],
    deliverables: ["Fix list with status", "Changed files or step-by-step instructions"],
    approvalPoints: ["Fix list and plan", "Changes before they go live"],
    skills: ["Debugging", "Web development", "Performance checks"],
    legal: ["Data protection when handling site data", "Licence terms of themes and plugins"],
    records: ["Change log", "Backup taken before changes"],
    turnaround: "1 to 3 working days", fixedGbp: 49, includedEnergy: 1000,
  }),
  t({
    key: "automation-builder", title: "Automation builder", category: "Web and technology", tier: "premium",
    purpose: "Automates one repetitive workflow between the tools you already use.",
    scope: ["One workflow (for example form to spreadsheet to email)", "Testing with sample data", "Simple guide to run and change it"],
    notIncluded: ["Paid automation-tool subscriptions", "Custom software beyond the workflow"],
    deliverables: ["Workflow map", "Working automation or exact set-up steps", "Run guide"],
    approvalPoints: ["Workflow map", "Test run before switching on"],
    skills: ["Process mapping", "Integration tools", "Scripting", "Testing"],
    legal: ["Data protection for data moved between tools", "Tool terms of service"],
    records: ["Workflow map and settings", "Test results"],
    turnaround: "3 to 5 working days", fixedGbp: 99, includedEnergy: 2500,
  }),
  t({
    key: "data-cleaner", title: "Data clean-up specialist", category: "Web and technology", tier: "standard",
    purpose: "Cleans, de-duplicates and restructures a messy spreadsheet or contact list.",
    scope: ["One file up to 5,000 rows", "Duplicates, formats and missing values fixed", "Summary of what changed"],
    notIncluded: ["Buying or enriching data from outside sources"],
    deliverables: ["Clean file", "Change summary and list of rows needing your decision"],
    approvalPoints: ["Clean-up rules before they are applied"],
    skills: ["Spreadsheets", "Data cleaning", "Attention to detail"],
    legal: ["Data protection: minimum data, lawful basis, deletion of copies"],
    records: ["Original file kept untouched", "Change log"],
    turnaround: "1 to 2 working days", fixedGbp: 39, includedEnergy: 800,
  }),
  // ---- Design and content ----
  t({
    key: "brand-designer", title: "Brand kit designer", category: "Design and content", tier: "standard",
    purpose: "Creates a simple brand kit: logo ideas, colours, fonts and how to use them.",
    scope: ["3 logo concepts, 1 refined", "Colour palette and font pairing", "One-page brand guide", "Two rounds of changes"],
    notIncluded: ["Trademark registration", "Printed materials"],
    deliverables: ["Logo files", "Brand guide"],
    approvalPoints: ["Concept choice", "Final kit"],
    skills: ["Visual design", "Brand strategy", "Typography"],
    legal: ["Trademark conflicts: check before use", "Font and image licences"],
    records: ["Design files", "Licences"],
    turnaround: "3 to 5 working days", fixedGbp: 99, includedEnergy: 2000,
  }),
  t({
    key: "pitch-deck-writer", title: "Pitch deck writer", category: "Design and content", tier: "premium",
    purpose: "Writes and lays out an investor or sales pitch deck.",
    scope: ["Up to 15 slides", "Story, copy and simple charts from your numbers", "Two rounds of changes"],
    notIncluded: ["Financial model (see Financial modeller)", "Custom illustrations"],
    deliverables: ["Deck outline", "Finished deck", "Speaker notes"],
    approvalPoints: ["Outline", "Draft deck"],
    skills: ["Storytelling", "Business writing", "Slide design", "Data visualisation"],
    legal: ["Financial promotion rules when raising money", "Accuracy of claims"],
    records: ["Deck versions", "Sources for every figure"],
    turnaround: "3 to 5 working days", fixedGbp: 129, includedEnergy: 3000,
  }),
  t({
    key: "blog-writer", title: "Blog writer", category: "Design and content", tier: "standard",
    purpose: "Writes a pack of search-friendly blog articles in your voice.",
    scope: ["4 articles of about 1,000 words", "Keyword brief for each", "One round of changes"],
    notIncluded: ["Publishing on your site", "Original photography"],
    deliverables: ["Keyword briefs", "4 finished articles"],
    approvalPoints: ["Topics and keywords", "Drafts"],
    skills: ["SEO writing", "Research", "Editing"],
    legal: ["Copyright and quoting", "Claims and disclosures"],
    records: ["Sources per article", "Published versions"],
    turnaround: "4 to 6 working days", fixedGbp: 69, includedEnergy: 2000,
  }),
  t({
    key: "product-copywriter", title: "Product description writer", category: "Design and content", tier: "standard",
    purpose: "Writes clear, selling product descriptions for your shop.",
    scope: ["Up to 50 products", "Title, description and key features", "One round of changes"],
    notIncluded: ["Uploading to your shop", "Product photography"],
    deliverables: ["Spreadsheet of descriptions ready to import"],
    approvalPoints: ["Style sample of 3 products", "Full set"],
    skills: ["Copywriting", "E-commerce SEO", "Consistency at scale"],
    legal: ["Product claims and labelling rules", "Consumer-protection rules on descriptions"],
    records: ["Final copy per product", "Evidence for any claims"],
    turnaround: "2 to 4 working days", fixedGbp: 59, includedEnergy: 1500,
  }),
  t({
    key: "video-scriptwriter", title: "Video scriptwriter", category: "Design and content", tier: "standard",
    purpose: "Writes scripts for short videos and explainer clips.",
    scope: ["Up to 5 scripts under 90 seconds", "Shot list for each", "One round of changes"],
    notIncluded: ["Filming and editing"],
    deliverables: ["Scripts", "Shot lists"],
    approvalPoints: ["Ideas", "Final scripts"],
    skills: ["Script writing", "Hooks and storytelling", "Platform formats"],
    legal: ["Ad disclosure rules", "Music and footage rights"],
    records: ["Script versions"],
    turnaround: "2 to 3 working days", fixedGbp: 49, includedEnergy: 1000,
  }),
  t({
    key: "email-sequence-writer", title: "Email sequence writer", category: "Design and content", tier: "standard",
    purpose: "Writes a welcome, nurture or win-back email sequence.",
    scope: ["Up to 6 emails", "Subject lines with test variants", "Timing plan"],
    notIncluded: ["Email platform set-up"],
    deliverables: ["Sequence plan", "Finished emails"],
    approvalPoints: ["Plan", "Emails"],
    skills: ["Email copywriting", "Lifecycle marketing", "Testing"],
    legal: ["Email consent and unsubscribe rules"],
    records: ["Email versions", "Consent basis for the list"],
    turnaround: "2 to 3 working days", fixedGbp: 59, includedEnergy: 1200,
  }),
  // ---- Marketing and research ----
  t({
    key: "seo-auditor", title: "SEO auditor", category: "Marketing and research", tier: "standard",
    purpose: "Audits your website's search performance and gives a fix list in priority order.",
    scope: ["Technical, on-page and content audit of up to 50 pages", "Keyword gap list", "Prioritised fix plan"],
    notIncluded: ["Making the fixes (see Website fixer)", "Link building"],
    deliverables: ["Audit report", "Fix plan"],
    approvalPoints: ["Final report"],
    skills: ["Technical SEO", "Keyword research", "Reporting"],
    legal: ["Accessibility and cookie rules spotted during the audit"],
    records: ["Audit data and date"],
    turnaround: "2 to 4 working days", fixedGbp: 79, includedEnergy: 2000,
  }),
  t({
    key: "ads-campaign-builder", title: "Ad campaign builder", category: "Marketing and research", tier: "standard",
    purpose: "Plans and writes one paid ad campaign ready to launch.",
    scope: ["One platform (for example Google or Meta)", "Audience, budget plan and 10 ad variants", "Launch checklist"],
    notIncluded: ["Ad spend", "Running the campaign after launch"],
    deliverables: ["Campaign plan", "Ad copy set", "Launch checklist"],
    approvalPoints: ["Plan and budget", "Ads before launch"],
    skills: ["Paid search and social", "Ad copywriting", "Budget planning"],
    legal: ["Advertising standards and platform ad policies", "Special rules for regulated products"],
    records: ["Campaign plan and approved ads"],
    turnaround: "2 to 4 working days", fixedGbp: 89, includedEnergy: 1800,
  }),
  t({
    key: "social-launch-planner", title: "Social media launch planner", category: "Marketing and research", tier: "standard",
    purpose: "Plans and writes 30 days of social posts for a launch or a fresh start.",
    scope: ["30 posts across up to 2 platforms", "Content calendar", "Hashtag and timing guide"],
    notIncluded: ["Posting and replying (see Social media manager)", "Paid promotion"],
    deliverables: ["Calendar", "30 drafted posts"],
    approvalPoints: ["Themes", "Posts"],
    skills: ["Social copywriting", "Content planning", "Platform know-how"],
    legal: ["Ad and influencer disclosure rules", "Image rights"],
    records: ["Approved posts and dates"],
    turnaround: "3 to 5 working days", fixedGbp: 79, includedEnergy: 2000,
  }),
  t({
    key: "market-research-analyst", title: "Market research analyst", category: "Marketing and research", tier: "premium",
    purpose: "Researches a market or idea and reports size, customers, competitors and risks.",
    scope: ["One market or product idea", "Market size estimate with method", "Up to 10 competitors compared", "Customer segments and risks"],
    notIncluded: ["Paid survey panels", "Interviews with real people"],
    deliverables: ["Research report with sources", "One-page summary"],
    approvalPoints: ["Research questions", "Final report"],
    skills: ["Desk research", "Market sizing", "Competitive analysis", "Source evaluation"],
    legal: ["Copyright of sources", "Competition law on information sharing"],
    records: ["Sources with dates checked", "Workings for every estimate"],
    turnaround: "4 to 6 working days", fixedGbp: 149, includedEnergy: 4000,
  }),
  // ---- Finance, legal and funding ----
  t({
    key: "business-plan-writer", title: "Business plan writer", category: "Finance, legal and funding", tier: "premium",
    purpose: "Writes a complete business plan for a bank, investor or your own direction.",
    scope: ["Full plan: summary, market, offer, operations, team, finances", "Uses your numbers or the Financial modeller's", "Two rounds of changes"],
    notIncluded: ["Financial model (separate task)", "Submitting the plan"],
    deliverables: ["Business plan document", "One-page summary"],
    approvalPoints: ["Outline", "Draft plan"],
    skills: ["Business writing", "Strategy", "Market analysis"],
    legal: ["Financial promotion rules", "Accuracy of claims to lenders"],
    records: ["Plan versions", "Sources and assumptions"],
    turnaround: "5 to 8 working days", fixedGbp: 199, includedEnergy: 5000,
  }),
  t({
    key: "financial-modeller", title: "Financial modeller", category: "Finance, legal and funding", tier: "premium",
    purpose: "Builds a 3-year financial model with scenarios from your numbers.",
    scope: ["3-year profit and loss, cash flow and balance sheet", "Three scenarios", "Assumptions sheet"],
    notIncluded: ["Audit or accountant sign-off", "Tax advice"],
    deliverables: ["Spreadsheet model", "Summary of key numbers"],
    approvalPoints: ["Assumptions", "Final model"],
    skills: ["Financial modelling", "Forecasting", "Spreadsheet design"],
    legal: ["Never presented as audited or as advice"],
    records: ["Model versions", "Assumption sources"],
    turnaround: "4 to 6 working days", fixedGbp: 179, includedEnergy: 4500,
  }),
  t({
    key: "bookkeeping-catch-up", title: "Bookkeeping catch-up", category: "Finance, legal and funding", tier: "premium",
    purpose: "Brings late books up to date and hands them to your Finance manager or accountant.",
    scope: ["Up to 3 months of transactions (about 300)", "Categorised, reconciled and checked", "List of missing documents"],
    notIncluded: ["Tax returns or filings", "More than 3 months (quoted per extra month)"],
    deliverables: ["Up-to-date ledger", "Trial balance", "Missing-documents list"],
    approvalPoints: ["Category rules", "Final books"],
    skills: ["Bookkeeping", "Reconciliation", "Attention to detail"],
    legal: ["Record-keeping and retention rules of your country"],
    records: ["Journals and source documents", "Reconciliations"],
    turnaround: "3 to 5 working days", fixedGbp: 149, includedEnergy: 4000,
  }),
  t({
    key: "grant-writer", title: "Grant application writer", category: "Finance, legal and funding", tier: "premium",
    purpose: "Finds a suitable grant and writes the application.",
    scope: ["Eligibility check for up to 3 grants", "One full application", "One round of changes"],
    notIncluded: ["Submitting the application", "Success fees"],
    deliverables: ["Eligibility notes", "Completed application"],
    approvalPoints: ["Grant choice", "Application before you submit"],
    skills: ["Grant writing", "Eligibility analysis", "Budget justification"],
    legal: ["Accuracy of every statement to the funder", "Funder terms and conditions"],
    records: ["Application and evidence", "Funder rules version used"],
    turnaround: "5 to 10 working days", fixedGbp: 199, includedEnergy: 5000,
  }),
  t({
    key: "tender-writer", title: "Tender response writer", category: "Finance, legal and funding", tier: "premium",
    purpose: "Writes one tender or bid response to the buyer's questions.",
    scope: ["One tender up to 20 questions", "Compliance checklist against the buyer's rules"],
    notIncluded: ["Submitting the tender", "Pricing decisions"],
    deliverables: ["Answers", "Compliance checklist"],
    approvalPoints: ["Bid or no-bid", "Answers before you submit"],
    skills: ["Bid writing", "Requirement mapping", "Evidence gathering"],
    legal: ["Public procurement rules", "Accuracy of certifications"],
    records: ["Submitted answers and evidence"],
    turnaround: "5 to 10 working days", fixedGbp: 199, includedEnergy: 5000,
  }),
  t({
    key: "policy-pack-writer", title: "Website legal pack writer", category: "Finance, legal and funding", tier: "premium",
    purpose: "Drafts the standard legal pages a business website needs, for a lawyer to check.",
    scope: ["Privacy notice, cookie notice, terms of use or sale", "Tailored to your country and how you trade"],
    notIncluded: ["Legal advice or a lawyer's sign-off", "Contracts with named parties"],
    deliverables: ["Draft legal pages", "Notes on what a lawyer should check"],
    approvalPoints: ["Facts about your business", "Drafts"],
    skills: ["Policy drafting", "Data protection", "Consumer law basics"],
    legal: ["GDPR-style privacy law", "Consumer and e-commerce rules", "Cookie consent rules"],
    records: ["Draft versions with dates", "Facts the drafts rely on"],
    turnaround: "2 to 4 working days", fixedGbp: 99, includedEnergy: 2500,
  }),
  // ---- People and operations ----
  t({
    key: "recruitment-campaign", title: "Recruitment campaign runner", category: "People and operations", tier: "standard",
    purpose: "Runs the paperwork side of hiring for one role, from job ad to shortlist.",
    scope: ["Job description and ad", "Screening questions and scorecard", "Shortlist from up to 50 applications you share"],
    notIncluded: ["Job board fees", "Interviewing candidates"],
    deliverables: ["Job ad", "Scorecard", "Shortlist with reasons"],
    approvalPoints: ["Job ad", "Shortlist"],
    skills: ["Recruitment", "Fair screening", "Job ad writing"],
    legal: ["Equality law in hiring", "Candidate data retention", "Right-to-work checks before start"],
    records: ["Screening notes and decisions", "Candidate data deletion date"],
    turnaround: "5 to 10 working days", fixedGbp: 129, includedEnergy: 3000,
  }),
  t({
    key: "handbook-writer", title: "Staff handbook writer", category: "People and operations", tier: "premium",
    purpose: "Drafts a staff handbook and core HR policies for your country.",
    scope: ["Handbook with up to 12 policies", "Tailored to your country, size and way of working"],
    notIncluded: ["Employment-law advice or a lawyer's sign-off"],
    deliverables: ["Draft handbook", "Notes on what a professional should check"],
    approvalPoints: ["Policy list", "Draft handbook"],
    skills: ["Policy writing", "Employment law basics", "Plain language"],
    legal: ["Employment law of your country", "Equality and data protection"],
    records: ["Handbook versions with dates", "Staff acknowledgement template"],
    turnaround: "4 to 6 working days", fixedGbp: 149, includedEnergy: 3500,
  }),
  t({
    key: "sop-writer", title: "Process (SOP) writer", category: "People and operations", tier: "standard",
    purpose: "Writes step-by-step procedures for work that is repeated.",
    scope: ["Up to 5 procedures from your notes or a walkthrough", "Checklists for each"],
    notIncluded: ["Software set-up"],
    deliverables: ["SOP documents", "Checklists"],
    approvalPoints: ["List of processes", "Drafts"],
    skills: ["Process mapping", "Technical writing", "Simplification"],
    legal: ["Health and safety steps where the work needs them"],
    records: ["SOP versions with owners and review dates"],
    turnaround: "2 to 4 working days", fixedGbp: 69, includedEnergy: 1500,
  }),
  t({
    key: "event-planner", title: "Event planner", category: "People and operations", tier: "standard",
    purpose: "Plans a business event, launch or workshop from idea to run sheet.",
    scope: ["Plan, budget, timeline and supplier shortlist", "Invitations and run sheet"],
    notIncluded: ["Booking or paying suppliers", "Attending the event"],
    deliverables: ["Event plan", "Budget", "Run sheet"],
    approvalPoints: ["Plan and budget", "Invitations"],
    skills: ["Event planning", "Budgeting", "Supplier comparison"],
    legal: ["Venue, licensing and insurance requirements", "Accessibility and health and safety"],
    records: ["Supplier quotes", "Attendee data with consent"],
    turnaround: "3 to 5 working days", fixedGbp: 79, includedEnergy: 1800,
  }),
];

export function getTaskRole(key: string): TaskRole | undefined {
  return TASK_ROLES.find((r) => r.key === key);
}

export function priceText(role: TaskRole): string {
  return `£${role.fixedGbp} fixed · ${role.includedEnergy.toLocaleString("en-GB")} energy included`;
}

/** A full job description for a task-based employee. */
export function taskJobDescription(key: string): JobDescription | undefined {
  const role = getTaskRole(key);
  if (!role) return undefined;
  return {
    key: role.key,
    jobTitle: role.title,
    department: `Task hire · ${role.category}`,
    reportsTo: "Owner",
    worksWith: ["Admin manager (hires, briefs, tracks the allowance and collects approvals)", "Any team member whose work this task feeds"],
    purpose: `${role.purpose} Hired for one task at a fixed price, not as a permanent team member.`,
    responsibilities: [
      { area: "Scope covered by the fixed price", duties: role.scope },
      { area: "Approval points", duties: role.approvalPoints.map((a) => `Stop and get the owner's approval: ${a}`) },
      { area: "Documentation and legal records", duties: ["Keep every record listed below complete and hand them over at the end", "Know the legal requirements of the job and say when a rule must be confirmed for the owner's country"] },
    ],
    legal: role.legal,
    records: role.records,
    competencies: role.skills.map((skill) => ({ skill, level: "Advanced" as const, detail: "Applied to this task and checked by the owner at each approval point." })),
    knowledge: [`Good practice for ${role.title.toLowerCase()} work`, "The owner's brief and business profile"],
    tools: [{ name: "Business profile and setup answers", status: "available" }],
    deliverables: role.deliverables.map((d) => {
      const share = Math.round(role.includedEnergy / role.deliverables.length);
      return { name: d, cadence: "Once, for this task", energy: [Math.round(share / 2), share] as const };
    }),
    kpis: ["Delivered within the turnaround and the included energy", "Approved at each approval point without major rework", "Every required record handed over"],
    authority: {
      autonomous: ["Work through the agreed scope as drafts", "Keep this task's records"],
      needsApproval: [...role.approvalPoints, "Any work outside the scope", "Using energy beyond the included allowance"],
      never: ["Go beyond the included energy without the owner's approval", "Publish, submit, send or pay for anything", "Give legal, tax or financial advice", "Invent facts, figures or rules"],
    },
    escalate: ["Anything with legal, tax, safety or financial risk: tell the owner and recommend a qualified professional"],
    handover: ["A brief of what you want", "Examples you like", "Access or files the task needs", ...role.notIncluded.map((n) => `Not included: ${n}`)],
    engagement: {
      fixedGbp: role.fixedGbp,
      includedEnergy: role.includedEnergy,
      turnaround: role.turnaround,
      scope: role.scope,
      notIncluded: role.notIncluded,
      approvalPoints: role.approvalPoints,
      overageRule: OVERAGE_RULE,
    },
  };
}
