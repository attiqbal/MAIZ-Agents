// A market data search offered in a conversation or in the ask bar: the quote, "Confirm and start" and "Not now".
// The offer itself is kept by the server with the conversation, so pressing a button sends no topic or figure from
// here. Nothing is looked up and no energy is used until the client confirms.
import { api } from "./api";
import { isBusy, setBusy } from "./keep-focus";

export interface TurnOffer { kind: "mining"; topic: string; sources: string[]; total: number }
export interface TurnLink { href: string; label: string }
interface OfferReply { text: string; status?: string; offer?: TurnOffer; link?: TurnLink }
/** What an ask that became an offer (or a pointer to the store) sends back. */
export interface OfferedAsk { answer?: string; employee?: string; offer?: TurnOffer; link?: TurnLink }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Only a page of this site is ever made into a link. */
const onSite = (href: string | undefined): string => (typeof href === "string" && /^\/[\w\-./#?=&]*$/.test(href) && !href.startsWith("//") ? href : "");

export function linkHtml(link: TurnLink | undefined): string {
  const href = onSite(link?.href);
  return href && link ? `<p class="turn-link"><a class="btn btn-sm btn-ghost" href="${esc(href)}">${esc(link.label)}</a></p>` : "";
}

export function offerButtonsHtml(): string {
  return '<div class="acts turn-offer"><button class="btn btn-primary btn-sm" type="button" data-offer="confirm">Confirm and start</button><button class="btn btn-ghost btn-sm" type="button" data-offer="decline">Not now</button></div>';
}

/** Sends the client's choice. The reply is what the Data mining agent said next, already saved in the conversation. */
export async function answerOffer(action: "confirm" | "decline"): Promise<{ ok: boolean; reply?: OfferReply; error?: string }> {
  const r = await api<{ reply?: OfferReply; error?: string }>(`/mining/chat/${action}`, { body: {} });
  return r.ok && r.data?.reply ? { ok: true, reply: r.data.reply } : { ok: false, error: r.data?.error ?? "That did not go through. Please try again." };
}

function panelHtml(who: string, text: string, offer: boolean, link: TurnLink | undefined, kept = false): string {
  const talk = kept ? '<p class="small muted">This is kept in your <a class="link" href="#chat/data-mining-agent">conversation with the Data mining agent</a>.</p>' : "";
  return `<div class="panel-h"><h2>${esc(who)}</h2>${offer ? '<span class="r">Nothing has started</span>' : ""}</div>
    <div class="preview turn-text">${esc(text)}</div>
    ${offer ? offerButtonsHtml() : ""}${linkHtml(link)}${talk}`;
}

/** Shows an offer (or the note that the agent is not on the team) in the ask bar's answer panel, with its two choices. */
export function showAskOffer(box: HTMLElement, done: OfferedAsk): void {
  const who = done.employee ?? "Data mining agent";
  const text = done.answer ?? "";
  box.setAttribute("role", "status");
  box.innerHTML = panelHtml(who, text, Boolean(done.offer), done.link);
  if (!done.offer) return;
  box.querySelector<HTMLButtonElement>('[data-offer="confirm"]')?.focus();
  box.onclick = async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-offer]");
    if (!b || isBusy(b)) return;
    const action = b.dataset.offer === "confirm" ? "confirm" : "decline";
    box.querySelectorAll<HTMLElement>("[data-offer]").forEach((x) => setBusy(x, true));
    if (action === "confirm") box.querySelector(".preview")?.insertAdjacentHTML("afterend", '<p class="status live wrap" id="offer-wait"><span class="dot"></span>Searching now. This can take up to a minute.</p>');
    const r = await answerOffer(action);
    box.onclick = null;
    if (!r.ok || !r.reply) { box.setAttribute("role", "alert"); box.innerHTML = panelHtml(who, r.error ?? "", false, undefined); return; }
    // A changed figure comes back as a new offer, which is shown with its own two buttons.
    if (r.reply.offer) { showAskOffer(box, { employee: who, answer: r.reply.text, offer: r.reply.offer }); return; }
    box.innerHTML = panelHtml(who, r.reply.text, false, r.reply.link, true);
    box.querySelector<HTMLElement>("a")?.focus();
  };
}
