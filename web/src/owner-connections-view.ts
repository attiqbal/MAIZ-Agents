// What the Connections page draws: the list of services on the left and the one selected service on the right.
// Everything here is a plain function from data to HTML, and every piece of data goes through esc(). Nothing in
// this file knows a service by name: it draws whatever the server lists, from its tier, its mode and its status.
import { esc } from "./owner-common";
import type { GuideStep } from "../../src/modules/connections/catalog";
import { TIER_ABOUT, TIER_LABEL, TIER_ORDER, type Mode, type Tier } from "../../src/modules/connections/tiers";

export interface Field { key: string; label: string; help: string; secret: boolean; required: boolean; placeholder?: string; generate?: boolean; set: boolean; value?: string; fallback?: string; changedAt?: string }
export interface TestResult { ok: boolean; message: string; details: string[]; at: string }
export interface Conn {
  key: string; title: string; summary: string; group: "social" | "messaging" | "clients" | "platform"; usedBy: string[];
  tier: Tier; tierWhy: string; mode: Mode; changedAt?: string;
  editable: boolean; status: "connected" | "not_connected" | "error"; source: "browser" | "server" | "none"; statusText: string; missing: string[];
  canTest: boolean; lastTest?: TestResult; fields: Field[]; guide: GuideStep[];
  webhook?: { callbackUrl: string; verifyToken?: string; seenAt?: string };
  copies?: { label: string; value: string }[]; clientsSee?: string;
}
export interface Person { name: string; avatar: string; initials: string }

/** What the owner has to know about a service at a glance. */
export type State = "failed" | "todo" | "waiting" | "working" | "manual";
export type Filter = "all" | "needs" | "working" | "waiting" | "manual";

export function stateOf(c: Conn): State {
  if (c.status === "error") return "failed";
  if (c.mode === "manual") return "manual";
  if (c.mode === "approval") return "waiting";
  return c.status === "connected" ? "working" : "todo";
}
/** What needs the owner comes first; what nobody can connect comes last. */
const STATE_RANK: Record<State, number> = { failed: 0, todo: 1, waiting: 2, working: 3, manual: 4 };
export const stateWords = (c: Conn): string => {
  const s = stateOf(c);
  if (s === "failed") return "Failed";
  if (s === "todo") return "Not set up";
  if (s === "waiting") return "Waiting for approval";
  if (s === "manual") return "Used by hand";
  return c.lastTest?.ok ? "Working" : "Connected, not tested";
};
export const matchesFilter = (c: Conn, f: Filter): boolean => {
  const s = stateOf(c);
  return f === "all" || (f === "needs" ? s === "failed" || s === "todo" : s === f);
};
export const matchesQuery = (c: Conn, q: string): boolean => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${c.title} ${c.summary} ${stateWords(c)} ${TIER_LABEL[c.tier]}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};
/** One tier's services, sorted so what needs the owner is at the top. The server's order breaks ties. */
export const inTier = (all: Conn[], tier: Tier): Conn[] =>
  all.map((c, i) => ({ c, i })).filter((x) => x.c.tier === tier).sort((a, b) => STATE_RANK[stateOf(a.c)] - STATE_RANK[stateOf(b.c)] || a.i - b.i).map((x) => x.c);
/** Every service in the order the list shows them. */
export const sorted = (all: Conn[]): Conn[] => TIER_ORDER.flatMap((t) => inTier(all, t));

export const when = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** "Sign in with Google" stays as it is; "Xero (clients' accounts)" becomes "Xero". */
export const shortTitle = (c: Conn): string => c.title.replace(/\s*\([^)]*\)\s*$/, "");

const BADGE: Record<State, string> = { failed: "cx-error", todo: "cx-not_connected", waiting: "cxm-b-waiting", working: "cx-connected", manual: "cxm-b-manual" };
export const stateBadge = (c: Conn): string => `<span class="cx-badge ${BADGE[stateOf(c)]}"><span class="dot" aria-hidden="true"></span>${esc(stateWords(c))}</span>`;

// ------------------------------------------------------------ the summary and the list

function countWords(list: Conn[]): string {
  const by = (s: State) => list.filter((c) => stateOf(c) === s).length;
  const canConnect = list.length - by("waiting") - by("manual");
  const extra = [by("waiting") ? `${by("waiting")} waiting for approval` : "", by("manual") ? `${by("manual")} used by hand` : ""].filter(Boolean);
  const main = canConnect ? `${by("working")} of ${canConnect} working` : "None can be connected yet";
  return extra.length ? `${main}, ${extra.join(", ")}` : main;
}

const nameLinks = (list: Conn[]): string => {
  const first = list.slice(0, 3).map((c) => `<a href="#c-${esc(c.key)}">${esc(shortTitle(c))}</a>`);
  const rest = list.length - first.length;
  return listWords(rest > 0 ? [...first, `${rest} more`] : first);
};

/** One sentence that says what to do next, then one line of counts for each tier. */
export function summaryHtml(all: Conn[]): string {
  const needs = (t: Tier) => inTier(all, t).filter((c) => matchesFilter(c, "needs"));
  const crit = needs("critical"), must = needs("must"), opt = needs("optional");
  const next = crit.length ? `<b>${plural(crit.length, "critical service needs", "critical services need")} you:</b> ${nameLinks(crit)}. Start there: the site cannot do its basic job without ${crit.length === 1 ? "it" : "them"}.`
    : must.length ? `Everything critical is working. <b>Next, ${plural(must.length, "must-have service needs", "must-have services need")} you:</b> ${nameLinks(must)}.`
    : opt.length ? `Everything critical and must-have is working. ${plural(opt.length, "optional service is", "optional services are")} not set up. Add them when you want them.`
    : "Everything that can be connected is working. Nothing needs you.";
  const untested = all.filter((c) => stateOf(c) === "working" && !c.lastTest?.ok).length;
  return `<p class="cxm-next">${next}${untested ? ` ${plural(untested, "service is", "services are")} saved but not tested yet.` : ""}</p>
    <ul class="cxm-counts">${TIER_ORDER.map((t) => `<li><b>${TIER_LABEL[t]}</b> <span class="tnum">${esc(countWords(inTier(all, t)))}</span></li>`).join("")}</ul>`;
}

const row = (c: Conn, selected: string | undefined): string => `<li><a class="cxm-row" href="#c-${esc(c.key)}"${c.key === selected ? ' aria-current="true"' : ""}>
  <span class="cxm-dot cxm-d-${stateOf(c)}" aria-hidden="true"></span><span class="cxm-name">${esc(c.title)}</span><span class="cxm-st">${esc(stateWords(c))}</span></a></li>`;

/** The three groups. `shown` picks the rows (search and filter); a group with no rows left is not drawn. */
export function listHtml(all: Conn[], shown: (c: Conn) => boolean, selected: string | undefined, open: ReadonlySet<Tier>): string {
  const groups = TIER_ORDER.map((t) => {
    const everyone = inTier(all, t), rows = everyone.filter(shown);
    if (!rows.length) return "";
    return `<details class="cxm-group" data-tier="${t}"${open.has(t) ? " open" : ""}>
      <summary><h2 class="cxm-gh">${TIER_LABEL[t]}</h2><span class="cxm-gc tnum">${esc(countWords(everyone))}</span></summary>
      <p class="cxm-about">${esc(TIER_ABOUT[t])}</p>
      <ul class="cxm-rows">${rows.map((c) => row(c, selected)).join("")}</ul></details>`;
  }).join("");
  return groups || `<div class="cxm-none"><p>No service matches. Try another word, or show every service again.</p><button type="button" class="btn btn-ghost btn-sm" data-reset="1">Show every service</button></div>`;
}

// ------------------------------------------------------------ the selected service

export interface DetailUi {
  /** Fields the owner opened with Change, on a service that is already set up. */
  editing: ReadonlySet<string>;
  /** The "are you sure" step for Disconnect is open. */
  confirm: boolean;
  /** What the owner has typed and not saved yet, by field. Kept in memory only. */
  drafts: Readonly<Record<string, string>>;
  ticks: Readonly<Record<string, boolean>>;
  people: Readonly<Record<string, Person>>;
}

const personName = (key: string, people: DetailUi["people"]): string => people[key]?.name ?? key.replace(/-/g, " ").replace(/^./, (ch) => ch.toUpperCase());

function usedByLine(c: Conn, ui: DetailUi): string {
  const who = [...(c.group === "clients" ? ["Your clients"] : []), ...c.usedBy.map((k) => personName(k, ui.people))];
  const faces = c.usedBy.map((k) => ui.people[k]).filter((p): p is Person => !!p);
  return `<div class="cx-askers">${faces.map((p) => `<span class="av av-sm ${esc(p.avatar)}" aria-hidden="true">${esc(p.initials)}</span>`).join("")}<span class="small muted"><b>Who uses it:</b> ${esc(who.length ? listWords(who) : "The whole site")}</span></div>`;
}

/** The team member who needs this service says so, in their own words. Only for members of the owner's own team. */
function bubble(c: Conn, ui: DetailUi): string {
  const who = c.usedBy.map((k) => ui.people[k]).filter((p): p is Person => !!p);
  const me = who[0];
  if (!me) return "";
  const s = stateOf(c), name = shortTitle(c);
  const words = s === "failed" ? `${name} has stopped working for me. Please read what went wrong below, fix it and test it again.`
    : s === "working" ? `Thank you. ${name} is connected and I am using it.`
    : s === "manual" ? `There is nothing to connect for ${name}. I tell you what to look for, and you do that part by hand.`
    : c.mode === "server" ? `I need ${name}, but it is set on the server, not on this page. The steps below say where.`
    : `I need ${name} from you before I can do this part of my job. Follow the steps below, press Save, then Test connection.`;
  return `<div class="asks cxm-asks${s === "working" ? " asks-done" : ""}"><span class="av av-lg ${esc(me.avatar)}" aria-hidden="true">${esc(me.initials)}</span>
    <div class="ask-bubble"><p><b>${esc(me.name)}:</b> ${esc(words)}</p>${who.length > 1 ? `<p class="small muted">${esc(listWords(who.slice(1).map((p) => p.name)))} ${who.length > 2 ? "need" : "needs"} it too.</p>` : ""}</div></div>`;
}

/** The honest note for a service that is not simply "type it in here". */
function modeNote(c: Conn): string {
  const name = shortTitle(c);
  if (c.mode === "approval") return `<div class="cxm-note"><h3>Waiting for the provider's approval</h3><p>Nobody can connect ${esc(name)} yet. The provider has to approve the MAIZ app first, and only you can ask for that. What you have to send, and where, is in the steps below. Until it is approved, clients can link it through Zapier or Make.</p></div>`;
  if (c.mode === "manual") return `<div class="cxm-note"><h3>Used by hand</h3><p>There is no way to connect ${esc(name)}, so there is nothing to type here. What your team does instead: ${esc(c.guide[0]?.text ?? "you use it yourself and paste the result into the draft.")}</p></div>`;
  if (c.mode === "server") return `<div class="cxm-note"><h3>Set on the server</h3><p>${esc(name)} is kept in the server's own settings, not on this page${c.fields.length ? ". To manage it here instead, the server setting has to be removed first" : ", on purpose: a mistake here costs money"}. You can still see whether it works and test it here.</p></div>`;
  return "";
}

function failedNote(c: Conn): string {
  if (stateOf(c) !== "failed" || !c.lastTest) return "";
  const tips = [
    ...(c.editable ? ["Check each detail was copied in full, with no spaces or missing letters. Press Change next to the one that looks wrong and paste it again."] : []),
    "Press Test connection again. Some services need a minute after a change.",
    "If it worked before, the code may have run out or been withdrawn. Make a new one at the provider" + (c.editable ? " and save it here." : " and ask for it to be replaced on the server."),
  ];
  const t = c.lastTest;
  return `<div class="cxm-note cxm-note-bad"><h3>Failed</h3><p><b>What went wrong:</b> ${esc(t.message)}</p>${t.details.length ? `<ul>${t.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
    <p><b>What to try:</b></p><ul>${tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="small muted">Tested ${esc(when(t.at))}</p></div>`;
}

function lastTest(c: Conn): string {
  const t = c.lastTest;
  if (!t) return c.status === "connected" ? `<p class="cx-result cx-untested">Saved, not tested yet. Press <b>Test connection</b> to check it with the service.</p>` : "";
  return `<div class="cx-result ${t.ok ? "cx-ok" : "cx-bad"}"><p><b>${t.ok ? "Last test: it works." : "Last test: not working."}</b> ${esc(t.message)}</p>
    ${t.details.length ? `<ul>${t.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}<p class="small muted">Tested ${esc(when(t.at))}</p></div>`;
}

function steps(c: Conn, ui: DetailUi): string {
  return `<ol class="cx-steps">${c.guide.map((g, i) => {
    const id = `${c.key}:${i}`;
    return `<li><label class="cx-tick"><input type="checkbox" data-step="${esc(id)}"${ui.ticks[id] ? " checked" : ""}><span class="cx-n" aria-hidden="true">${i + 1}</span><span class="cx-txt">${esc(g.text)}</span></label>
      ${g.link ? `<a class="cx-link" href="${esc(g.link.href)}" target="_blank" rel="noopener noreferrer">${esc(g.link.label)}<span class="sr-only"> (opens in a new tab)</span> ↗</a>` : ""}</li>`;
  }).join("")}</ol>`;
}

function guide(c: Conn, ui: DetailUi): string {
  if (!c.guide.length) return "";
  const s = stateOf(c);
  const title = c.mode === "approval" ? "What to send to the provider, and where" : c.mode === "server" ? "Where this is set, and how" : c.mode === "manual" ? "More about this" : s === "todo" ? "Set it up, step by step" : "Steps and details";
  const done = c.guide.filter((_, i) => ui.ticks[`${c.key}:${i}`]).length;
  const open = (s === "todo" && c.editable) || c.mode === "approval";
  return `<details class="cx-setup"${open ? " open" : ""}><summary>${title} <span class="muted small">${plural(c.guide.length, "step", "steps")}${done ? `, ${done} ticked` : ""}</span></summary>${steps(c, ui)}</details>`;
}

function inputHtml(c: Conn, f: Field, ui: DetailUi, changing: boolean): string {
  const id = `f-${c.key}-${f.key}`;
  const saved = f.secret && f.set;
  const ph = saved ? "Leave empty to keep the saved one" : f.fallback ?? f.placeholder ?? "";
  const value = ui.drafts[f.key] ?? (f.secret ? "" : f.value ?? "");
  const label = changing ? `New value for: ${f.label}` : f.label;
  return `<div class="field${f.generate ? " cx-wide" : ""}"><label for="${esc(id)}">${esc(label)}${f.required || changing ? "" : ' <span class="muted">(optional)</span>'}</label>
    <div class="cx-inrow"><input class="input" id="${esc(id)}" name="${esc(f.key)}" ${f.secret ? 'type="password" autocomplete="new-password"' : 'type="text" autocomplete="off"'} spellcheck="false" value="${esc(value)}" placeholder="${esc(ph)}" aria-describedby="${esc(id)}-h" maxlength="1000">
    ${f.generate ? `<button type="button" class="btn btn-ghost btn-sm" data-gen="${esc(id)}">Make one for me</button>` : ""}
    ${changing ? `<button type="button" class="btn btn-quiet btn-sm" data-cancel="${esc(f.key)}">Cancel<span class="sr-only"> changing ${esc(f.label)}</span></button>` : ""}</div>
    <span class="hint" id="${esc(id)}-h">${esc(f.help)}</span></div>`;
}

/** One saved detail: that it is saved (never the secret itself), when it last changed, and Change. */
function savedRow(c: Conn, f: Field, ui: DetailUi): string {
  const shown = f.set ? (f.secret ? `<span class="cx-saved">Saved</span> <span class="muted">Hidden for safety. It is never shown again.</span>` : `<code>${esc(f.value ?? "")}</code>`)
    : f.fallback ? `<span class="muted">${esc(f.fallback)}</span>` : `<span class="muted">${f.required ? "Not saved yet. It is needed." : "Not saved. It is optional."}</span>`;
  const editing = ui.editing.has(f.key);
  return `<li class="cxm-f"><div class="cxm-f-top"><div class="cxm-f-what"><span class="cxm-f-l">${esc(f.label)}</span><span class="cxm-f-v">${shown}</span>
      ${f.set && f.changedAt ? `<span class="small muted">Last changed ${esc(when(f.changedAt))}</span>` : ""}</div>
    <div class="cxm-f-acts">${editing ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-change="${esc(f.key)}">${f.set ? "Change" : "Add"}<span class="sr-only"> ${esc(f.label)}</span></button>`}
      ${f.set && !f.required && !editing ? `<button type="button" class="btn btn-quiet btn-sm" data-clear="${esc(f.key)}">Remove<span class="sr-only"> ${esc(f.label)}</span></button>` : ""}</div></div>
    ${editing ? inputHtml(c, f, ui, true) : ""}</li>`;
}

function webhookBox(c: Conn): string {
  const w = c.webhook;
  if (!w) return "";
  const line = (label: string, value: string | undefined, id: string) => `<div class="cx-copy"><span class="cx-copy-k">${esc(label)}</span>
    ${value ? `<code id="${id}">${esc(value)}</code><button type="button" class="btn btn-ghost btn-sm" data-copy="${id}">Copy<span class="sr-only"> ${esc(label)}</span></button>` : `<span class="muted small">Save a verify token above first, then copy it from here.</span>`}</div>`;
  return `<div class="cx-hook"><h3 class="small">For the provider's webhook screen (the address it calls when a message arrives)</h3>
    ${line("Callback URL", w.callbackUrl, "wh-url")}${c.source === "server" ? `<p class="small muted">The verify token is set on the server.</p>` : line("Verify token", w.verifyToken, "wh-tok")}
    <p class="small ${w.seenAt ? "cx-ok-t" : "muted"}">${w.seenAt ? `The provider reached this address at ${esc(when(w.seenAt))}.` : "The provider has not reached this address since the server last started."}</p></div>`;
}

/** Addresses to paste into the provider's own screens. */
function copiesBox(c: Conn): string {
  if (!c.copies?.length) return "";
  return `<div class="cx-hook"><h3 class="small">Paste into ${esc(shortTitle(c).replace(/^Sign in with /, ""))}'s settings</h3>
    ${c.copies.map((x, i) => `<div class="cx-copy"><span class="cx-copy-k">${esc(x.label)}</span><code id="cp-${esc(c.key)}-${i}">${esc(x.value)}</code><button type="button" class="btn btn-ghost btn-sm" data-copy="cp-${esc(c.key)}-${i}">Copy<span class="sr-only"> ${esc(x.label)}</span></button></div>`).join("")}</div>`;
}

/** What stops working if the owner disconnects, for the confirm step. */
function whatStops(c: Conn, ui: DetailUi): string[] {
  const out: string[] = [];
  if (c.clientsSee) out.push(`Your clients lose this: ${c.clientsSee}`);
  if (c.usedBy.length) out.push(`${listWords(c.usedBy.map((k) => personName(k, ui.people)))} can no longer use it.`);
  if (!out.length) out.push(`This stops: ${c.summary}`);
  return [...out, "The saved details are removed from MAIZ at once. To bring it back you type them in again."];
}

function confirmBox(c: Conn, ui: DetailUi): string {
  return `<div class="cxm-confirm" role="group" aria-labelledby="cxm-dc-h"><h3 id="cxm-dc-h" tabindex="-1">Disconnect ${esc(shortTitle(c))}?</h3>
    <ul>${whatStops(c, ui).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    <div class="acts"><button type="button" class="btn btn-primary" data-disconnect-yes="1">Yes, disconnect</button><button type="button" class="btn btn-ghost" data-disconnect-no="1">Keep it connected</button></div></div>`;
}

function actions(c: Conn, ui: DetailUi, setUp: boolean): string {
  const canAct = c.mode === "editable" || c.mode === "server";
  const saving = c.editable && (!setUp || ui.editing.size > 0);
  return `<div class="acts">
      ${saving ? `<button type="submit" class="btn btn-primary">${setUp ? "Save changes" : "Save"}</button>` : ""}
      ${canAct && c.canTest && c.status !== "not_connected" ? `<button type="button" class="btn ${saving ? "btn-ghost" : "btn-primary"}" data-test="1">Test connection</button>` : ""}
      ${c.webhook && c.status !== "not_connected" ? `<button type="button" class="btn btn-ghost" data-sendtest="1">Send test WhatsApp message</button>` : ""}
      ${c.editable && c.source === "browser" && !ui.confirm ? `<button type="button" class="btn btn-quiet" data-disconnect="1">Disconnect</button>` : ""}
      <span class="muted small" id="m-${esc(c.key)}"></span></div>
    ${ui.confirm ? confirmBox(c, ui) : ""}`;
}

function formHtml(c: Conn, ui: DetailUi): string {
  const setUp = c.source === "browser";
  if (!c.editable) return actions(c, ui, setUp);
  const fields = !c.fields.length ? ""
    : setUp ? `<h3 class="cxm-h3">Saved details</h3><ul class="cxm-saved">${c.fields.map((f) => savedRow(c, f, ui)).join("")}</ul>`
    : `<h3 class="cxm-h3">Details to paste in</h3><div class="ow-grid cx-fields">${c.fields.map((f) => inputHtml(c, f, ui, false)).join("")}</div>`;
  return `<form class="cx-form" data-form="${esc(c.key)}" novalidate>${fields}${copiesBox(c)}${webhookBox(c)}${actions(c, ui, setUp)}</form>`;
}

/** The one selected service: what it is for, who uses it, how it is doing, how to set it up, and what can be done. */
export function detailHtml(c: Conn, ui: DetailUi): string {
  const k = esc(c.key);
  return `<article class="panel cx-card cxm-card" id="c-${k}" aria-labelledby="c-${k}-h">
    <a class="cxm-back" href="#services">&larr; All services</a>
    <div class="cx-top"><div class="cx-title"><h2 id="c-${k}-h" tabindex="-1">${esc(c.title)}</h2><p class="muted">${esc(c.summary)}</p></div>${stateBadge(c)}</div>
    <p class="cxm-tier"><span class="badge badge-dark">${TIER_LABEL[c.tier]}</span> ${esc(c.tierWhy)}</p>
    ${usedByLine(c, ui)}
    ${c.clientsSee ? `<p class="cx-sees small"><b>What your clients get:</b> ${esc(c.clientsSee)}</p>` : ""}
    ${bubble(c, ui)}
    <h3 class="cxm-h3">How it is doing</h3>
    <p class="cx-state">${esc(c.statusText)}${c.missing.length && c.status === "not_connected" && c.mode !== "approval" && c.mode !== "manual" ? ` Still needed: ${esc(c.missing.join(", "))}.` : ""}${c.changedAt ? ` Details last changed ${esc(when(c.changedAt))}.` : ""}</p>
    ${modeNote(c)}${stateOf(c) === "failed" ? failedNote(c) : lastTest(c)}
    ${guide(c, ui)}
    ${formHtml(c, ui)}
  </article>`;
}
