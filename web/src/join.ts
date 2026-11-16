// The page an invite link opens (docs/TEAMMATES.md). The person joins the business that invited them: a new
// address chooses a password, an address that already has an account logs in with it first.
import "./styles.css";
import { api, clearSession, getToken, setToken } from "./api";
import { authError, finishSignIn, initNav, showSocialLogin, wirePasswordToggles, type SignedIn } from "./common";

initNav();
wirePasswordToggles();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const VIEWS = ["new", "login", "ready", "other", "mine", "note"] as const;
type View = (typeof VIEWS)[number];
interface Invite { businessName: string; email: string; roleLabel: string; can: string; invitedBy: string; needsLogin: boolean; loggedInAs?: string }
interface Waiting { id: string; businessName: string; roleLabel: string; can: string; invitedBy: string }
type Joined = Partial<SignedIn> & { error?: string; reason?: string; field?: string };

/** The link's secret waits here while the person logs in (also with Google or Microsoft), so they come back to it. */
const KEY = "maiz.invite";
const saved = (): string => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const keep = (token: string): void => { try { if (token) sessionStorage.setItem(KEY, token); else sessionStorage.removeItem(KEY); } catch { /* storage blocked */ } };

function show(view: View, heading: string, text = ""): void {
  VIEWS.forEach((v) => { $(`v-${v}`).hidden = v !== view; });
  $("jn-h").textContent = heading;
  $("jn-p").textContent = text;
  $("jn-p").hidden = !text;
  fail("");
  document.title = `${heading} · MAIZ Agents`;
}
function fail(message: string): void {
  $("jn-err").textContent = message;
  $("jn-err").hidden = !message;
}
function flag(input: HTMLInputElement, message: string): boolean {
  input.setAttribute("aria-invalid", String(!!message));
  if (message) { fail(message); input.focus(); }
  return !message;
}
async function busy<T>(btn: HTMLElement, work: () => Promise<T>): Promise<T> {
  btn.setAttribute("disabled", "");
  try { return await work(); } finally { btn.removeAttribute("disabled"); }
}
/** A message with nothing else to do on this page. */
function note(heading: string, text: string, signedIn = !!getToken()): void {
  $("jn-what").hidden = true;
  $("note-links").innerHTML = signedIn ? '<a href="/app.html">Open your control centre</a>' : '<a href="/signin.html">Log in</a>';
  show("note", heading, text);
}

// The secret rides after the "#", so it reaches no server until this page posts it. It then leaves the address bar.
const fromLink = new URLSearchParams(location.hash.slice(1)).get("i") ?? "";
if (fromLink) { keep(fromLink); history.replaceState(null, "", location.pathname); }
const token = fromLink || saved();
let invite: Invite | undefined;

/** Joined: the session is kept (a new one when the person just chose a password) and the control centre opens. */
function done(r: Joined): void {
  keep("");
  const session = r.token ?? getToken();
  if (!session) { location.replace("/signin.html"); return; }
  finishSignIn({ token: session, email: r.email ?? invite?.email ?? "", hasOrganisation: true });
}
/** A refusal that ends this invite here: the link is used, cancelled or run out, or this address cannot join. */
function refused(r: { status: number; data?: Joined }): void {
  if (r.data?.reason === "wrong_address") { showOther(); return; }
  if (r.status === 0 || r.status === 429) { fail(authError(r, "Please try again in a moment.")); return; }
  keep("");
  note("This invite can't be used", r.data?.error ?? "This invite link is not valid any more. Ask the person who invited you to send a new one.");
}

function showOther(): void {
  show("other", "This invite is for another address", `You are logged in as ${invite?.loggedInAs ?? "another address"}. The invite was sent to ${invite?.email ?? "a different address"}.`);
}
function showInvite(i: Invite): void {
  invite = i;
  $("jn-biz").textContent = i.businessName;
  $("jn-role").textContent = i.roleLabel;
  $("jn-can").textContent = i.can;
  $("jn-email").textContent = i.email;
  $("jn-what").hidden = false;
  const heading = `Join ${i.businessName}`;
  const from = i.invitedBy ? `${i.invitedBy} invited you to work with their AI team.` : "You are invited to work with this business's AI team.";
  for (const id of ["new-go", "ready-go"]) $(id).textContent = heading;
  if (i.loggedInAs) {
    if (i.loggedInAs === i.email) show("ready", heading, from);
    else showOther();
    return;
  }
  if (i.needsLogin) {
    show("login", heading, `${from} This address already has a MAIZ Agents account, so log in with it to join.`);
    void showSocialLogin($("jn-social2"), $("jn-social2-btns"));
    return;
  }
  show("new", heading, `${from} Choose a password to make your login.`);
  void showSocialLogin($("jn-social"), $("jn-social-btns"));
}

// ---- new here: choose a password and join ----
$<HTMLFormElement>("new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $<HTMLInputElement>("new-pw");
  fail("");
  if (!flag(pw, pw.value.length >= 8 ? "" : "Use at least 8 characters.")) return;
  const r = await busy($("new-go"), () => api<Joined>("/invites/accept", { body: { token, password: pw.value } }));
  if (r.ok && r.data?.token) { done(r.data); return; }
  if (r.data?.field === "password") { flag(pw, r.data.error ?? "Choose a different password."); return; }
  if (r.data?.reason === "login" && invite) { showInvite({ ...invite, needsLogin: true }); return; }
  refused(r);
});

// ---- this address already has an account: log in with it, then join ----
$<HTMLFormElement>("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $<HTMLInputElement>("login-pw");
  fail("");
  if (!flag(pw, pw.value ? "" : "Enter your password.")) return;
  const login = await busy($("login-go"), () => api<SignedIn & { error?: string }>("/auth/login", { body: { email: invite?.email ?? "", password: pw.value } }));
  if (!login.ok || !login.data?.token) {
    pw.setAttribute("aria-invalid", "true");
    fail(authError(login, "We couldn't log you in. Please try again."));
    pw.select();
    return;
  }
  setToken(login.data.token);
  await join({ token });
});

async function join(body: { token: string } | { inviteId: string }): Promise<void> {
  const r = await api<Joined>("/invites/accept", { body });
  if (r.ok) { done(r.data ?? {}); return; }
  refused(r);
}
$("ready-go").addEventListener("click", () => void busy($("ready-go"), () => join({ token })));
$("other-out").addEventListener("click", () => { clearSession(); location.reload(); });

// ---- logged in, no link: invites waiting for this address ----
async function showMine(): Promise<void> {
  const r = await api<{ invites: Waiting[] }>("/invites/mine");
  if (r.status === 401) { note("Open your invite link", "Use the link in your invite email. It works once and lasts 7 days.", false); return; }
  const waiting = r.ok ? r.data?.invites ?? [] : [];
  if (!waiting.length) { note("No invite is waiting", "There is no invite waiting for the address you are logged in with. Ask the owner of the business to invite you, or to send the invite again."); return; }
  $("mine-list").innerHTML = waiting.map((w) => `<li><div><b>${esc(w.businessName)}</b><span>${esc(w.roleLabel)}. ${esc(w.can)}</span></div><button class="btn btn-primary btn-sm" type="button" data-join="${esc(w.id)}">Join</button></li>`).join("");
  show("mine", waiting.length === 1 ? "You have an invite" : "You have invites", "Join to work with that business's AI team.");
}
$("mine-list").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-join]");
  if (b) void busy(b, () => join({ inviteId: b.dataset.join! }));
});

async function start(): Promise<void> {
  if (!token) {
    if (getToken()) await showMine();
    else note("Open your invite link", "Use the link in your invite email. It works once and lasts 7 days.");
    return;
  }
  const r = await api<Invite & { error?: string }>("/invites/open", { body: { token } });
  if (r.ok && r.data) { showInvite(r.data); return; }
  if (r.status === 0 || r.status === 429) { note("We can't open your invite right now", authError(r, "Please try again in a moment.")); return; }
  keep("");
  note("This invite can't be used", r.data?.error ?? "This invite link is not valid any more. Ask the person who invited you to send a new one.");
}
void start();
