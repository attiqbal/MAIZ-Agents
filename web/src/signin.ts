import "./styles.css";
import { api, clearSession, getToken, setToken } from "./api";
import { initNav } from "./common";

initNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (h: string, p: string) => { $("si-h").textContent = h; $("si-p").textContent = p; };

// The emailed link carries a one-time token after the "#", so it never reaches any server except when
// this page posts it to the API. Removing it from the address bar keeps it out of history and screenshots.
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) history.replaceState(null, "", location.pathname);

async function verify(t: string): Promise<void> {
  $("si-form").hidden = true;
  $("si-note").hidden = true;
  say("Signing you in…", "");
  const r = await api<{ token: string; email: string; hasOrganisation: boolean; platformOwner?: boolean; error?: string }>("/signin/verify", { body: { token: t } });
  if (!r.ok || !r.data?.token) {
    const why = r.data?.error ? `${r.data.error[0]!.toUpperCase()}${r.data.error.slice(1)}. Request a new link below.` : "It may have expired or been used already. Request a new one below.";
    say("This link didn't work", why);
    $("si-form").hidden = false;
    return;
  }
  setToken(r.data.token);
  try {
    const profile = JSON.parse(localStorage.getItem("vn.profile") ?? "{}");
    localStorage.setItem("vn.profile", JSON.stringify({ ...profile, email: r.data.email }));
  } catch { /* storage unavailable */ }
  // The MAIZ platform owner lands on the quality review queue; clients on their control center.
  location.replace(r.data.platformOwner ? "/review.html" : r.data.hasOrganisation ? "/app.html" : "/onboarding.html");
}

$<HTMLFormElement>("si-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("si-email").value.trim();
  const err = $("si-err");
  err.hidden = true;
  $("si-go").setAttribute("disabled", "");
  const r = await api<{ devLink?: string }>("/signin/start", { body: { email } });
  $("si-go").removeAttribute("disabled");
  if (r.status === 429) { err.textContent = "Too many emails for this address. Please try again in an hour."; err.hidden = false; return; }
  if (!r.ok) { err.textContent = r.status === 0 ? "We can't reach the service right now. Please try again." : "Enter a valid email address."; err.hidden = false; return; }
  // Development API only: the link comes straight back, so there is no email to wait for.
  if (r.data?.devLink) { void verify(r.data.devLink); return; }
  $("si-form").hidden = true;
  say("Check your email", `If ${email} has an account, or you are new, a sign-in link is on its way. It works once and expires in 15 minutes.`);
});

$("si-out").addEventListener("click", () => { clearSession(); location.reload(); });

if (token) void verify(token);
else if (getToken()) {
  $("si-form").hidden = true;
  $("si-note").hidden = true;
  $("si-signed").hidden = false;
  say("You're logged in", "Open your control center, or log out of this device.");
}
