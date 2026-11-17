import type { Reply, TurnLink, TurnOffer } from "../modules/conversations/index.js";
import { CHAT_DECLINED, CHAT_NOTHING_WAITING, CHAT_NOT_HIRED, DATA_MINING_AGENT, MiningError, offerText, readSearchRequest, sourcesFor, type MiningQuote, type MiningSourceId } from "../modules/data-mining/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

/**
 * Starting a market data search from a conversation (docs/DATA-MINING.md). A message to the Data mining agent, or a
 * clear request typed in the ask bar, is answered with the same quote the Market data screen gives and two choices.
 * Nothing is read and no energy is used until the client confirms. No AI model is involved in any of it.
 */

const json = (status: number, body: unknown): Res => ({ status, body });
const DATA_PREFIX = /^data\s*[:,-]\s*(.+)$/is;
const STORE_LINK: TurnLink = { href: "/app.html#store", label: "Open the store" };
const AGENT_TITLE = "Data mining agent";
/** Clients with a confirmed search starting, so two quick presses of "Confirm and start" cannot both go through. */
const confirming = new Set<string>();

/** What an ask that was handled here sends back: the shape of any finished ask, plus the offer or link to show. */
export interface MinedAsk { status: "ready_for_review"; answer: string; checked: false; energyUsed: 0; employee: string; offer?: TurnOffer; link?: TurnLink }

interface Asked { text: string; emp: { id: string; templateKey: string }; bar: boolean }

function offerFrom(quote: MiningQuote): TurnOffer {
  return { kind: "mining", topic: quote.topic, sources: quote.sources.filter((s) => s.available).map((s) => s.id), total: quote.total };
}

/** The quote as a reply, or a plain note when nothing in it can be read right now. */
function quoteReply(quote: MiningQuote, mention: readonly MiningSourceId[], lead = ""): Reply {
  if (!quote.sources.some((s) => s.available)) return { text: `Nothing can be looked up for that right now. ${quote.sources.map((s) => s.reason).join(" ")}`, status: "answered" };
  return { text: `${lead}${offerText(quote, mention)}`, status: "answered", offer: offerFrom(quote) };
}

/**
 * Looks at an ask before it goes to an employee. Returns a finished reply when it is a request to look up public
 * data (the quote, kept in the Data mining agent's conversation), or when the client asked for the agent and has not
 * hired it. Returns undefined for everything else, which is then answered exactly as before.
 *
 * Only two kinds of ask are looked at: one sent to the Data mining agent, and one typed in the ask bar with no
 * employee chosen (`bar`). A conversation with any other employee is never taken over.
 */
export function miningAsk(p: Platform, userId: string, workspaceId: string, ask: Asked): MinedAsk | undefined {
  const toAgent = ask.emp.templateKey === DATA_MINING_AGENT;
  if (!toAgent && !ask.bar) return undefined;
  const prefixed = toAgent ? null : DATA_PREFIX.exec(ask.text);
  const request = readSearchRequest(prefixed ? prefixed[1]! : ask.text, toAgent || prefixed ? "addressed" : "open");
  const agent = p.workforce.team(userId, workspaceId).find((e) => e.templateKey === DATA_MINING_AGENT);
  if (!agent) {
    if (!prefixed && !request) return undefined;
    return { status: "ready_for_review", answer: CHAT_NOT_HIRED, checked: false, energyUsed: 0, employee: AGENT_TITLE, link: STORE_LINK };
  }
  if (!request) return undefined;
  let reply: Reply;
  try {
    const wanted = sourcesFor(request);
    const quote = p.mining.quote(userId, workspaceId, { topic: request.topic, sources: wanted });
    // The usual places are only offered when they can be read; a place the client named is mentioned when it cannot.
    const shown = request.named.length ? quote : { ...quote, sources: quote.sources.filter((s) => s.available), unavailable: [] };
    reply = quoteReply(shown.sources.length ? shown : quote, request.named);
  } catch (e) {
    if (!(e instanceof MiningError)) throw e;
    reply = { text: e.message, status: "answered" };
  }
  p.conversations.record(userId, workspaceId, agent.id, ask.text, reply);
  return { status: "ready_for_review", answer: reply.text, checked: false, energyUsed: 0, employee: agent.name, ...(reply.offer ? { offer: reply.offer } : {}) };
}

/** How long a quoted search can be confirmed. */
const OFFER_LIFETIME_MS = 30 * 60_000;

/** The offer waiting in the Data mining agent's conversation: only the last thing said counts, so an old one cannot be confirmed later. */
function waiting(p: Platform, userId: string, workspaceId: string): { agentId: string; offer: TurnOffer } {
  const agent = p.workforce.team(userId, workspaceId).find((e) => e.templateKey === DATA_MINING_AGENT);
  const last = agent ? p.conversations.thread(userId, workspaceId, agent.id).at(-1) : undefined;
  if (!agent || last?.role !== "employee" || last.offer?.kind !== "mining") throw new MiningError(CHAT_NOTHING_WAITING);
  // An offer is for the next few minutes, not for a click days later.
  if (p.now().getTime() - Date.parse(last.at) > OFFER_LIFETIME_MS) throw new MiningError(CHAT_NOTHING_WAITING);
  return { agentId: agent.id, offer: last.offer };
}

/** Runs the search the client confirmed, with the figure they were shown. A changed figure is shown again instead of charged. */
async function confirm(p: Platform, userId: string, workspaceId: string, offer: TurnOffer): Promise<Reply> {
  try {
    const dataset = await p.mining.run(userId, workspaceId, { topic: offer.topic, sources: offer.sources, confirm: true, confirmEnergy: offer.total });
    return {
      text: `Done. That used ${dataset.energyUsed} energy.\n${dataset.summary}`, status: "answered",
      link: { href: `/app.html#mining/${dataset.id}`, label: "Open this dataset on Market data" },
    };
  } catch (e) {
    if (!(e instanceof MiningError)) throw e;
    if (e.quote) return quoteReply(e.quote, e.quote.unavailable, "The figure has changed since I asked, so nothing has started. ");
    // Nothing found, too little energy, a search already running: said in the conversation, in the service's own words.
    return { text: e.message, status: "failed" };
  }
}

/** The two choices under an offer. Both are the signed-in person's own workspace; permissions are checked in the services. */
export async function miningChatRoute(req: Req, userId: string, p: Platform, workspaceId: string): Promise<Res> {
  if (req.method !== "POST") return json(404, { error: "not found" });
  if (req.path === "/api/mining/chat/confirm") {
    const { agentId, offer } = waiting(p, userId, workspaceId);
    if (confirming.has(workspaceId)) throw new MiningError("That search is already starting. Give it a moment.");
    confirming.add(workspaceId);
    try {
      const reply = await confirm(p, userId, workspaceId, offer);
      const turn = p.conversations.record(userId, workspaceId, agentId, "Confirm and start", reply);
      return json(200, { reply: turn, team: p.energy.teamEnergyOf(workspaceId) ?? null });
    } finally {
      confirming.delete(workspaceId);
    }
  }
  if (req.path === "/api/mining/chat/decline") {
    const { agentId } = waiting(p, userId, workspaceId);
    const turn = p.conversations.record(userId, workspaceId, agentId, "Not now", { text: CHAT_DECLINED, status: "answered" });
    return json(200, { reply: turn });
  }
  return json(404, { error: "not found" });
}
