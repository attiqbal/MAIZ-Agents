// Register your interest (register-interest.html): the pre-launch mailing list. The server stores the person and
// emails a thank-you; this page only sends the form and shows the answer.
import "./styles.css";
import { initNav } from "./common";

initNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const form = $<HTMLFormElement>("in-form");
const err = $("in-err");
const showError = (m: string): void => { err.textContent = m; err.hidden = false; };

// The page the visitor came from (a same-site path only), so the owner can see which page works.
const from = (() => { try { const u = new URL(document.referrer); return u.origin === location.origin ? u.pathname : "/"; } catch { return "/"; } })();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  const v = (id: string) => $<HTMLInputElement | HTMLTextAreaElement>(id).value.trim();
  if (!v("in-name")) { showError("Please tell us your name."); $("in-name").focus(); return; }
  if (!EMAIL.test(v("in-email"))) { showError("Please enter a valid email address."); $("in-email").focus(); return; }
  const go = $<HTMLButtonElement>("in-go");
  go.disabled = true;
  go.textContent = "Sending...";
  try {
    const res = await fetch("/api/interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: v("in-name"), email: v("in-email"), business: v("in-business"), need: v("in-need"), source: from, company_site: v("in-site") }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      showError(body.error ?? "Something went wrong. Please try again in a moment.");
      return;
    }
    form.hidden = true;
    $("in-thanks").hidden = false;
    $("in-thanks-h").focus();
  } catch {
    showError("We could not reach the server. Please check your connection and try again.");
  } finally {
    go.disabled = false;
    go.textContent = "Register your interest";
  }
});
