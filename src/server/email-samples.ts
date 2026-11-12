import { accountExistsEmail, confirmEmailEmail, decisionsWaitingEmail, ownerAlertEmail, passwordResetEmail, signInLinkEmail, type EmailBrand, type Mail } from "./email-templates.js";

/** One example of every email, with made-up links. Used by the preview script and the tests. */
export function sampleEmails(brand: EmailBrand): Record<string, Omit<Mail, "to">> {
  const b = brand.baseUrl;
  return {
    "sign-in-link": signInLinkEmail(`${b}/signin.html#token=example-token`, brand),
    "confirm-email": confirmEmailEmail(`${b}/signin.html#confirm=example-token`, brand),
    "account-exists": accountExistsEmail(`${b}/signin.html`, `${b}/signin.html#forgot`, brand),
    "password-reset": passwordResetEmail(`${b}/signin.html#reset=example-token`, brand),
    "owner-decisions": decisionsWaitingEmail(3, `${b}/owner-decisions.html`, brand),
    "owner-alert-setup": ownerAlertEmail("Setup needs you: Kestrel Joinery", "Kestrel Joinery's setup stopped and could not undo every step (setup.failed). The client was told MAIZ has been alerted and does not need to do anything.\n\nWorkspace: ws_example\nThe audit log has each step's result.", brand),
    "owner-alert-books": ownerAlertEmail("Books need a look: Kestrel Joinery", "Tonight's check of Kestrel Joinery's books found 2 problem(s):\n\n- Example problem one\n- Example problem two\n\nNothing was changed. Details: " + b + "/owner-clients.html", brand),
  };
}
