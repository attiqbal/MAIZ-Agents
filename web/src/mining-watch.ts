// The weekly check on a Market data dataset: the parts of the screen that show it. The client sees what a week uses
// at most before it is switched on, what changed at the latest check, and a short history of earlier ones.
// Everything shown came from public pages or the server, so it is escaped and links are only ever https.

export interface Watch { since: string; sources: string[]; maxEnergy: number; nextCheckAt: string }
export interface NewItem { title: string; snippet: string; url: string; source: string; at?: string; sourceId: string }
export interface Check { at: string; status: "changed" | "same" | "skipped"; summary: string; energyUsed: number; newItems: NewItem[]; figures: { label: string; from: string; to: string }[]; note?: string }
export interface WatchQuote { id: string; total: number; message: string; sources: string[] }
interface WatchSource { id: string; label: string; energy: number; paid: boolean; available: boolean }
interface WatchedSet { id: string; topic: string; sources: { id: string }[]; watch?: Watch; lastCheck?: Pick<Check, "at" | "status" | "summary"> }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (u: string | undefined): string => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "");
const day = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
const energy = (n: number): string => `${n.toLocaleString("en-GB")} energy`;

/** What a check found, in one line. Never a made-up figure: a check that found nothing says so. */
function outcome(c: Pick<Check, "status" | "summary">): string {
  if (c.status === "changed") return c.summary;
  return c.status === "same" ? "Nothing new since the check before." : "This check did not run.";
}

/** The line on a dataset's card: whether it is checked every week, when next, and what the latest check found. */
export function watchLineHtml(h: WatchedSet): string {
  const on = h.watch
    ? `<p class="mine-watch-on"><span class="badge">Checked every week</span> <span class="small muted">Next check ${esc(day(h.watch.nextCheckAt))}. Uses up to ${esc(energy(h.watch.maxEnergy))} a week, and only for sources that find something.</span></p>`
    : "";
  const last = h.lastCheck ? `<p class="small mine-last"><b>What changed</b> (${esc(day(h.lastCheck.at))}): ${esc(outcome(h.lastCheck))}</p>` : "";
  return `${on}${last}`;
}

/** The button that opens the weekly check box, or stops a check that is on. */
export function watchButtonHtml(h: WatchedSet, open: boolean): string {
  return h.watch
    ? '<button class="btn btn-sm btn-ghost" type="button" data-mine="watch-stop">Stop the weekly check</button>'
    : `<button class="btn btn-sm btn-ghost" type="button" data-mine="watch" aria-expanded="${open ? "true" : "false"}">Check this every week</button>`;
}

/** Choosing where the weekly check looks, then the figure for a week, then the two choices. Nothing is on until "Switch it on". */
export function watchBoxHtml(h: WatchedSet, sources: readonly WatchSource[], quote: WatchQuote | undefined): string {
  const ready = sources.filter((s) => s.available);
  const original = h.sources.map((s) => s.id);
  const ticked = quote?.id === h.id ? quote.sources : original;
  const boxes = ready.map((s) => `<label class="sf-check"><input type="checkbox" name="wsrc" value="${esc(s.id)}"${ticked.includes(s.id) ? " checked" : ""}> ${esc(s.label)} <span class="small muted">(${esc(energy(s.energy))}${s.paid ? ", paid service" : ""})</span></label>`).join("");
  const asked = quote?.id === h.id
    ? `<div class="mine-quote" role="status"><p>${esc(quote.message)}</p><div class="acts"><button class="btn btn-primary btn-sm" type="button" data-mine="watch-yes">Switch it on</button><button class="btn btn-ghost btn-sm" type="button" data-mine="watch-close">Not now</button></div></div>`
    : '<div class="acts"><button class="btn btn-primary btn-sm" type="submit">See what it uses each week</button><button class="btn btn-ghost btn-sm" type="button" data-mine="watch-close">Cancel</button></div>';
  return `<form class="mine-share mine-watch" data-watch="${esc(h.id)}">
    <fieldset><legend class="label">Check "${esc(h.topic)}" every week. Where should it look?</legend>
      <p class="small muted">It starts with the places of your first search. Each week costs the same as a search today, and you only pay for sources that find something. You are told only when something changed.</p>
      ${boxes || '<p class="small muted">No places to search are switched on right now.</p>'}
    </fieldset>${asked}</form>`;
}

function checkHtml(c: Check, latest: boolean): string {
  const items = c.newItems.map((i) => {
    const url = safeUrl(i.url);
    const title = url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : `<b>${esc(i.title)}</b>`;
    return `<li>${title}<span class="small muted">${esc([i.source, i.at ?? ""].filter(Boolean).join(" · "))}</span></li>`;
  }).join("");
  const figures = c.figures.map((f) => `<div class="ubar ubar-2"><span>${esc(f.label)}</span><span class="mono">${esc(f.from)} to ${esc(f.to)}</span></div>`).join("");
  const used = c.status === "skipped" ? "nothing used" : `used ${energy(c.energyUsed)}`;
  if (!latest) return `<li><span class="mono small">${esc(day(c.at))}</span> <span class="small">${esc(outcome(c))}</span> <span class="small muted">${esc(used)}</span></li>`;
  return `<p><b>${esc(day(c.at))}:</b> ${esc(outcome(c))} <span class="small muted">${esc(used)}</span></p>
    ${figures}${items ? `<ul class="mine-items">${items}</ul>` : ""}${c.note ? `<p class="small muted">${esc(c.note)}</p>` : ""}`;
}

/** "What changed" for an opened dataset: the latest check in full, and the earlier ones as a short list. */
export function changedHtml(checks: readonly Check[] | undefined, watched: boolean): string {
  if (!checks?.length) {
    return watched ? '<section class="mine-found mine-changed"><h4>What changed</h4><p class="small muted">No weekly check has run yet. The first one is due a week after you switched it on.</p></section>' : "";
  }
  const [latest, ...earlier] = checks;
  const history = earlier.length ? `<h5 class="small">Earlier checks</h5><ul class="mine-history">${earlier.map((c) => checkHtml(c, false)).join("")}</ul>` : "";
  return `<section class="mine-found mine-changed"><h4>What changed</h4>${checkHtml(latest!, true)}${history}</section>`;
}
