import type { OAuthApp } from "../integrations/types.js";
import { ProbeUnreachable, type ProbeResult } from "./probes.js";

/**
 * The owner-card test for Salesforce, which answers in more detail than the generic one, and the list of providers that
 * have no harmless way to check an app's details (their sign-in needs a real person, or the check would use a real code).
 */
export const NO_SAFE_CHECK: ReadonlySet<string> = new Set(["tiktok", "amazon-seller", "etsy", "ebay", "meta-ads"]);

const MADE_UP = "This test sent a made-up sign-in code, so nothing was created or connected.";
const short = (v: unknown): string => (typeof v === "string" && /^[\w.:-]{1,60}$/.test(v) ? v : "");
/** The provider's own explanation, cut to plain words so it can be shown without risk. */
const plain = (v: unknown): string => (typeof v === "string" ? v.replace(/[^\w .,'()/:-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "");

export async function probeSalesforce(app: OAuthApp, http: typeof fetch): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await http("https://login.salesforce.com/services/oauth2/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "maiz-connection-test", redirect_uri: app.redirectUri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: "maiz-connection-test-maiz-connection-test-0123" }).toString(),
    });
  } catch {
    throw new ProbeUnreachable("could not be reached. Try again in a minute.");
  }
  const j = (await res.json().catch(() => ({}))) as { error?: unknown; error_description?: unknown };
  const code = short(j.error), said = plain(j.error_description);
  const ref = code ? ` (Salesforce said ${code}${said ? `: ${said}` : ""})` : "";
  if (code === "invalid_grant") return { ok: true, message: "Salesforce knows your app and accepted the secret (it only rejected the made-up code, as it should).", details: [MADE_UP, "Salesforce cannot tell from here whether people in other Salesforce orgs may use the app. Connect one client org yourself to prove it, and see the last step of the guide if it says OAUTH_APPROVAL_ERROR_GENERIC."] };
  if (code === "invalid_client_id") return { ok: false, message: `Salesforce does not know this Consumer Key${ref}. If the app is less than ten minutes old, wait and test again. Otherwise copy the Consumer Key again. Since Salesforce's Spring '26 release a new app must be an External Client App, not a Connected App.`, details: [MADE_UP] };
  if (code === "invalid_client") return { ok: false, message: `Salesforce knows the Consumer Key but not this secret${ref}. Copy the Consumer Secret again, or make a new one.`, details: [MADE_UP] };
  if (code === "redirect_uri_mismatch") return { ok: false, message: `Salesforce knows your app, but the Callback URL is not saved there yet${ref}. Paste the address from the box above into the app's OAuth settings.`, details: [MADE_UP] };
  if (code === "unsupported_grant_type" || /flow not enabled|not enabled/i.test(said)) return { ok: false, message: `Salesforce says the sign-in flow is not switched on for this app${ref}. In the app's OAuth settings turn on Authorization Code and Credentials Flow.`, details: [MADE_UP] };
  return { ok: false, message: `Salesforce answered in a way this test does not recognise${ref || ` (error ${res.status})`}. Check the Consumer Key, secret and Callback URL, then try connecting once yourself.`, details: [MADE_UP] };
}
