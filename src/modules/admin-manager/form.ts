/**
 * The setup form the Admin manager sends after signup. It is plain data so the
 * dashboard, a chat app or an email can all render it, and pure (no Node imports)
 * so the website can import it too.
 *
 * Only questions for employees the customer actually has are shown. Everything is
 * optional except the two questions every employee needs; "I don't know" is fine,
 * and the team marks anything guessed as an estimate.
 */
export type FieldType = "text" | "longtext" | "choice" | "multi" | "yesno" | "number" | "month";

export interface FormField {
  key: string;
  label: string;
  help?: string;
  type: FieldType;
  options?: readonly string[];
  required?: boolean;
  /** "all" or the template key of the employee who needs the answer. */
  for: "all" | string;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export const SETUP_FORM: readonly FormField[] = [
  { key: "goals", label: "What should your team help with most in the next 3 months?", type: "longtext", required: true, for: "all", help: "For example: more customers, get the books in order, hire two people." },
  { key: "customers", label: "Who are your customers?", type: "text", required: true, for: "all", help: "One line is enough, like \"busy parents in Manchester\"." },
  { key: "tone", label: "How should your team sound?", type: "choice", options: ["Warm and friendly", "Professional", "Bold and playful", "Plain and direct"], for: "all" },
  { key: "financialYearStart", label: "When does your financial year start?", type: "month", options: MONTHS, for: "finance-manager" },
  { key: "salesTaxRegistered", label: "Are you registered for VAT or sales tax?", type: "yesno", for: "finance-manager" },
  { key: "cashToday", label: "Roughly how much cash is in the bank today?", type: "number", for: "finance-manager", help: "Optional. Used for your first cash snapshot, marked as \"You told us\"." },
  { key: "marketingChannels", label: "Where do you market today?", type: "multi", options: ["Instagram", "Facebook", "LinkedIn", "TikTok", "X", "Email", "Website or blog", "Nowhere yet"], for: "marketing-manager" },
  { key: "competitors", label: "Who are your main competitors?", type: "text", for: "marketing-manager" },
  { key: "biggestCosts", label: "What are your biggest costs or worries?", type: "longtext", for: "business-consultant" },
  { key: "staffCount", label: "How many people work for you, not counting you?", type: "number", for: "hr-manager" },
  { key: "hiringSoon", label: "Are you planning to hire in the next 3 months?", type: "yesno", for: "hr-manager" },
  { key: "peopleHelp", label: "What would help most with your people?", type: "multi", options: ["Hiring", "Onboarding new staff", "Staff handbook and policies", "Holiday and leave", "Performance reviews"], for: "hr-manager" },
  { key: "industry", label: "Which industry are you in, and do you sell anything regulated?", type: "text", for: "compliance-manager", help: "For example: food, alcohol, health, finance, childcare, construction. \"Nothing regulated\" is fine." },
  { key: "regions", label: "Where do you sell or have customers?", type: "multi", options: ["Only my country", "European Union", "United Kingdom", "United States", "Middle East", "Asia", "Worldwide online"], for: "compliance-manager" },
  { key: "personalData", label: "What personal data do you keep?", type: "multi", options: ["Customer contact details", "Payment details", "Staff records", "Health or other sensitive data", "None"], for: "compliance-manager" },
  { key: "stockItems", label: "Roughly how many products or stock items do you keep?", type: "number", for: "supply-chain-manager" },
  { key: "tradeCountries", label: "Which countries do you buy from or ship to?", type: "text", for: "supply-chain-manager", help: "So your team knows which customs and product rules apply." },
  { key: "licences", label: "Which licences, registrations or certificates do you hold?", type: "longtext", for: "compliance-manager", help: "With renewal dates if you know them." },
];

export type Answers = Record<string, string | number | boolean | string[]>;

/** The questions for this team: shared ones plus each hired employee's own. */
export function formFor(employeeKeys: readonly string[]): FormField[] {
  return SETUP_FORM.filter((f) => f.for === "all" || employeeKeys.includes(f.for));
}

export interface Validation {
  ok: boolean;
  errors: Record<string, string>;
  /** Only known fields, trimmed, with empty answers removed. */
  clean: Answers;
}

export function validateAnswers(fields: readonly FormField[], answers: Answers): Validation {
  const errors: Record<string, string> = {};
  const clean: Answers = {};
  for (const f of fields) {
    let v = answers[f.key];
    if (typeof v === "string") v = v.trim();
    const empty = v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errors[f.key] = "Please answer this one.";
      continue;
    }
    switch (f.type) {
      case "text":
      case "longtext":
        if (typeof v !== "string") errors[f.key] = "Expected text.";
        else if (v.length > 2000) errors[f.key] = "Please keep it under 2,000 characters.";
        break;
      case "choice":
      case "month":
        if (typeof v !== "string" || !f.options?.includes(v)) errors[f.key] = "Pick one of the options.";
        break;
      case "multi":
        if (!Array.isArray(v) || v.some((x) => !f.options?.includes(x))) errors[f.key] = "Pick from the options.";
        break;
      case "yesno":
        if (typeof v !== "boolean") errors[f.key] = "Answer yes or no.";
        break;
      case "number":
        if (typeof v === "string" && v !== "") v = Number(v.replace(/,/g, ""));
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors[f.key] = "Enter a number of 0 or more.";
        break;
    }
    if (!errors[f.key]) clean[f.key] = v as Answers[string];
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

function show(v: Answers[string]): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/**
 * What one employee is taught from the form: the shared answers plus its own.
 * The Admin manager learns everything, because it routes all work.
 */
export function trainingNotes(templateKey: string, fields: readonly FormField[], answers: Answers): string | undefined {
  const lines = fields
    .filter((f) => answers[f.key] !== undefined && (templateKey === "admin-manager" || f.for === "all" || f.for === templateKey))
    .map((f) => `- ${f.label} ${show(answers[f.key]!)}`);
  return lines.length ? lines.join("\n") : undefined;
}
