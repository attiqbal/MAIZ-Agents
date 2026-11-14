// Shared bits: sticky nav behaviour, mobile menu, toast.
import { api, clearSession, getToken, setToken } from "./api";
import { initMotion } from "./motion";

export function initNav(): void {
  initMotion();
  // Mark the page we are on, and swap "Sign up / Sign in" for "Dashboard" for a signed-in visitor.
  const here = location.pathname.replace(/\/index\.html$/, "/");
  document.querySelectorAll<HTMLAnchorElement>(".nav-links a, .mobile-menu a").forEach((a) => {
    const target = new URL(a.href, location.origin);
    if (!target.hash && target.pathname === here) a.setAttribute("aria-current", "page");
  });
  if (getToken()) showSignedIn();
  const nav = document.querySelector<HTMLElement>(".nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }
  const toggle = document.querySelector<HTMLButtonElement>(".nav-toggle");
  const menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    const setOpen = (open: boolean) => {
      menu.toggleAttribute("hidden", !open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Menu");
    };
    toggle.addEventListener("click", () => setOpen(menu.hasAttribute("hidden")));
    menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
    // Escape closes the menu and returns focus to the button (WCAG 2.1.2, ECC accessibility skill).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hasAttribute("hidden")) { setOpen(false); toggle.focus(); }
    });
  }
}

/** Initials from an email: "jane.doe@x.com" gives "JD", "atif@x.com" gives "A". */
export function initialsOf(email: string): string {
  const parts = (email.split("@")[0] ?? "").split(/[._\-+\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? "").slice(0, 1);
  return letters ? letters.toUpperCase() : "Me";
}

/** Logged in: hide Sign up / Sign in, show the Dashboard link and the account menu with the person's initials. */
function showSignedIn(): void {
  document.querySelectorAll<HTMLElement>("[data-signed-out]").forEach((el) => { el.hidden = true; });
  document.querySelectorAll<HTMLElement>("[data-signed-in]").forEach((el) => { el.hidden = false; });
  document.querySelectorAll("[data-signout]").forEach((b) => b.addEventListener("click", () => { clearSession(); location.href = "/signin.html"; }));
  void api<{ platformOwner?: boolean; email?: string }>("/me").then((r) => {
    if (!r.ok) return;
    const owner = !!r.data?.platformOwner;
    // The platform owner's Dashboard is the owner admin and has no client settings page.
    if (owner) {
      document.querySelectorAll<HTMLAnchorElement>("[data-dash-href]").forEach((a) => { a.href = "/owner-decisions.html"; });
      document.querySelectorAll<HTMLElement>("[data-acct-settings]").forEach((a) => { a.hidden = true; });
    }
    const email = r.data?.email;
    if (!email) return;
    document.querySelectorAll<HTMLElement>("[data-avatar]").forEach((el) => { el.textContent = initialsOf(email); });
    document.querySelectorAll<HTMLElement>("[data-acct-email]").forEach((el) => { el.textContent = email; });
  });
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  requestAnimationFrame(() => el!.classList.add("show"));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 2200);
}

/** Deterministic decorative QR-like pattern (placeholder until real link tokens exist). */
export function drawPseudoQr(canvas: HTMLCanvasElement, seed: number): void {
  const n = 29;
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = "#0b0c0e";
  const finder = (x: number, y: number) => {
    ctx.fillRect(x, y, 7, 7);
    ctx.fillStyle = "#fff"; ctx.fillRect(x + 1, y + 1, 5, 5);
    ctx.fillStyle = "#0b0c0e"; ctx.fillRect(x + 2, y + 2, 3, 3);
  };
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!inFinder(x, y) && rnd() > 0.52) ctx.fillRect(x, y, 1, 1);
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
}

/**
 * "Continue with Google / Microsoft" buttons, shown only for the providers the server has switched on.
 * They are plain links: the browser goes to the API, which sends it on to the provider and brings it back.
 */
export async function showSocialLogin(box: HTMLElement, buttons: HTMLElement): Promise<boolean> {
  const r = await api<{ providers?: string[] }>("/signin/providers");
  const names: Record<string, string> = { google: "Continue with Google", microsoft: "Continue with Microsoft" };
  const on = (r.data?.providers ?? []).filter((k) => names[k]);
  if (!r.ok || !on.length) return false;
  buttons.innerHTML = on.map((k) => `<a class="btn btn-ghost" href="/api/signin/oauth/${k}/start">${names[k]}</a>`).join("");
  box.hidden = false;
  return true;
}

/** "Show / Hide" buttons on password fields (buttons with data-pw-toggle="<input id>"). */
export function wirePasswordToggles(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>("[data-pw-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.pwToggle!) as HTMLInputElement | null;
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-pressed", String(show));
    });
  });
}

export interface SignedIn { token: string; email: string; hasOrganisation: boolean; platformOwner?: boolean; affiliate?: boolean }

/** Keeps the session from a successful log-in and sends the person where they belong. */
export function finishSignIn(r: SignedIn): void {
  setToken(r.token);
  try {
    const profile = JSON.parse(localStorage.getItem("maiz.profile") ?? "{}");
    localStorage.setItem("maiz.profile", JSON.stringify({ ...profile, email: r.email }));
  } catch { /* storage unavailable */ }
  // The MAIZ platform owner lands on the quality review queue; clients on their control centre, or on setup if they have no team yet.
  location.replace(r.platformOwner ? "/review.html" : r.hasOrganisation ? "/app.html" : r.affiliate ? "/affiliate.html" : "/onboarding.html");
}

/** Plain-words message for a failed auth call. */
export function authError(r: { status: number; data?: any }, fallback: string): string {
  if (r.status === 0) return "We can't reach the service right now. Please try again in a moment.";
  if (r.status === 429) return r.data?.error ?? "Too many tries. Please wait a few minutes and try again.";
  return r.data?.error ?? fallback;
}
