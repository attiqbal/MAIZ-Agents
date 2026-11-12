import "./styles.css";
import { api, clearSession, getToken } from "./api";
import { authError, finishSignIn, initNav, showSocialLogin, wirePasswordToggles, type SignedIn } from "./common";

initNav();
wirePasswordToggles();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VIEWS = ["login", "link", "forgot", "reset", "note", "signed"] as const;
type View = (typeof VIEWS)[number];

const TITLES: Record<View, string> = { login: "Log in", link: "Email me a link", forgot: "Reset your password", reset: "Choose a new password", note: "", signed: "You're logged in" };
function show(view: View, heading = TITLES[view], text = ""): void {
  VIEWS.forEach((v) => { $(`v-${v}`).hidden = v !== view; });
  $("si-h").textContent = heading;
  $("si-p").textContent = text;
  $("si-p").hidden = !text;
  fail("");
  document.title = `${heading || "Log in"} · MAIZ Agents`;
}
function fail(message: string): void {
  $("si-err").textContent = message;
  $("si-err").hidden = !message;
}
/** Sets one field's validity so screen readers and the red outline agree with the message shown. */
function flag(input: HTMLInputElement, message: string): boolean {
  input.setAttribute("aria-invalid", String(!!message));
  if (message) { fail(message); input.focus(); }
  return !message;
}
async function busy<T>(btn: HTMLElement, work: () => Promise<T>): Promise<T> {
  btn.setAttribute("disabled", "");
  try { return await work(); } finally { btn.removeAttribute("disabled"); }
}

// Emailed links carry their one-time token after the "#", so it never reaches any server except when this
// page posts it to the API. Removing it from the address bar keeps it out of history and screenshots.
const params = new URLSearchParams(location.hash.slice(1));
const magic = params.get("token"), confirm = params.get("confirm"), reset = params.get("reset");
if (magic || confirm || reset) history.replaceState(null, "", location.pathname);

const bindOf = (): string => { try { return localStorage.getItem("maiz.bind") ?? ""; } catch { return ""; } };
async function redeem(path: "/signin/verify" | "/auth/confirm", token: string, retry: string): Promise<void> {
  show("note", "Signing you in…");
  const r = await api<SignedIn & { error?: string }>(path, { body: path === "/auth/confirm" ? { token, bind: bindOf() } : { token } });
  if (!r.ok || !r.data?.token) {
    show("note", "This link didn't work", `${authError(r, "It may have expired or been used already.")} ${retry}`.trim());
    return;
  }
  finishSignIn(r.data);
}

// ---- log in with email and password ----
$<HTMLFormElement>("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("login-email"), pw = $<HTMLInputElement>("login-pw");
  fail("");
  if (!flag(email, EMAIL.test(email.value.trim()) ? "" : "Enter a valid email address.")) return;
  if (!flag(pw, pw.value ? "" : "Enter your password.")) return;
  const r = await busy($("login-go"), () => api<SignedIn & { error?: string }>("/auth/login", { body: { email: email.value.trim(), password: pw.value } }));
  if (r.ok && r.data?.token) { finishSignIn(r.data); return; }
  pw.setAttribute("aria-invalid", "true");
  const hint = r.status === 401 ? " If you've only used email links so far, use “Forgot password?” to choose a password." : "";
  fail(authError(r, "We couldn't log you in. Please try again.") + hint);
  pw.select();
});

// ---- email me a link (fallback, and how accounts made before passwords still work) ----
$<HTMLFormElement>("link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("link-email");
  if (!flag(email, EMAIL.test(email.value.trim()) ? "" : "Enter a valid email address.")) return;
  const r = await busy($("link-go"), () => api<{ devLink?: string }>("/signin/start", { body: { email: email.value.trim() } }));
  if (!r.ok) { fail(authError(r, "Enter a valid email address.")); return; }
  // Development API only: the link comes straight back, so there is no email to wait for.
  if (r.data?.devLink) { void redeem("/signin/verify", r.data.devLink, ""); return; }
  show("note", "Check your email", `If ${email.value.trim()} has an account, a log-in link is on its way. It works once and expires in 15 minutes.`);
});

// ---- forgot password, or choosing one for the first time ----
let resetToken = "";
$<HTMLFormElement>("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("forgot-email");
  if (!flag(email, EMAIL.test(email.value.trim()) ? "" : "Enter a valid email address.")) return;
  const r = await busy($("forgot-go"), () => api<{ devLink?: string }>("/auth/forgot", { body: { email: email.value.trim() } }));
  if (!r.ok) { fail(authError(r, "We couldn't send that. Please try again.")); return; }
  if (r.data?.devLink) { resetToken = r.data.devLink; show("reset"); return; }
  show("note", "Check your email", `If ${email.value.trim()} has an account, a link to choose a new password is on its way. It works once and expires in 30 minutes.`);
});
$<HTMLFormElement>("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $<HTMLInputElement>("reset-pw");
  if (!flag(pw, pw.value.length >= 8 ? "" : "Use at least 8 characters.")) return;
  const r = await busy($("reset-go"), () => api<SignedIn & { error?: string }>("/auth/reset", { body: { token: resetToken, password: pw.value } }));
  if (r.ok && r.data?.token) { finishSignIn(r.data); return; }
  if (r.status === 400 && /link/i.test(r.data?.error ?? "")) { show("note", "This link didn't work", `${r.data!.error} `); return; }
  flag(pw, authError(r, "We couldn't save that password. Please try again."));
});

// ---- navigation between the views, keyed on the address so Back works ----
$("to-link").addEventListener("click", () => { show("link"); $("link-email").focus(); });
const route = () => {
  const view = location.hash === "#forgot" ? "forgot" : "login";
  if (getToken() && view === "login") { show("signed", "You're logged in", "Open your control centre, or log out of this device."); return; }
  show(view);
  if (view === "forgot") { const typed = $<HTMLInputElement>("login-email").value.trim(); if (typed) $<HTMLInputElement>("forgot-email").value = typed; }
};
document.querySelectorAll<HTMLAnchorElement>(".to-login").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); history.replaceState(null, "", location.pathname); show("login"); }));
$("to-forgot").addEventListener("click", (e) => { e.preventDefault(); history.replaceState(null, "", "#forgot"); route(); $("forgot-email").focus(); });
window.addEventListener("hashchange", route);

// Google or Microsoft sent the person back without signing them in. Only these fixed messages exist.
const SOCIAL_ERRORS: Record<string, string> = {
  cancelled: "You cancelled the sign-in. You can try again, or use your email below.",
  failed: "That sign-in didn't complete. Please try again, or use your email below.",
  unverified: "That account's email address isn't verified with the provider, so we can't trust it. Use your email and password instead.",
  owner: "Owner accounts sign in with an emailed link only. Use “Email me a log-in link instead” below.",
};

$("si-out").addEventListener("click", () => { clearSession(); location.reload(); });

if (magic) void redeem("/signin/verify", magic, "Request a new one below.");
else if (confirm) void redeem("/auth/confirm", confirm, "Create your account again to get a new link.");
else if (reset) { resetToken = reset; show("reset"); }
else {
  route();
  const socialError = new URLSearchParams(location.search).get("error");
  if (socialError && Object.hasOwn(SOCIAL_ERRORS, socialError)) {
    history.replaceState(null, "", location.pathname);
    fail(SOCIAL_ERRORS[socialError]!);
  }
  if (!getToken()) void showSocialLogin($("social"), $("social-btns"));
}
