// Shows that the ask bar is working, so a slow answer never looks like a dead button.
// The wording is a pure function so it can be checked without a browser.

/** How long a live answer normally takes before we start explaining the wait (seconds). */
export const SLOW_AFTER_S = 8;
/** After this the AI is probably waking up or busy; we say so and that the answer is still coming (seconds). */
export const VERY_SLOW_AFTER_S = 25;

export function workingMessage(name: string, seconds: number): string {
  if (seconds < SLOW_AFTER_S) return `${name} is on it…`;
  if (seconds < VERY_SLOW_AFTER_S) return `${name} is still working (${seconds}s). Live answers usually take under 20 seconds.`;
  return `${name} is still working (${seconds}s). The AI is waking up, so this one is slower. You can keep using the app and the answer will appear here.`;
}

/** Starts the "working" line under the top bar. Returns a function that clears it. */
export function startWorking(name: string): () => void {
  const el = document.getElementById("ask-status");
  if (!el) return () => undefined;
  const started = Date.now();
  const paint = (): void => { el.textContent = workingMessage(name, Math.floor((Date.now() - started) / 1000)); };
  el.hidden = false;
  paint();
  const timer = window.setInterval(paint, 1000);
  return () => { window.clearInterval(timer); el.hidden = true; el.textContent = ""; };
}
