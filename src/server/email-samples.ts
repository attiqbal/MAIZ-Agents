import { accountExistsEmail, affiliatePaidEmail, affiliateWelcomeEmail, couponGiftEmail, confirmEmailEmail, decisionsWaitingEmail, ownerAlertEmail, passwordResetEmail, signInLinkEmail, signOffReminderEmail, teamInviteEmail, type EmailBrand, type Mail } from "./email-templates.js";

/** One example of every email, with made-up links. Used by the preview script and the tests. */
export function sampleEmails(brand: EmailBrand): Record<string, Omit<Mail, "to">> {
  const b = brand.baseUrl;
  return {
    "sign-in-link": signInLinkEmail(`${b}/signin.html#token=example-token`, brand),
    "confirm-email": confirmEmailEmail(`${b}/signin.html#confirm=example-token`, brand),
    "account-exists": accountExistsEmail(`${b}/signin.html`, `${b}/signin.html#forgot`, brand),
    "password-reset": passwordResetEmail(`${b}/signin.html#reset=example-token`, brand),
    "coupon-gift": couponGiftEmail("WELCOME-FRIEND", "30 more days of free trial", `${b}/onboarding.html`, brand),
    "affiliate-welcome": affiliateWelcomeEmail("Sam Example", `${b}/r/sam`, `${b}/affiliate.html`, "20% of each payment for the first 12 months", brand),
    "affiliate-paid": affiliatePaidEmail("Sam Example", "£45.00", "BACS 2026-12-01", `${b}/affiliate.html`, brand),
    "team-invite": teamInviteEmail({ businessName: "Kestrel Joinery", invitedBy: "ann@kestreljoinery.example", roleLabel: "Team member", can: "Ask the team for work and see the results.", url: `${b}/join.html#i=example-token` }, brand),
    "owner-decisions": decisionsWaitingEmail(3, `${b}/owner-decisions.html`, brand),
    "owner-sign-off-reminder": signOffReminderEmail([
      { kind: "review", id: "example-1", title: "Brand kit and logo directions", clientName: "Kestrel Joinery", ageHours: 5, link: "/review.html#example-1" },
      { kind: "specialist", id: "example-2", title: "Wholesale account coordinator", clientName: "Fern and Co", ageHours: 2, link: "/owner-specialists.html#example-2" },
    ], 2, b, brand),
    "owner-alert-setup": ownerAlertEmail("Setup needs you: Kestrel Joinery", "Kestrel Joinery's setup stopped and could not undo every step (setup.failed). The client was told MAIZ has been alerted and does not need to do anything.\n\nWorkspace: ws_example\nThe audit log has each step's result.", brand),
    "owner-alert-books": ownerAlertEmail("Books need a look: Kestrel Joinery", "Tonight's check of Kestrel Joinery's books found 2 problem(s):\n\n- Example problem one\n- Example problem two\n\nNothing was changed. Details: " + b + "/owner-clients.html", brand),
  };
}
