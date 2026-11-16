// Teammates in the control centre (docs/TEAMMATES.md).
// 1. The "People with access" panel in Settings: the owner invites people, picks what each can do, and removes them.
// 2. What a person who is not the owner sees: the business and their role in the sidebar, and a short reason beside
//    each thing only the owner (or a manager) can do. The server decides on every request; this only explains.
import { api } from "./api";
import { toast } from "./common";
import { isBusy, keepFocus, setBusy } from "./keep-focus";

export type Role = "owner" | "admin" | "member" | "viewer";
interface Person { userId: string; email: string; role: Role; roleLabel: string; you: boolean }
interface InviteRow { id: string; email: string; roleLabel: string; status: string; lastSentAt: string; expiresAt: string }
interface RoleChoice { role: Exclude<Role, "owner">; label: string; can: string }
interface Team {
  businessName: string; canManage: boolean;
  you: { email: string; role: Role; roleLabel: string; can: string };
  owner: { email: string };
  members?: Person[]; invites?: InviteRow[]; limit?: number; roles?: RoleChoice[];
  devLink?: string; error?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Manager", member: "Team member", viewer: "View only" };
const VIEW_ONLY = "You have view-only access, so you can look but not change anything.";

let team: Team | undefined;
let confirming: string | undefined; // the person the owner is about to remove
let message = "";
let devLink = "";

// ---------------------------------------------------------------- the Settings panel

function memberRow(m: Person, roles: RoleChoice[]): string {
  const who = `<div class="pa-who"><b>${esc(m.email)}</b><span>${esc(m.roleLabel)}${m.you ? " · You" : ""}</span></div>`;
  if (m.role === "owner") return `<li class="pa-row" data-id="${esc(m.userId)}">${who}</li>`;
  if (confirming === m.userId) {
    return `<li class="pa-row" data-id="${esc(m.userId)}">${who}<div class="pa-acts"><span class="pa-ask">Remove this person? Their access ends at once.</span><button type="button" class="btn btn-primary btn-sm" data-pa="remove-yes">Yes, remove</button><button type="button" class="btn btn-ghost btn-sm" data-pa="remove-no">Keep</button></div></li>`;
  }
  const options = roles.map((r) => `<option value="${r.role}"${r.role === m.role ? " selected" : ""}>${esc(r.label)}</option>`).join("");
  return `<li class="pa-row" data-id="${esc(m.userId)}">${who}<div class="pa-acts"><label class="sr-only" for="pa-r-${esc(m.userId)}">What ${esc(m.email)} can do</label><select class="input pa-select" id="pa-r-${esc(m.userId)}" data-pa="role">${options}</select><button type="button" class="btn btn-ghost btn-sm" data-pa="remove">Remove</button></div></li>`;
}

function inviteRow(i: InviteRow): string {
  const state = i.status === "expired" ? "The link has run out. Send it again to make a new one." : `Sent ${day(i.lastSentAt)}. The link works until ${day(i.expiresAt)}.`;
  return `<li class="pa-row" data-id="${esc(i.id)}"><div class="pa-who"><b>${esc(i.email)}</b><span>${esc(i.roleLabel)} · ${esc(state)}</span></div><div class="pa-acts"><button type="button" class="btn btn-ghost btn-sm" data-pa="resend">Send again</button><button type="button" class="btn btn-quiet btn-sm" data-pa="cancel">Cancel invite</button></div></li>`;
}

function inviteForm(roles: RoleChoice[]): string {
  const choices = roles.map((r) => `<label class="pa-choice"><input type="radio" name="pa-role" value="${r.role}"${r.role === "member" ? " checked" : ""}><span><b>${esc(r.label)}</b><span>${esc(r.can)}</span></span></label>`).join("");
  return `<form id="pa-form" class="pa-form" novalidate><h3 class="pa-sub" id="pa-new-h">Invite someone</h3>
    <div class="field"><label for="pa-email">Their email address</label><input class="input" id="pa-email" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="254" aria-describedby="pa-msg"></div>
    <fieldset class="pa-choices"><legend>What can they do?</legend>${choices}</fieldset>
    <div class="acts"><button class="btn btn-primary btn-sm" type="submit" id="pa-send">Send invite</button></div></form>`;
}

function ownerPanel(t: Team): string {
  const members = t.members ?? [], invites = t.invites ?? [], roles = t.roles ?? [];
  const waiting = invites.filter((i) => i.status === "pending").length;
  $("pa-count").textContent = t.limit ? `${members.length + waiting} of ${t.limit} people` : "";
  const invited = invites.length
    ? `<h3 class="pa-sub">Invites</h3><ul class="pa-list" aria-label="Invites">${invites.map(inviteRow).join("")}</ul>`
    : "";
  return `<p class="muted small">Invite people to work with your AI team, and choose what each one can do. Only you can change the plan, billing, connected apps and who has access.${t.limit ? ` Up to ${t.limit} people, counting you and invites still waiting.` : ""}</p>
    <ul class="pa-list" aria-label="People with access">${members.map((m) => memberRow(m, roles)).join("")}</ul>${invited}${inviteForm(roles)}`;
}

function teammatePanel(t: Team): string {
  $("pa-count").textContent = "";
  return `<div class="ubar ubar-2"><span>Owner</span><span class="mono">${esc(t.owner.email)}</span></div>
    <div class="ubar ubar-2"><span>Your access</span><span><b>${esc(t.you.roleLabel)}</b></span></div>
    <p class="muted small pa-can">${esc(t.you.can)} Only the owner can change who has access.</p>`;
}

function draw(): void {
  if (!team) return;
  const body = $("pa-body");
  const typed = document.getElementById("pa-email") as HTMLInputElement | null;
  const keepEmail = typed?.value ?? "", keepRole = document.querySelector<HTMLInputElement>('input[name="pa-role"]:checked')?.value;
  keepFocus(body, ".pa-row", "data-pa", () => { body.innerHTML = team!.canManage ? ownerPanel(team!) : teammatePanel(team!); }, $("pa-h"));
  const email = document.getElementById("pa-email") as HTMLInputElement | null;
  if (email) email.value = keepEmail;
  const chosen = keepRole ? document.querySelector<HTMLInputElement>(`input[name="pa-role"][value="${keepRole}"]`) : null;
  if (chosen) chosen.checked = true;
  say(message);
}

/** The panel's one status line. A development API also hands back the join link, so a tester needs no email. */
function say(text: string): void {
  message = text;
  const el = $("pa-msg");
  el.textContent = text;
  if (devLink && text) el.insertAdjacentHTML("beforeend", ` <a href="${esc(devLink)}">Open the join link (development only)</a>`);
}

async function send(path: string, body: unknown, done: string): Promise<boolean> {
  const r = await api<Team>(path, { body });
  devLink = r.ok ? r.data?.devLink ?? "" : "";
  if (r.ok && r.data) { team = r.data; confirming = undefined; message = done; draw(); return true; }
  say(r.status === 0 ? "We can't reach the service right now. Please try again in a moment." : r.data?.error ?? "That did not work. Please try again.");
  return false;
}

async function onPanelClick(e: Event): Promise<void> {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-pa]");
  const id = btn?.closest<HTMLElement>(".pa-row")?.dataset.id;
  if (!btn || !id || isBusy(btn)) return;
  const act = btn.dataset.pa!;
  const email = btn.closest(".pa-row")?.querySelector("b")?.textContent ?? "";
  if (act === "remove" || act === "remove-no") { confirming = act === "remove" ? id : undefined; message = ""; draw(); return; }
  setBusy(btn, true);
  const safe = encodeURIComponent(id);
  if (act === "remove-yes") await send(`/team/members/${safe}/remove`, {}, `${email} no longer has access.`);
  if (act === "resend") await send(`/team/invites/${safe}/resend`, {}, `A new invite is on its way to ${email}. The old link no longer works.`);
  if (act === "cancel") await send(`/team/invites/${safe}/cancel`, {}, `The invite to ${email} is cancelled.`);
  if (btn.isConnected) setBusy(btn, false);
}

async function onRoleChange(e: Event): Promise<void> {
  const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-pa="role"]');
  const row = select?.closest<HTMLElement>(".pa-row");
  if (!select || !row?.dataset.id) return;
  const email = row.querySelector("b")?.textContent ?? "";
  const label = select.selectedOptions[0]?.textContent ?? "";
  const ok = await send(`/team/members/${encodeURIComponent(row.dataset.id)}/role`, { role: select.value }, `${email} is now: ${label}.`);
  if (!ok) draw(); // put the list back as the server has it
}

async function onInvite(e: Event): Promise<void> {
  if (!(e.target as HTMLElement).closest("#pa-form")) return;
  e.preventDefault();
  const email = $<HTMLInputElement>("pa-email"), go = $("pa-send");
  if (isBusy(go)) return;
  const to = email.value.trim();
  email.setAttribute("aria-invalid", String(!EMAIL.test(to)));
  if (!EMAIL.test(to)) { say("Enter a valid email address."); email.focus(); return; }
  const role = document.querySelector<HTMLInputElement>('input[name="pa-role"]:checked')?.value ?? "member";
  setBusy(go, true);
  email.value = "";
  const ok = await send("/team/invites", { email: to, role }, `Invite sent to ${to}. The link works once and lasts 7 days.`);
  const again = $<HTMLInputElement>("pa-email");
  if (!ok) { again.value = to; again.setAttribute("aria-invalid", "true"); }
  again.focus();
  setBusy($("pa-send"), false);
}

// ---------------------------------------------------------------- a teammate's view of the control centre

type Rule = [selector: string, reason: string];
const APPS = "Only the owner can connect or remove apps.";
const STORE = "Only the owner can hire or buy from the store.";
/** Controls only the owner can use. The lists name what the screens draw; anything missed is still refused by the server, with its reason. */
const OWNER_ONLY: Rule[] = [
  ["#cart-checkout, [data-hire]", STORE],
  ['[data-screen="apps"] [data-connect], [data-screen="apps"] [data-disconnect], [data-access], [data-choices], #slack-connect', APPS],
  ['[data-ag="new"], [data-ag="edit"], [data-ag="rotate"], [data-ag="test"], [data-ag="remove"], [data-ag="approve"], [data-ag="refuse"]', "Only the owner can connect or change outside AI tools."],
  ["#setup-undo", "Only the owner can change this setting."],
];
const MANAGER_ONLY: Rule[] = [
  ['[data-post][data-act="approve"], [data-post][data-act="reject"], [data-post][data-act="cancel"]', "Only the owner or a manager can approve this."],
  ["#apps-post", "Only the owner or a manager can put entries into the books."],
  ["#hr-add-btn", "Only the owner or a manager can see or change staff records."],
];
const VIEWER_ONLY: Rule[] = [
  ['#new-task, #q-run, #run-now, #chat-clear, [data-q-cancel], [data-sync], [data-upload], [data-post], #rd-ok, [data-mine="confirm"], [data-mine="share"], [data-mine="remove"]', VIEW_ONLY],
];
/** A line under a screen's heading saying what is kept for the owner there. */
const SCREEN_NOTES: Record<string, Partial<Record<Role, string>>> = {
  store: { admin: `${STORE} You can look around.`, member: `${STORE} You can look around.`, viewer: `${STORE} You can look around.` },
  apps: { admin: "Only the owner can connect or remove apps and outside AI tools.", member: "Only the owner can connect or remove apps and outside AI tools. You can refresh an app that is already connected.", viewer: "Only the owner can connect or remove apps and outside AI tools." },
  slack: { admin: "Only the owner can connect Slack.", member: "Only the owner can connect Slack.", viewer: "Only the owner can connect Slack." },
  setup: { admin: "Only the owner can change how the business is set up.", member: "Only the owner can change how the business is set up.", viewer: "Only the owner can change how the business is set up." },
  firstday: { admin: "Only the owner can set up the team.", member: "Only the owner can set up the team.", viewer: "Only the owner can set up the team." },
  approvals: { member: "Only the owner or a manager can approve work.", viewer: "Only the owner or a manager can approve work." },
};

/** Replaces a Settings panel's controls with the reason they are not shown. */
function lockPanel(headingId: string, reason: string): void {
  const panel = document.getElementById(headingId)?.closest<HTMLElement>("section");
  if (!panel || panel.classList.contains("role-locked")) return;
  panel.classList.add("role-locked");
  panel.querySelector(".panel-h")?.insertAdjacentHTML("afterend", `<p class="role-note">${esc(reason)}</p>`);
}

/** Stops a press on a control this role cannot use and says why. New controls are marked as the screens draw them. */
function guard(rules: Rule[], viewer: boolean): void {
  const ruleFor = (el: Element | null) => rules.find(([selector]) => el?.closest(selector));
  document.addEventListener("click", (e) => {
    const hit = ruleFor(e.target as Element);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast(hit[1]);
  }, true);
  if (viewer) document.addEventListener("submit", (e) => {
    if (!(e.target as Element).closest("#main")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast(VIEW_ONLY);
  }, true);
  const mark = () => rules.forEach(([selector, reason]) => document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    if (el.dataset.locked) return;
    el.dataset.locked = "1";
    el.setAttribute("aria-disabled", "true");
    el.title = reason;
  }));
  mark();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; mark(); });
  }).observe($("main"), { childList: true, subtree: true });
}

/** Everything a teammate's control centre shows differently from the owner's. */
function applyRole(role: Exclude<Role, "owner">): void {
  $("app").dataset.role = role;
  document.querySelector(".rail-org")?.insertAdjacentHTML("afterend", `<p class="rail-role" id="org-role">Your access: <b>${esc(ROLE_LABEL[role])}</b></p>`);
  lockPanel("bill-h", "Only the owner can change the plan or see billing.");
  lockPanel("tu-h", "Only the owner can change energy top-ups.");
  lockPanel("cp-h", "Only the owner can use a gift or discount code.");
  $("trial-cta").hidden = true;
  $("trial-box").insertAdjacentHTML("beforeend", '<span class="muted">Only the owner can change the plan.</span>');
  for (const [screen, notes] of Object.entries(SCREEN_NOTES)) {
    const reason = notes[role];
    if (reason) document.querySelector(`[data-screen="${screen}"] .page-h`)?.insertAdjacentHTML("afterend", `<p class="role-note role-note-screen">${esc(reason)}</p>`);
  }
  if (role === "viewer") {
    const ask = $<HTMLInputElement>("ask-in");
    ask.disabled = true;
    ask.placeholder = "View only: you can read, not ask";
    $("demo-banner").insertAdjacentHTML("afterend", `<div class="demo-bar" id="role-bar" role="note"><span><b>View only.</b> You can see the team's work and results. You cannot change anything.</span></div>`);
  }
  guard([...OWNER_ONLY, ...(role === "admin" ? [] : MANAGER_ONLY), ...(role === "viewer" ? VIEWER_ONLY : [])], role === "viewer");
}

let started = false;
/** Called once the business has loaded, with the signed-in person's role in it. */
export async function initAccess(role: Role | undefined): Promise<void> {
  if (started) return;
  started = true;
  if (role && role !== "owner") applyRole(role);
  // Any change the server refuses because of the person's role is explained in its own words.
  window.addEventListener("maiz:role-refused", (e) => toast(String((e as CustomEvent<string>).detail || VIEW_ONLY)));
  const body = $("pa-body");
  body.addEventListener("click", (e) => void onPanelClick(e));
  body.addEventListener("change", (e) => void onRoleChange(e));
  body.addEventListener("submit", (e) => void onInvite(e));
  const r = await api<Team>("/team");
  if (!r.ok || !r.data) { body.innerHTML = '<p class="muted small">We could not load who has access. Reload the page to try again.</p>'; return; }
  team = r.data;
  draw();
}
