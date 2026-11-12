// Scripted, simulated walkthrough: a request becomes finished work that waits for the owner's approval.
// Nothing here talks to the server. All text is set with textContent.
interface Step { who: string; av: string; cls: string; text: string; pill: string; state: "live" | "done" | ""; }

const STEPS: Step[] = [
  { who: "You", av: "YOU", cls: "av-me", text: "Prepare a marketing campaign for our Christmas promotion.", pill: "Request", state: "" },
  { who: "Admin manager", av: "AM", cls: "av-tl", text: "On it. I'm bringing in Marketing and Compliance.", pill: "Delegated", state: "done" },
  { who: "Marketing manager", av: "MM", cls: "av-mm", text: "Drafting a three-week content calendar and three posts.", pill: "Working", state: "live" },
  { who: "Compliance manager", av: "CM", cls: "av-cm", text: "Checking the wording against advertising rules.", pill: "Checking", state: "live" },
  { who: "Quality check", av: "QC", cls: "av-bc", text: "Passed. The campaign is ready for you.", pill: "Done", state: "done" },
];
const STEP_MS = 1300;

export function initDemoStage(): void {
  const root = document.getElementById("demo");
  const feed = document.getElementById("demo-feed");
  const approve = document.getElementById("demo-approve");
  const replay = document.getElementById("demo-replay");
  if (!root || !feed || !approve || !replay) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timers: number[] = [];

  const row = (s: Step): HTMLLIElement => {
    const li = document.createElement("li");
    const av = document.createElement("span");
    av.className = `av ${s.cls}`;
    av.textContent = s.av;
    av.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = s.who;
    body.append(b, document.createTextNode(s.text));
    const pill = document.createElement("span");
    pill.className = "pill" + (s.state ? ` ${s.state}` : "");
    pill.textContent = s.pill;
    li.append(av, body, pill);
    return li;
  };
  const showApproval = () => { approve.hidden = false; approve.querySelector("button")?.focus({ preventScroll: true }); };
  const reset = () => { timers.forEach(clearTimeout); timers = []; feed.replaceChildren(); approve.hidden = true; };

  const play = (instant: boolean) => {
    reset();
    STEPS.forEach((s, i) => {
      const add = () => { feed.append(row(s)); if (i === STEPS.length - 1) showApproval(); };
      if (instant) add(); else timers.push(window.setTimeout(add, i * STEP_MS));
    });
  };

  approve.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => {
    approve.hidden = true;
    const approved = btn.dataset.act === "approve";
    feed.append(row({ who: "You", av: "YOU", cls: "av-me", text: approved ? "Approved. Ready to publish." : "Redo, please make it shorter.", pill: approved ? "Approved" : "Redo", state: "done" }));
  }));
  replay.addEventListener("click", () => play(false));

  if (reduced || !("IntersectionObserver" in window)) { play(true); return; }
  const io = new IntersectionObserver((en) => { if (en[0]?.isIntersecting) { io.disconnect(); play(false); } }, { threshold: 0.35 });
  io.observe(root);
}
