// Which documents and records each member of a client's staff needs: the UK rules pack.
// Worked out from the business sector, the job title, the contract and the person's age,
// so the owner never configures a catalogue. Pure data and functions, shared with the website.
//
// Written from UK government guidance as known on 2026-11-11. The Compliance manager dates
// and re-checks these rules; other countries come as their own packs.
import { ageOn } from "./dates.js";

export type Sector =
  | "hospitality" | "care" | "childcare" | "construction" | "retail"
  | "transport" | "security" | "beauty" | "office" | "other";

export const SECTORS: readonly { key: Sector; label: string; match: RegExp }[] = [
  { key: "hospitality", label: "Hospitality and food", match: /caf[eé]|coffee|restaurant|pub\b|bar\b|hotel|food|bakery|catering|takeaway|kitchen|hospitality/i },
  { key: "care", label: "Care and health", match: /care home|home care|\bcare\b|health|clinic|dental|pharmac|nursing|medical|physio/i },
  { key: "childcare", label: "Childcare and education", match: /nursery|child|school|tutor|education|teach|academy/i },
  { key: "construction", label: "Construction and trades", match: /construct|build|plumb|electric|roof|joiner|carpent|trade|scaffold|plaster|decorat/i },
  { key: "retail", label: "Retail and shops", match: /shop|retail|store|boutique|e-?commerce|off.licen[cs]e|convenience/i },
  { key: "transport", label: "Transport and delivery", match: /transport|deliver|courier|logistic|haulage|taxi|removal|fleet|freight/i },
  { key: "security", label: "Security", match: /security|door supervis|guard/i },
  { key: "beauty", label: "Beauty and wellness", match: /beauty|salon|hair|barber|nail|spa\b|tattoo|aesthetic|massage|wellness/i },
  { key: "office", label: "Office and professional", match: /agency|consult|account|law|legal|software|tech|studio|design|marketing|office|finance|recruit/i },
  { key: "other", label: "Other", match: /$^/ },
];

export const sectorLabel = (s: Sector): string => SECTORS.find((x) => x.key === s)?.label ?? "Other";

/** Best match for the setup form's free-text industry answer. The owner can change it on the HR desk. */
export function sectorFromText(text: string | undefined): Sector {
  if (!text) return "other";
  return SECTORS.find((s) => s.match.test(text))?.key ?? "other";
}

export type Category = "right_to_work" | "contract" | "payroll" | "personal" | "sector" | "training";
export type Due = "before_start" | "day_one" | "first_month";

export interface Requirement {
  key: string;
  label: string;
  category: Category;
  /** One line: why it matters, in plain words. */
  why: string;
  /** legal: the law requires it; recommended: good practice or what an inspector or insurer expects. */
  level: "legal" | "recommended";
  due: Due;
  /** Months until it must be renewed, counted from the date it was checked. */
  renewMonths?: number;
  /** Ask for an expiry date when it is recorded (a card or certificate with its own end date). */
  hasExpiry?: boolean;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  right_to_work: "Right to work and ID",
  contract: "Contract",
  payroll: "Pay and pension",
  personal: "Personal details",
  sector: "Licences and checks",
  training: "Training",
};

const CORE: readonly Requirement[] = [
  { key: "right_to_work", label: "Right-to-work check", category: "right_to_work", level: "legal", due: "before_start", why: "Must be done before the first day. Without it the business can be fined for illegal working." },
  { key: "written_statement", label: "Signed contract or written statement", category: "contract", level: "legal", due: "day_one", why: "Every employee and worker must have the main terms in writing on or before their first day." },
  { key: "ni_number", label: "National Insurance number", category: "payroll", level: "legal", due: "first_month", why: "Payroll needs it to report pay to HMRC." },
  { key: "bank_details", label: "Bank details for pay", category: "payroll", level: "recommended", due: "first_month", why: "Needed before the first payday." },
  { key: "starter_checklist", label: "P45 or starter checklist", category: "payroll", level: "legal", due: "first_month", why: "Sets the right tax code from the first payday." },
  { key: "pension_assessment", label: "Workplace pension assessment", category: "payroll", level: "legal", due: "first_month", why: "Every worker must be assessed for auto-enrolment and told the result." },
  { key: "emergency_contact", label: "Emergency contact", category: "personal", level: "recommended", due: "day_one", why: "Who to call if something happens at work." },
  { key: "policies_signed", label: "Handbook and policies signed", category: "contract", level: "recommended", due: "first_month", why: "Shows they were told the rules on conduct, health and safety and data." },
];

const SECTOR_EXTRAS: Record<Sector, readonly Requirement[]> = {
  hospitality: [
    { key: "food_hygiene", label: "Food hygiene certificate (level 2)", category: "training", level: "recommended", due: "first_month", renewMonths: 36, why: "Food handlers must be trained in food hygiene; inspectors ask to see it." },
    { key: "allergen_training", label: "Allergen awareness training", category: "training", level: "recommended", due: "first_month", renewMonths: 36, why: "Staff must be able to answer allergen questions correctly." },
  ],
  care: [
    { key: "dbs_enhanced_adults", label: "Enhanced DBS check with adults' barred list", category: "sector", level: "legal", due: "before_start", renewMonths: 12, why: "Required before working with people who need care. Recheck yearly through the update service." },
    { key: "care_certificate", label: "Care Certificate", category: "training", level: "recommended", due: "first_month", why: "The standard expected of new care workers by the regulator." },
  ],
  childcare: [
    { key: "dbs_enhanced_children", label: "Enhanced DBS check with children's barred list", category: "sector", level: "legal", due: "before_start", renewMonths: 36, why: "Required before working with children." },
    { key: "safeguarding", label: "Safeguarding training", category: "training", level: "legal", due: "first_month", renewMonths: 24, why: "Everyone working with children must know how to spot and report concerns." },
    { key: "paediatric_first_aid", label: "Paediatric first aid", category: "training", level: "recommended", due: "first_month", renewMonths: 36, why: "Early years settings need trained staff on site at all times." },
    { key: "disqualification_declaration", label: "Childcare disqualification declaration", category: "sector", level: "legal", due: "before_start", renewMonths: 12, why: "Confirms they are not disqualified from childcare work." },
  ],
  construction: [
    { key: "cscs_card", label: "CSCS card", category: "sector", level: "recommended", due: "before_start", hasExpiry: true, why: "Most sites will not let people on without a valid card." },
    { key: "asbestos_awareness", label: "Asbestos awareness training", category: "training", level: "legal", due: "first_month", renewMonths: 12, why: "Anyone who could disturb asbestos must be trained, with a yearly refresher." },
    { key: "working_at_height", label: "Working at height training", category: "training", level: "recommended", due: "first_month", renewMonths: 36, why: "Falls from height are the most common cause of serious injury on site." },
  ],
  retail: [
    { key: "age_restricted_sales", label: "Age-restricted sales training (Challenge 25)", category: "training", level: "recommended", due: "first_month", renewMonths: 12, why: "Protects the business's licence and is the main defence if an underage sale happens." },
  ],
  transport: [
    { key: "driving_licence_check", label: "Driving licence check", category: "sector", level: "recommended", due: "before_start", renewMonths: 6, why: "Insurers expect licences to be checked before driving and every 6 months." },
    { key: "driver_cpc", label: "Driver CPC card", category: "sector", level: "legal", due: "before_start", hasExpiry: true, why: "Professional bus, coach and lorry drivers need a valid card (renewed every 5 years)." },
  ],
  security: [
    { key: "sia_licence", label: "SIA licence", category: "sector", level: "legal", due: "before_start", hasExpiry: true, why: "Door supervisors and guards must hold a valid licence (3 years) before working." },
  ],
  beauty: [
    { key: "treatment_qualification", label: "Treatment qualifications", category: "training", level: "recommended", due: "before_start", why: "Insurers and councils ask for proof of training for each treatment." },
    { key: "treatment_licence", label: "Personal treatment licence (where the council requires one)", category: "sector", level: "recommended", due: "before_start", hasExpiry: true, why: "Some treatments, such as tattooing, piercing and laser, need a council licence." },
  ],
  office: [
    { key: "dse_assessment", label: "Display screen equipment assessment", category: "training", level: "legal", due: "first_month", why: "Required for anyone who uses a screen daily for an hour or more." },
  ],
  other: [],
};

const ROLE_EXTRAS: readonly { match: RegExp; req: Requirement }[] = [
  { match: /driver|delivery|courier|van\b/i, req: SECTOR_EXTRAS.transport[0]! },
  { match: /first aid/i, req: { key: "first_aid", label: "First aid at work certificate", category: "training", level: "recommended", due: "first_month", renewMonths: 36, why: "Appointed first aiders need a current certificate." } },
  { match: /chef|cook|kitchen|baker|barista/i, req: SECTOR_EXTRAS.hospitality[0]! },
  { match: /nurse|pharmacist|physio|paramedic|midwife|dentist|doctor/i, req: { key: "professional_registration", label: "Professional registration", category: "sector", level: "legal", due: "before_start", hasExpiry: true, why: "Regulated health jobs need a current registration with their regulator." } },
  { match: /bar manager|licensee|\bdps\b/i, req: { key: "personal_licence", label: "Personal licence (alcohol)", category: "sector", level: "legal", due: "before_start", why: "The designated premises supervisor must hold a personal licence." } },
  { match: /night/i, req: { key: "night_health", label: "Night worker health assessment offered", category: "personal", level: "legal", due: "first_month", renewMonths: 12, why: "Night workers must be offered a free health assessment, and again regularly." } },
];

const YOUNG_WORKER: Requirement = { key: "young_worker_risk", label: "Young worker risk assessment", category: "personal", level: "legal", due: "before_start", why: "Anyone under 18 needs a risk assessment that covers their age and experience." };

export interface RequirementFacts {
  jobTitle: string;
  dateOfBirth?: string;
}

/** Every document this person needs, core set first, each key once. */
export function requiredDocuments(person: RequirementFacts, sector: Sector, today: string): Requirement[] {
  const out = new Map<string, Requirement>();
  for (const r of CORE) out.set(r.key, r);
  for (const r of SECTOR_EXTRAS[sector]) out.set(r.key, r);
  for (const { match, req } of ROLE_EXTRAS) if (match.test(person.jobTitle)) out.set(req.key, req);
  if (person.dateOfBirth && ageOn(person.dateOfBirth, today) < 18) out.set(YOUNG_WORKER.key, YOUNG_WORKER);
  return [...out.values()];
}

/** Every requirement any person could have, for validating a document key from the browser. */
export const ALL_REQUIREMENT_KEYS: ReadonlySet<string> = new Set([
  ...CORE.map((r) => r.key),
  ...Object.values(SECTOR_EXTRAS).flat().map((r) => r.key),
  ...ROLE_EXTRAS.map((r) => r.req.key),
  YOUNG_WORKER.key,
]);
