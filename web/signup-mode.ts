/**
 * Pre-launch switch for the website build. SIGNUP_MODE=interest (the default) turns every "sign up / start free trial"
 * call to action into "Register your interest" and drops the promise of a 7-day trial. SIGNUP_MODE=open builds the
 * normal signup site, byte for byte what was there before. The server reads the same variable and refuses new accounts
 * in interest mode, so a stale page cannot open signup by itself.
 */
export const SIGNUP_MODE: "interest" | "open" = process.env.SIGNUP_MODE === "open" ? "open" : "interest";
export const INTEREST_MODE = SIGNUP_MODE === "interest";

const SOON = "Opening soon. Register your interest and we will email you when your place is ready.";

/** [from, to] pairs applied to every page in interest mode. Each `from` is a string that exists in the pages today. */
const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const COPY: ReadonlyArray<readonly [string, string]> = [
  ["free trial, billing, cancellation", "any trial, billing, cancellation"],
  ['href="/onboarding.html"', 'href="/register-interest.html"'],
  ['<a class="btn btn-primary" href="/signin.html" data-account-link>Sign up / Sign in</a>', '<a class="btn btn-ghost" href="/signin.html" data-account-link>Log in</a><a class="btn btn-primary" href="/register-interest.html">Register your interest</a>'],
  [">Start free trial<", ">Register your interest<"],
  [">Start your free trial<", ">Register your interest<"],
  [">Start your free week<", ">Register your interest<"],
  ["Free for 7 days. No card. Cancel by doing nothing.", SOON],
  ["Free for 7 days. 3,000 energy. No card.", SOON],
  ["Free for 7 days. No card.", SOON],
  ["Free for 7 days, no card.", "Opening soon: register your interest."],
  ["<li>" + CHECK + "3,000 energy</li><li>" + CHECK + "No card</li>", "<li>" + CHECK + "You approve everything</li>"],
  ["<li><svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 8.5l3.2 3L13 4.5\"/></svg>7 days free</li>", "<li><svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 8.5l3.2 3L13 4.5\"/></svg>Opening soon</li>"],
  ["Your AI team is three minutes away", "Your AI team is nearly ready"],
  ["Start with a 7-day free trial, no card. The Team package", "Opening soon. The Team package"],
  ["<h1>Start free. Build your team.</h1>", "<h1>Build your team.</h1>"],
  ['7 days free, 3,000 energy, no card. Then <span data-price="basicPackageMonthlyGbp">£150</span> a month for the whole team.', '<span data-price="basicPackageMonthlyGbp">£150</span> a month for the whole team. Opening soon: register your interest and we will email you when it opens.'],
  ["Nothing is charged during the 7-day trial, and you only pay if you choose to keep your team. Payment is taken securely by Stripe, and you can cancel in one click.", "Nothing is charged until MAIZ Agents opens and you choose to hire your team. Payment will be taken securely by Stripe, and you will be able to cancel in one click."],
  ["<summary>What happens after the trial?</summary><p>You choose a plan or stop. We do not need a card during the trial.</p>", "<summary>When does MAIZ Agents open?</summary><p>Soon. Register your interest and we will email you the day it opens. Any trial offer will be confirmed then.</p>"],
  ["<summary>What happens after the trial?</summary><p>You pick a plan or you stop. We never ask for a card during the trial, so there is nothing to cancel.</p>", "<summary>When does MAIZ Agents open?</summary><p>Soon. Register your interest and we will email you the day it opens. Any trial offer will be confirmed then.</p>"],
  ["what happens after the trial.", "when MAIZ Agents opens."],
  ["The trial has one pool of 3,000 energy for the 7 days.", "Trial terms will be confirmed when MAIZ Agents opens."],
  ["Pick your kind of business at sign-up", "Pick your kind of business when you start"],
  ["<span>From sign-up to first job</span>", "<span>What happens when we open</span>"],
  ["<p>New businesses get a 7-day free trial with 3,000 energy. We do not ask for a card during the trial. When the trial ends you choose a plan or you stop, and we do not charge you for anything you have not chosen. We may limit trials to one per business.</p>", "<p>MAIZ Agents has not opened to customers yet. Until it does, the only thing you can do on the site is register your interest, which creates no account, order or contract. When we open we expect to offer new businesses a free trial, and we will confirm its length, energy and conditions here and in our email to you before you start. A trial would not need a card, and we would not charge you for anything you have not chosen.</p>"],
];

/** Interest-mode copy for one page. Open mode returns the page untouched. */
export function signupCopy(html: string): string {
  return INTEREST_MODE ? COPY.reduce((out, [from, to]) => out.replaceAll(from, to), html) : html;
}
