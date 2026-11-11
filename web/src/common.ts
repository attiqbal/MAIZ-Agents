// Shared bits: sticky nav behaviour, mobile menu, toast.
import { getToken } from "./api";

export function initNav(): void {
  // Mark the page we are on, and turn "Log in" into "Open control centre" for a signed-in visitor.
  const here = location.pathname.replace(/\/index\.html$/, "/");
  document.querySelectorAll<HTMLAnchorElement>(".nav-links a, .mobile-menu a").forEach((a) => {
    const target = new URL(a.href, location.origin);
    if (!target.hash && target.pathname === here) a.setAttribute("aria-current", "page");
  });
  if (getToken()) {
    document.querySelectorAll<HTMLAnchorElement>("[data-account-link]").forEach((a) => { a.href = "/app.html"; a.textContent = "Open control centre"; });
  }
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
