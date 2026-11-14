/**
 * What the promotion agent knows about the three websites it promotes. Researched from the live sites on
 * 14 November 2026. Every fact says whether it was seen on the site or still needs the owner to confirm it,
 * and the agent never states an unconfirmed fact (a price, a pass rate, a number of students) as true in a draft.
 */
export const SITE_KEYS = ["mocktestroom", "examutor", "maizagents"] as const;
export type SiteKey = (typeof SITE_KEYS)[number];

export interface SiteFact {
  text: string;
  /** "seen" = read on the live site; "owner" = confirmed or added by the owner; "to_confirm" = could not be seen, the owner must confirm. */
  status: "seen" | "owner" | "to_confirm";
}

export interface SiteProfile {
  key: SiteKey;
  name: string;
  url: string;
  oneLine: string;
  /** Plain-words description of the offer. */
  offer: string[];
  audiences: { name: string; need: string; message: string }[];
  pricing: SiteFact[];
  strengths: string[];
  /** What the site's search and sharing set-up looks like today, and what is missing. */
  seo: { state: string[]; gaps: string[] };
  /** Things that must never be claimed in promotion (from the sites' own disclaimers and good sense). */
  doNotClaim: string[];
  /** What counts as a win for this site: the main conversion. */
  conversion: string;
  /** Words and tone the site itself uses. */
  tone: string;
  researchedAt: string;
}

const RESEARCHED = "2026-11-14";

export const SITES: Record<SiteKey, SiteProfile> = {
  mocktestroom: {
    key: "mocktestroom",
    name: "Mock Test Room",
    url: "https://mocktestroom.com",
    oneLine: "IELTS, PTE and TOEFL mock tests that feel like the real exam.",
    offer: [
      "Practice and mock tests for three English-language exams: IELTS, PTE and TOEFL.",
      "Test-day timing, lifelike voices, a spoken Speaking examiner, real-time grading and a report on how to raise your score.",
      "A free Diagnostic Test is the front door; there are separate IELTS, PTE and TOEFL practice and mock test pages, a preparation guide, an FAQ, an About page, a guides index and a Packages section.",
    ],
    audiences: [
      { name: "IELTS candidates", need: "A realistic rehearsal and a band-score estimate before booking or sitting the test.", message: "Take a free diagnostic that feels like test day, then see exactly what to fix." },
      { name: "PTE candidates", need: "Practice with the computer-marked format and timing.", message: "Practise PTE the way you will sit it: timed, on screen, graded straight away." },
      { name: "TOEFL candidates", need: "Practice for the TOEFL format and a clear report on the weak sections.", message: "Find your weakest TOEFL section in one sitting, free." },
      { name: "Test-prep teachers and agents", need: "A mock-test tool to recommend to students.", message: "Give every student a realistic mock with a report you can act on." },
    ],
    pricing: [
      { text: "A free Diagnostic Test is the main call to action.", status: "seen" },
      { text: "Paid package prices: the Packages section is linked from the site but its prices could not be read. The /packages path returned an error when checked.", status: "to_confirm" },
    ],
    strengths: [
      "Realism: test-day timing, lifelike voices and a spoken Speaking examiner.",
      "Instant grading plus a report on how to raise the score.",
      "Three big exams on one site, with a free way in.",
      "A guides section that can earn search traffic for exam-prep questions.",
    ],
    seo: {
      state: [
        "Title: \"IELTS, PTE & TOEFL Practice Tests | Mock Test Room\". H1: \"IELTS, PTE and TOEFL practice tests\".",
        "Meta description: \"IELTS, PTE and TOEFL mock tests that feel like the real exam\" (short).",
        "Indexable (robots index, follow), sitemap at /sitemap.xml, Open Graph and Twitter large-image cards set.",
        "robots.txt allows named search and AI crawlers (Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot, CCBot) and blocks /api/, /admin/, /pte/ and /toefl/ paths.",
      ],
      gaps: [
        "Search Console and Bing Webmaster ownership, rankings and indexed pages are not visible from outside: the owner must supply an export.",
        "The meta description is short; a fuller one with the free diagnostic as the hook would earn more clicks.",
        "robots.txt blocks /pte/ and /toefl/: check this is not hiding pages that should rank.",
        "No reviews, case studies or score-improvement proof were seen on the home page.",
      ],
    },
    doNotClaim: [
      "That mock scores are official scores or guarantee an exam result.",
      "Any partnership with IELTS, Pearson (PTE) or ETS (TOEFL). These are trademarks of their owners.",
      "A score improvement figure, pass rate or student count unless the owner supplies it.",
    ],
    conversion: "Starts the free Diagnostic Test, then buys a package.",
    tone: "Confident and product-focused; realism and score improvement.",
    researchedAt: RESEARCHED,
  },
  examutor: {
    key: "examutor",
    name: "Examutor",
    url: "https://examutor.com",
    oneLine: "Online testing and tuition: practice tests, timed mock exams, lessons and an AI tutor in one place.",
    offer: [
      "A four-step loop: Test, Learn, Practise, Re-test. Practice sets of ten questions with explanations, timed mocks, lessons, short videos, flashcards built from mistakes, a skill map, streaks and a study plan.",
      "Digital SAT is the first course. GRE and GMAT are listed; more courses launch one at a time.",
      "Parents can add children aged 13 or over to a shared dashboard; under-18s are bought for by a parent or guardian.",
      "Voucher codes are supported, and siblings get 30% off.",
    ],
    audiences: [
      { name: "Digital SAT students", need: "Know where they stand and a day-by-day plan to the test date.", message: "Find it. Fix it. Prove it. Start free and see your weak skills today." },
      { name: "Parents of teenagers", need: "A way to see progress and spend wisely on test prep.", message: "A shared dashboard shows what your child practised and where they are stuck." },
      { name: "GRE and GMAT candidates", need: "Practice and a study plan (courses are listed; confirm launch state before promoting).", message: "Register interest for the next course to launch." },
      { name: "Schools, tutors and communities", need: "A free resource to recommend or a partner for vouchers.", message: "Free starter access for every student, vouchers for your group." },
    ],
    pricing: [
      { text: "Prices are in US dollars, one payment, no automatic renewal.", status: "seen" },
      { text: "Free starter: every practice question with explanations, lessons, videos, skill map, flashcards, trap guide and built-in tutor. No card needed.", status: "seen" },
      { text: "Sprint USD 39 (45 days, 4 full mocks); Prep USD 99 (4 months, 5 mocks, marked Most popular); Mastery USD 159 (8 months, 7 mocks, marked Best value).", status: "seen" },
      { text: "AI tutor add-on: USD 9 for 1 month, or USD 12 / 29 / 49 with Sprint / Prep / Mastery, up to 300 AI replies a month.", status: "seen" },
      { text: "Sibling discount 30% off the second and later child. Refunds by email to support, each request reviewed.", status: "seen" },
    ],
    strengths: [
      "A genuinely free starter tier with real content, so a free trial is the honest hook.",
      "Clear one-off prices with no subscription to forget.",
      "A parent route, which suits the buyer for under-18 students.",
      "Plain, short headline copy.",
    ],
    seo: {
      state: [
        "Title: \"Examutor | Online testing and tuition: practice tests, mock exams and lessons\" (longer than about 60 characters, may be cut in results).",
        "Meta description present; Open Graph and Twitter cards present.",
        "Sitemap at /sitemap.xml; robots.txt allows crawling and blocks the app, API, sign-in and auth paths.",
      ],
      gaps: [
        "Rankings, indexed pages and backlinks are not visible from outside: the owner must supply Search Console data.",
        "One course (Digital SAT) is live, so keyword focus should be \"Digital SAT practice test\" and related questions, not all of GRE and GMAT.",
        "Title is long; shorten to about 60 characters.",
      ],
    },
    doNotClaim: [
      "That SAT is endorsed by or affiliated with the College Board (the site itself says it is not). SAT is a College Board trademark.",
      "That mock results are official scores. The site says they are Examutor simulations.",
      "Score guarantees or improvement figures not supplied by the owner.",
      "Anything aimed at children under 13. Marketing is to parents and to students aged 13 and over.",
    ],
    conversion: "Start free (a free account), then a Sprint, Prep or Mastery plan.",
    tone: "Friendly, direct, short. \"Test. Learn. Improve.\" \"Find it. Fix it. Prove it.\"",
    researchedAt: RESEARCHED,
  },
  maizagents: {
    key: "maizagents",
    name: "MAIZ Agents",
    url: "https://maizagents.com",
    oneLine: "A team of AI employees for small businesses, with nothing sent without the owner's yes.",
    offer: [
      "AI employees for finance, marketing, business consulting, HR and compliance, run by a free Admin manager.",
      "£150 a month for the whole team, 8,000 energy a week shared by the team, free for 7 days with no card (3,000 energy in the trial).",
      "An employee store for extras, a control centre, approvals (\"Nothing leaves without your yes\"), Slack and other apps.",
      "Operated by MAIZ AI Ltd, registered in England and Wales.",
    ],
    audiences: [
      { name: "UK small-business owners", need: "Back-office help without hiring or learning AI.", message: "Hire a team, not another tool. Free for 7 days, no card." },
      { name: "Sole traders and one-person companies", need: "Bookkeeping help, marketing drafts and compliance reminders on a small budget.", message: "A finance, marketing and compliance team for £150 a month." },
      { name: "Accountants, bookkeepers and consultants", need: "A tool to recommend, or to earn a referral from.", message: "Recommend MAIZ to clients and earn commission through the affiliate programme." },
      { name: "Founders and builders (build in public)", need: "A story: a company run on its own AI employees.", message: "How MAIZ AI Ltd uses MAIZ to run MAIZ." },
    ],
    pricing: [
      { text: "£150 a month for the whole team, no per-seat fees; 8,000 energy a week.", status: "seen" },
      { text: "Extra employees £25 a month (+2,000 energy); specialist hires £35 (+2,000). Free trial 7 days, 3,000 energy.", status: "owner" },
      { text: "Affiliate programme default: 20% of the first 12 payments, 30-day hold. Written affiliate terms are not published yet, so do not promise payouts in copy.", status: "owner" },
    ],
    strengths: [
      "Owner control: every outward action waits for approval.",
      "Plain-English product for people who know nothing about AI.",
      "Simple pricing with a free trial and no card.",
      "A real company behind it, with legal pages published.",
    ],
    seo: {
      state: [
        "Title: \"MAIZ Agents: hire an AI team for your business\". H1: \"Hire a team. Not another tool.\" Canonical, Open Graph, Twitter cards, en_GB locale.",
        "JSON-LD, sitemap, llms.txt and robots that allow AI crawlers (maiz-seo plugin).",
        "Pages: employees, control centre, store, how it works, solutions by sector, pricing, security, FAQs, legal.",
      ],
      gaps: [
        "Google Search Console and Bing verification are an owner step (GOOGLE_/BING_SITE_VERIFICATION); sitemap submission is not confirmed.",
        "No customer reviews or case studies yet, so use honest early-stage framing, not social proof.",
        "Sector pages (solutions) can each target one \"AI for <sector>\" search phrase.",
      ],
    },
    doNotClaim: [
      "Customer numbers, testimonials or results that do not exist.",
      "That the AI replaces regulated professional advice. Finance and compliance output is draft work.",
      "Affiliate payout terms, or income promises of any kind.",
    ],
    conversion: "Starts the 7-day free trial, then the £150 a month team.",
    tone: "Confident, friendly, plain-spoken; British English; newspaper-edition style.",
    researchedAt: RESEARCHED,
  },
};

export function isSiteKey(v: unknown): v is SiteKey {
  return typeof v === "string" && (SITE_KEYS as readonly string[]).includes(v);
}

/** The knowledge as plain text for a model prompt. Unconfirmed facts are marked so a draft cannot present them as true. */
export function knowledgeText(site: SiteProfile, ownerFacts: readonly string[] = []): string {
  const lines = [
    `${site.name} (${site.url}): ${site.oneLine}`,
    `Offer: ${site.offer.join(" ")}`,
    `Audiences: ${site.audiences.map((a) => `${a.name} (${a.need})`).join("; ")}`,
    `Pricing facts: ${site.pricing.map((f) => `${f.text}${f.status === "to_confirm" ? " [NOT CONFIRMED: do not state]" : ""}`).join(" ")}`,
    `Strengths: ${site.strengths.join(" ")}`,
    `Never claim: ${site.doNotClaim.join(" ")}`,
    `Tone: ${site.tone}`,
  ];
  if (ownerFacts.length) lines.push(`Added by the owner: ${ownerFacts.join(" ")}`);
  return lines.join("\n");
}
