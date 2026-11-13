/**
 * Every email MAIZ Agents sends, built from one branded layout. Each builder returns the subject, a plain-text
 * body (kept as the fallback part and for tests) and an HTML body. The HTML is table based with inline CSS so it
 * holds up in Gmail, Outlook and Apple Mail; fonts fall back to Georgia and system sans because web fonts do not
 * load in most mail apps. The logo is a PNG served from the website (`/logo.png`), because mail apps block SVG.
 *
 * Only state facts the product already publishes. Do not add support response times, postal addresses or prices
 * here unless they come from the same source the website uses.
 */

const INK = "#2c2e2a";
const CREAM = "#f5f1e4";
const SAND = "#e0dbce";
const GRASS = "#8ed462";
const MUTED = "#565852";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Helvetica, Arial, sans-serif";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailContent {
  /** Short line mail apps show beside the subject. */
  preheader: string;
  heading: string;
  /** Plain paragraphs. Never put markup here: it is escaped. */
  paragraphs: string[];
  /** Optional bulleted list shown after the paragraphs. */
  list?: string[];
  button?: { label: string; url: string };
  /** Smaller print under the button, such as "If you didn't ask for this...". */
  fineprint?: string[];
  /** Who it is for: customers get the "why you got this" footer, the owner gets an internal tag. */
  audience: "customer" | "owner";
}

export interface EmailBrand {
  /** Public address of the website, no trailing slash. Empty in development: links and the logo stay relative. */
  baseUrl: string;
  /** Optional help address, shown in the footer only when set (SUPPORT_EMAIL). */
  supportEmail?: string;
  /** Registered office of MAIZ AI Ltd, shown in the footer only when set (REGISTERED_OFFICE). */
  registeredOffice?: string;
}

/** The legal entity behind MAIZ Agents (Companies House certificate of incorporation, 13 November 2026). */
export const COMPANY_LEGAL_LINE = "MAIZ Agents is a product of MAIZ AI Ltd, a company registered in England and Wales, company number 17579512.";

export const brandFrom = (cfg: { appUrl?: string; supportEmail?: string; registeredOffice?: string }): EmailBrand => ({
  baseUrl: (cfg.appUrl ?? "").replace(/\/$/, ""),
  supportEmail: cfg.supportEmail,
  registeredOffice: cfg.registeredOffice,
});

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const siteLabel = (baseUrl: string): string => baseUrl.replace(/^https?:\/\//, "") || "maizagents.com";

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;"><tr><td align="center" bgcolor="${INK}" style="background:${INK};border-radius:50px;"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:15px 34px;font:600 16px/1 ${SANS};color:#ffffff;text-decoration:none;border-radius:50px;">${esc(label)}</a></td></tr></table>`;
}

/** Renders the shared layout. */
export function renderEmail(c: EmailContent, brand: EmailBrand): { html: string; text: string } {
  const logo = `${brand.baseUrl}/logo.png`;
  const p = (t: string) => `<p style="margin:0 0 16px;white-space:pre-line;font:400 16px/1.6 ${SANS};color:${INK};">${esc(t)}</p>`;
  const fine = (c.fineprint ?? []).map((t) => `<p style="margin:0 0 8px;font:400 13px/1.55 ${SANS};color:${MUTED};">${esc(t)}</p>`).join("");
  const list = c.list?.length
    ? `<ul style="margin:0 0 16px;padding:0 0 0 20px;font:400 16px/1.6 ${SANS};color:${INK};">${c.list.map((i) => `<li style="margin:0 0 6px;">${esc(i)}</li>`).join("")}</ul>`
    : "";
  const fallbackLink = c.button
    ? `<p style="margin:16px 0 0;font:400 12px/1.5 ${SANS};color:${MUTED};">If the button does not work, copy this address into your browser:<br><a href="${esc(c.button.url)}" style="color:${MUTED};word-break:break-all;">${esc(c.button.url)}</a></p>`
    : "";
  const reason = c.audience === "owner"
    ? "This is an internal message for the MAIZ Agents platform owner."
    : "You are receiving this email because this address was used at " + siteLabel(brand.baseUrl) + ". It is a service message about your account, so it does not have an unsubscribe link.";
  const help = brand.supportEmail ? `Need help? Write to <a href="mailto:${esc(brand.supportEmail)}" style="color:${INK};">${esc(brand.supportEmail)}</a>.<br>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM};">${esc(c.preheader)}${"&nbsp;&zwnj;".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background:${CREAM};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 8px 18px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle;"><img src="${esc(logo)}" width="44" height="44" alt="MAIZ Agents" style="display:block;border:0;border-radius:12px;"></td><td style="vertical-align:middle;padding-left:12px;font:600 20px/1 ${SERIF};color:${INK};">MAIZ Agents</td></tr></table></td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:28px;border-top:6px solid ${GRASS};padding:36px 32px 32px;">
<h1 style="margin:0 0 20px;font:600 28px/1.2 ${SERIF};color:${INK};">${esc(c.heading)}</h1>
${c.paragraphs.map(p).join("")}${list}${c.button ? button(c.button.label, c.button.url) : ""}${fallbackLink}
${fine ? `<div style="margin-top:24px;padding-top:18px;border-top:1px solid ${SAND};">${fine}</div>` : ""}
</td></tr>
<tr><td style="padding:22px 12px 0;text-align:center;font:400 12px/1.6 ${SANS};color:${MUTED};">${help}${reason}<br><a href="${esc(brand.baseUrl || "https://maizagents.com")}" style="color:${MUTED};">${esc(siteLabel(brand.baseUrl))}</a> · MAIZ Agents<br>${esc(COMPANY_LEGAL_LINE)}${brand.registeredOffice ? " Registered office: " + esc(brand.registeredOffice) + "." : ""}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((t) => [t, ""]),
    ...(c.list ?? []).map((i) => `- ${i}`),
    ...(c.list?.length ? [""] : []),
    ...(c.button ? [`${c.button.label}:`, c.button.url, ""] : []),
    ...(c.fineprint ?? []).flatMap((t) => [t, ""]),
    "--",
    "MAIZ Agents · " + siteLabel(brand.baseUrl),
    COMPANY_LEGAL_LINE + (brand.registeredOffice ? ` Registered office: ${brand.registeredOffice}.` : ""),
    ...(brand.supportEmail ? [`Need help? ${brand.supportEmail}`] : []),
    c.audience === "owner" ? "Internal message for the platform owner." : "You are receiving this because this address was used at " + siteLabel(brand.baseUrl) + ". It is a service message about your account.",
  ].join("\n");
  return { html, text };
}

const build = (subject: string, c: EmailContent, brand: EmailBrand): Omit<Mail, "to"> => ({ subject, ...renderEmail(c, brand) });

/** Passwordless sign-in. The link works once and lasts 15 minutes (see /api/signin/start). */
export const signInLinkEmail = (url: string, brand: EmailBrand) => build("Your MAIZ Agents sign-in link", {
  audience: "customer",
  preheader: "Use this link to sign in. It works once and expires in 15 minutes.",
  heading: "Sign in to MAIZ Agents",
  paragraphs: ["Use the button below to sign in. The link works once and expires in 15 minutes."],
  button: { label: "Sign in", url },
  fineprint: ["If you didn't ask for this, you can ignore this email. Nobody can sign in without the link."],
}, brand);

/** Email confirmation at sign-up. The link works once and lasts 1 hour (see password-auth.ts). */
export const confirmEmailEmail = (url: string, brand: EmailBrand) => build("Confirm your email for MAIZ Agents", {
  audience: "customer",
  preheader: "One step left: confirm your email address to create your account.",
  heading: "Confirm your email address",
  paragraphs: [
    "Thank you for signing up to MAIZ Agents. Confirm your email address to finish creating your account. The link works once and expires in 1 hour.",
    "Open it in the same browser you signed up in.",
  ],
  button: { label: "Confirm my email", url },
  fineprint: ["If you didn't ask for this, you can ignore this email. No account is made until you confirm."],
}, brand);

/** Someone tried to sign up with an address that already has an account. */
export const accountExistsEmail = (loginUrl: string, forgotUrl: string, brand: EmailBrand) => build("You already have a MAIZ Agents account", {
  audience: "customer",
  preheader: "This address already has an account. Log in, or reset your password.",
  heading: "You already have an account",
  paragraphs: [
    "Someone (hopefully you) tried to create a MAIZ Agents account with this email address, but an account already exists for it.",
    "You can log in with your existing details. If you have forgotten your password, you can choose a new one.",
  ],
  button: { label: "Log in", url: loginUrl },
  fineprint: [`Forgot your password? Choose a new one here: ${forgotUrl}`, "If this wasn't you, you can ignore this email. Nothing has changed on your account."],
}, brand);

/** Password reset or first password for a link-only account. The link works once and lasts 30 minutes. */
export const passwordResetEmail = (url: string, brand: EmailBrand) => build("Set a new MAIZ Agents password", {
  audience: "customer",
  preheader: "Choose a new password. The link works once and expires in 30 minutes.",
  heading: "Choose a new password",
  paragraphs: ["Use the button below to choose a password for your MAIZ Agents account. The link works once and expires in 30 minutes."],
  button: { label: "Choose a password", url },
  fineprint: ["If you didn't ask for this, you can ignore this email. Your password stays as it is."],
}, brand);

/** Owner digest: quality reviews and new specialists waiting. At most one every 30 minutes. */
export const decisionsWaitingEmail = (count: number, url: string, brand: EmailBrand) => build(
  count === 1 ? "1 decision is waiting for you" : `${count} decisions are waiting for you`,
  {
    audience: "owner",
    preheader: "Quality reviews and new specialists need your decision.",
    heading: count === 1 ? "1 decision is waiting for you" : `${count} decisions are waiting for you`,
    paragraphs: [
      `${count === 1 ? "1 request is" : `${count} requests are`} waiting for your decision (quality reviews and new specialists).`,
      "You get at most one of these emails every 30 minutes, however many requests arrive.",
    ],
    button: { label: "See all decisions", url },
  }, brand);

/** Owner alert for things that need a person (a setup that could not undo itself, a books check that found problems). */
export const ownerAlertEmail = (subject: string, body: string, brand: EmailBrand) => build(subject, {
  audience: "owner",
  preheader: subject,
  heading: subject,
  paragraphs: body.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean),
}, brand);

/** The owner sends someone a coupon: the code, what it gives, and where to use it. */
export const couponGiftEmail = (code: string, summary: string, url: string, brand: EmailBrand) => build("A gift code for MAIZ Agents", {
  audience: "customer",
  preheader: `Your code ${code}: ${summary}.`,
  heading: "You have a code for MAIZ Agents",
  paragraphs: [`Your code gives you: ${summary}.`, `Code: ${code}`, "Enter it when you start your free trial, or in Settings if you already have a team."],
  button: { label: "Start with your code", url },
  fineprint: ["The code may have an expiry date or a limit on how many times it can be used. If it does not work, reply to the person who sent it to you."],
}, brand);

/** A new affiliate: their link, what they earn and where to see it. */
export const affiliateWelcomeEmail = (name: string, referralUrl: string, dashboardUrl: string, commission: string, brand: EmailBrand) => build("You are a MAIZ Agents affiliate", {
  audience: "customer",
  preheader: "Your referral link and where to see your results.",
  heading: `Welcome, ${name}`,
  paragraphs: [
    "You can now earn commission by introducing small businesses to MAIZ Agents.",
    `Your referral link: ${referralUrl}`,
    `What you earn: ${commission}. Commission is paid by hand after a short waiting period, so refunds can be covered first.`,
    "To see your clicks, signups and earnings, log in with this email address.",
  ],
  button: { label: "Open your affiliate page", url: dashboardUrl },
  fineprint: ["The written programme terms will be sent to you separately."],
}, brand);

/** The owner paid an affiliate by hand and marked it paid. */
export const affiliatePaidEmail = (name: string, amount: string, reference: string | undefined, dashboardUrl: string, brand: EmailBrand) => build("Your MAIZ Agents commission has been paid", {
  audience: "customer",
  preheader: `${amount} commission has been marked as paid.`,
  heading: `${amount} commission paid`,
  paragraphs: [`Hello ${name}, we have marked ${amount} of your commission as paid.`, ...(reference ? [`Reference: ${reference}`] : [])],
  button: { label: "See your earnings", url: dashboardUrl },
}, brand);
