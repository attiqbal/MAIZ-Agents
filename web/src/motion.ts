// Small, calm motion helpers: dropdown menus, scroll reveal, sticky sub-nav highlight, edition date.
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initDropdowns(): void {
  const dds = [...document.querySelectorAll<HTMLElement>(".dd")];
  const close = (except?: HTMLElement) => dds.forEach((d) => {
    if (d === except) return;
    d.classList.remove("open");
    d.querySelector(".dd-btn")?.setAttribute("aria-expanded", "false");
  });
  dds.forEach((d) => {
    const btn = d.querySelector<HTMLButtonElement>(".dd-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const open = !d.classList.contains("open");
      close(d);
      d.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  });
  document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".dd")) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const openOne = dds.find((d) => d.classList.contains("open"));
    close();
    openOne?.querySelector<HTMLButtonElement>(".dd-btn")?.focus();
  });
}

/** Elements marked data-reveal fade and rise once as they scroll into view. Elements already on screen are left alone. */
export function initReveal(): void {
  const items = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
  if (!items.length || reduced() || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      (en.target as HTMLElement).classList.add("rv-in");
      io.unobserve(en.target);
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  items.forEach((el, i) => {
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.style.setProperty("--rv-delay", `${(i % 4) * 60}ms`);
    el.classList.add("rv-pre");
    io.observe(el);
  });
}

/** Highlights the sub-nav link of the section that is on screen. */
export function initSubnav(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".subnav a[href^='#']")];
  const pairs = links
    .map((a) => ({ a, el: document.getElementById(a.hash.slice(1)) }))
    .filter((p): p is { a: HTMLAnchorElement; el: HTMLElement } => p.el !== null);
  if (!pairs.length) return;
  // The active link is the last section whose top has passed a line a third of the way down the
  // screen. Above the first section nothing is marked, so the page top never shows a stale state.
  let queued = false;
  const update = (): void => {
    queued = false;
    const line = window.innerHeight * 0.33;
    let current: HTMLAnchorElement | undefined;
    for (const p of pairs) if (p.el.getBoundingClientRect().top <= line) current = p.a;
    for (const p of pairs) {
      p.a.classList.toggle("active", p.a === current);
      if (p.a === current) p.a.setAttribute("aria-current", "location"); else p.a.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}

export function initEditionDate(): void {
  const el = document.getElementById("edition-date");
  if (el) el.textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function initMotion(): void {
  initDropdowns();
  initReveal();
  initSubnav();
  initEditionDate();
}
