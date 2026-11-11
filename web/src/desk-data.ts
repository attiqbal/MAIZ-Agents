// Each AI employee's own dashboard, for the example business (Kestrel Coffee). Every employee uses the
// same seven blocks in the same places; only the numbers and the main panel change by role.
// Figures carry where they came from: Verified (from a connected app or the books), You told us, or Estimate.

export type Source = "Verified" | "You told us" | "Estimate";
export interface DeskKpi { label: string; value: string; note: string; source: Source; tone?: "warn" | "up" }
export interface DeskNeed { title: string; detail: string; action: string; href?: string; toast?: string }
export interface DeskRow { label: string; value: string; note?: string; tone?: "good" | "warn" | "crit" | "info" }
export interface DeskEmployee {
  key: string;
  name: string;
  abbr: string;
  cls: string;
  plan: string;
  status: "good" | "warn" | "idle";
  statusText: string;
  /** Share of this week's team energy this employee has used. */
  energyPct: number;
  purpose: string;
  needs: DeskNeed[];
  kpis: DeskKpi[];
  main: { title: string; link?: { href: string; label: string }; rows: DeskRow[]; note?: string };
  working: { title: string; note: string; pct?: number }[];
  done: { title: string; note: string }[];
  coming: { when: string; title: string }[];
  sees: string[];
  ask: string[];
  /** Prefix the ask bar uses to send a request to this employee. */
  askAs: string;
}

export const DESK: DeskEmployee[] = [
  {
    key: "admin-manager", name: "Admin manager", abbr: "AM", cls: "av-tl", plan: "Free with every team", status: "good", statusText: "Working", energyPct: 0, askAs: "admin",
    purpose: "Runs your setup, routes every request to the right employee and writes your daily briefing.",
    needs: [{ title: "Fill in your 3-minute setup form", detail: "So I can train your team and prepare their tools.", action: "Open form", href: "#setup" }],
    kpis: [
      { label: "Setup", value: "4 of 6", note: "Steps done", source: "Verified" },
      { label: "Requests routed today", value: "7", note: "All answered within 5 minutes", source: "Verified" },
      { label: "Team energy used", value: "62%", note: "Of this week's 8,000", source: "Verified" },
      { label: "Open requests", value: "2", note: "Both waiting on you", source: "Verified", tone: "warn" },
    ],
    main: { title: "Setup progress", link: { href: "#setup", label: "Open setup" }, rows: [
      { label: "Business profile", value: "Done", tone: "good" }, { label: "Storage for your files", value: "Done", tone: "good" },
      { label: "AI models prepared", value: "Done", tone: "good" }, { label: "Team trained on your answers", value: "Done", tone: "good" },
      { label: "Slack connected", value: "Waiting for you", tone: "warn" }, { label: "First week plan", value: "After your setup form", tone: "info" },
    ] },
    working: [{ title: "Today's 5 pm briefing", note: "Uses no energy", pct: 40 }],
    done: [{ title: "Welcome and team introductions", note: "Sent to your dashboard" }, { title: "Routed the VAT question to Finance", note: "Today 10:12" }],
    coming: [{ when: "Today 17:00", title: "Daily briefing" }, { when: "Monday", title: "Weekly plan for the team" }],
    sees: ["Your dashboard messages", "Slack, once connected"],
    ask: ["What did the team do today?", "Who should handle a supplier complaint?", "Set up a weekly meeting summary"],
  },
  {
    key: "finance-manager", name: "Finance manager", abbr: "FM", cls: "av-fm", plan: "In your team package", status: "warn", statusText: "Waiting on you", energyPct: 11, askAs: "finance",
    purpose: "Keeps your books, cash and bills in order, with figures from tested accounting code, not AI guesses.",
    needs: [{ title: "Are you VAT registered?", detail: "Needed to close October's profit and loss.", action: "Answer", href: "#approvals" }],
    kpis: [
      { label: "Cash in bank", value: "£18,420", note: "Runway 7.5 months", source: "Verified" },
      { label: "Owed to you", value: "£340", note: "2 invoices, 1 overdue", source: "Verified", tone: "warn" },
      { label: "Bills due in 14 days", value: "£1,260", note: "4 bills", source: "Verified" },
      { label: "October profit", value: "£1,940", note: "Not closed yet", source: "Estimate" },
    ],
    main: { title: "Profit and loss · October", link: { href: "#finance", label: "Open Finance desk" }, rows: [
      { label: "Sales", value: "£6,210" }, { label: "Cost of coffee and milk", value: "−£2,080" }, { label: "Staff costs", value: "−£1,560" },
      { label: "Rent and bills", value: "−£630" }, { label: "Profit before tax", value: "£1,940", note: "Waiting for your VAT answer", tone: "warn" },
    ] },
    working: [{ title: "October profit and loss", note: "Needs your VAT answer", pct: 80 }, { title: "Matching receipts", note: "3 left", pct: 70 }],
    done: [{ title: "14 receipts matched", note: "Accepted first time" }, { title: "Weekly cash report", note: "Monday" }],
    coming: [{ when: "In 5 days", title: "Pay PAYE and National Insurance" }, { when: "In 27 days", title: "VAT return" }, { when: "Monday", title: "Weekly cash report" }],
    sees: ["Xero (read only)", "Square till (read only)", "BrightPay payroll files you upload"],
    ask: ["How much cash will we have at the end of the month?", "Which bills are due this week?", "Why did costs go up in October?"],
  },
  {
    key: "marketing-manager", name: "Marketing manager", abbr: "MM", cls: "av-mm", plan: "In your team package", status: "good", statusText: "Working", energyPct: 22, askAs: "marketing",
    purpose: "Plans and writes your posts, emails and offers, and shows you everything before it goes out.",
    needs: [{ title: "3 Instagram posts for the autumn blend", detail: "Ready to schedule for Thursday to Saturday.", action: "Review", href: "#approvals" }],
    kpis: [
      { label: "Posts scheduled", value: "6", note: "Next 14 days", source: "Verified" },
      { label: "Email open rate", value: "41%", note: "Last 3 sends", source: "Verified", tone: "up" },
      { label: "New followers", value: "+86", note: "This month", source: "Verified", tone: "up" },
      { label: "Enquiries from posts", value: "9", note: "This month", source: "Estimate" },
    ],
    main: { title: "Content calendar · next 14 days", rows: [
      { label: "Thu 18:00 · Instagram", value: "Autumn blend launch", tone: "warn", note: "Waiting for approval" },
      { label: "Fri 12:00 · Instagram", value: "Behind the roast" , tone: "warn", note: "Waiting for approval" },
      { label: "Sat 10:00 · Instagram", value: "Weekend offer", tone: "warn", note: "Waiting for approval" },
      { label: "Tue 08:00 · Email", value: "November subscriber email", tone: "info", note: "Being written" },
      { label: "Next Fri · Instagram", value: "Customer of the month", tone: "info", note: "Planned" },
    ] },
    working: [{ title: "November subscriber email", note: "6 energy so far", pct: 60 }],
    done: [{ title: "Halloween post", note: "Redone once, energy returned" }, { title: "Competitor price watch", note: "Monday" }],
    coming: [{ when: "Thursday", title: "Autumn blend launch posts" }, { when: "Monday", title: "Competitor price watch" }],
    sees: ["Instagram (posts only after your approval)", "Mailchimp", "Your brand files"],
    ask: ["Write a post for our new oat milk", "Plan December's offers", "How did last week's posts do?"],
  },
  {
    key: "business-consultant", name: "Business consultant", abbr: "BC", cls: "av-bc", plan: "In your team package", status: "idle", statusText: "Idle", energyPct: 14, askAs: "consultant",
    purpose: "Looks for savings and growth, watches competitors and gives you a straight weekly review.",
    needs: [{ title: "Packaging cost up 18% this month", detail: "Two cheaper suppliers found, saving about £140 a month.", action: "See options", toast: "Quote requests sent for approval" }],
    kpis: [
      { label: "Savings found", value: "£140/mo", note: "1 waiting for you", source: "Estimate", tone: "up" },
      { label: "Gross margin", value: "66%", note: "Down 2 points", source: "Verified", tone: "warn" },
      { label: "Ideas open", value: "4", note: "Ranked by value below", source: "Estimate" },
      { label: "Competitor moves", value: "2", note: "This week", source: "Verified" },
    ],
    main: { title: "Opportunities, biggest first", rows: [
      { label: "Switch packaging supplier", value: "£140 a month", tone: "warn", note: "Needs your yes" },
      { label: "Wholesale price list for 3 cafes", value: "£600 a month", tone: "info", note: "Draft ready" },
      { label: "Raise flat white by 10p", value: "£95 a month", tone: "info", note: "In line with the two nearest cafes" },
      { label: "Close an hour earlier on Mondays", value: "£60 a month", tone: "info", note: "Footfall is lowest then" },
    ] },
    working: [],
    done: [{ title: "Supplier cost check", note: "Accepted, 30 energy" }],
    coming: [{ when: "Monday", title: "Weekly business review" }, { when: "1st of the month", title: "Monthly cost review" }],
    sees: ["Your books (read only)", "Public competitor websites and prices"],
    ask: ["Where are we losing money?", "Should we open on Sundays?", "Compare us with the cafe down the road"],
  },
  {
    key: "hr-manager", name: "HR manager", abbr: "HR", cls: "av-hr", plan: "In your team package", status: "good", statusText: "Working", energyPct: 5, askAs: "hr",
    purpose: "Keeps every staff record complete and in date, chases documents, works out holiday and reminds you before anything runs out.",
    needs: [],
    kpis: [],
    main: { title: "From your HR desk", link: { href: "#people", label: "Open HR desk" }, rows: [] },
    working: [{ title: "People basics checklist", note: "12 energy so far", pct: 45 }],
    done: [{ title: "Holiday policy draft", note: "Accepted, 9 energy" }],
    coming: [{ when: "Each Monday", title: "Staff records check and reminders" }, { when: "Before each payroll", title: "Starters, leavers and hours for payroll" }],
    sees: ["Your HR desk (staff records)", "The rota", "BrightPay payroll files you upload"],
    ask: ["What documents is anyone missing?", "How much holiday does Tom have left?", "Draft a contract for a new barista"],
  },
  {
    key: "compliance-manager", name: "Compliance manager", abbr: "CM", cls: "av-cm", plan: "In your team package", status: "good", statusText: "Working", energyPct: 10, askAs: "compliance",
    purpose: "Tracks every filing, licence and rule that applies to you, dates every statement and points to the official source.",
    needs: [{ title: "Accept the insurance renewal quote", detail: "Employers' liability insurance renews in 12 days.", action: "Open calendar", href: "#compliance" }],
    kpis: [
      { label: "Rules tracked", value: "14", note: "For a UK coffee shop", source: "Verified" },
      { label: "Due in 30 days", value: "3", note: "1 needs your action", source: "Verified", tone: "warn" },
      { label: "Overdue", value: "0", note: "Nothing late", source: "Verified" },
      { label: "Rule changes", value: "2", note: "Last 30 days", source: "Verified" },
    ],
    main: { title: "Compliance register", link: { href: "#compliance", label: "Open calendar" }, rows: [
      { label: "Employers' liability insurance", value: "Renew in 12 days", tone: "warn" },
      { label: "Food hygiene rating", value: "5, inspected March", tone: "good" },
      { label: "VAT return", value: "Due in 27 days", tone: "info" },
      { label: "Confirmation statement", value: "Ready to file", tone: "good" },
      { label: "Data protection fee", value: "Renews in 58 days", tone: "info" },
    ], note: "Staff documents (right to work, food hygiene certificates) are tracked on the HR desk." },
    working: [{ title: "Compliance register", note: "36 energy so far", pct: 70 }],
    done: [{ title: "Allergen labelling check", note: "Accepted" }],
    coming: [{ when: "In 12 days", title: "Insurance renewal" }, { when: "In 41 days", title: "Confirmation statement" }],
    sees: ["Companies House and HMRC public records", "Your compliance documents"],
    ask: ["What do we need for an alcohol licence?", "Are we ready for a food hygiene inspection?", "What changed in employment law this year?"],
  },
  {
    key: "growth-consultant", name: "Growth consultant", abbr: "GC", cls: "av-bc", plan: "7-day sprint", status: "warn", statusText: "In quality review", energyPct: 0, askAs: "consultant",
    purpose: "A consultant on a pass: compiles a brief and the directions it could take, which MAIZ checks before any work starts.",
    needs: [{ title: "One question on the brief", detail: "Which customers matter most this quarter: walk-in or wholesale?", action: "Answer", href: "#work" }],
    kpis: [
      { label: "Days left on the pass", value: "6 of 7", note: "Started yesterday", source: "Verified" },
      { label: "Energy used", value: "8%", note: "Of the pass's energy", source: "Verified" },
      { label: "Deliverables", value: "0 of 3", note: "Starts after review", source: "Verified" },
      { label: "Sign-off", value: "In review", note: "MAIZ checks before work starts", source: "Verified", tone: "warn" },
    ],
    main: { title: "Brief and directions", link: { href: "#work", label: "Open tasks" }, rows: [
      { label: "Goal", value: "20 new wholesale cafes in 6 months" },
      { label: "Direction A", value: "Local cafes first", note: "Recommended", tone: "good" },
      { label: "Direction B", value: "Online wholesale shop", tone: "info" },
      { label: "Missing", value: "Your answer on customer focus", tone: "warn" },
    ] },
    working: [], done: [],
    coming: [{ when: "After review", title: "Wholesale price list, outreach plan, first 20 leads" }],
    sees: ["The brief you answered", "Public business listings"],
    ask: ["What will you deliver this week?", "Can you start with the price list?"],
  },
];
