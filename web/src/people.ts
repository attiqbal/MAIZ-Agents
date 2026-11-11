// The HR manager desk: every member of the client's own staff, their documents, what needs doing,
// holiday, checklists and reviews. Signed-in owners and admins work on their real records through
// /api/people; everyone else sees the example business, which works the same way in this browser only.
// The rules (which documents, when they expire, holiday) are the server's own, imported from src/.
import { api, getToken } from "./api";
import { toast } from "./common";
import {
  CATEGORY_LABEL, CONTRACT_LABEL, DOC_STATE_LABEL, RTW_LABEL, SECTORS, STATUS_LABEL,
  FORM_LINK_DAYS, SECTOR_QUESTIONS, addDays, hrSummary, isIsoDate, mergeProfile, offOn, readProfile, requestMessage, sectorLabel, staffDetail, toIsoDate,
  type Category, type ContractType, type DeskSettings, type DocState, type DocStatus, type DocView, type HrAction,
  type HrSummary, type Severity, type StaffDetail, type StaffMember, type StaffStatus,
} from "../../src/modules/people/browser";
import { EXAMPLE_SETTINGS, exampleStaff } from "./people-examples";
import { profileFieldsHtml, readProfileFields, wireProfileFields } from "./staff-fields";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmtDate = (iso?: string) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The server sends at most 50 actions; `actionsTotal` counts them all. */
interface Overview { settings: DeskSettings; summary: HrSummary & { actionsTotal?: number }; offToday: ReturnType<typeof offOn> }

/** Where the desk's records live: the API for a signed-in client, this browser for the example. */
interface Backend {
  live: boolean;
  overview(): Promise<Overview>;
  detail(id: string): Promise<StaffDetail>;
  add(b: Record<string, unknown>): Promise<StaffDetail & { rotaNote?: string }>;
  update(id: string, b: Record<string, unknown>): Promise<StaffDetail>;
  setDocument(id: string, key: string, b: { status: DocStatus; expiresOn?: string }): Promise<StaffDetail>;
  setChecklist(id: string, key: string, done: boolean): Promise<StaffDetail>;
  addLeave(id: string, b: Record<string, unknown>): Promise<StaffDetail>;
  decideLeave(id: string, leaveId: string, approve: boolean): Promise<StaffDetail>;
  completeReview(id: string, reviewId: string): Promise<StaffDetail>;
  setLeaving(id: string, endDate: string | null): Promise<StaffDetail>;
  settings(b: Partial<DeskSettings>): Promise<DeskSettings>;
  updateProfile(id: string, b: Record<string, unknown>): Promise<StaffDetail>;
  createFormLink(id: string): Promise<{ url: string; expiresOn: string }>;
  stopFormLink(id: string): Promise<StaffDetail>;
}

class ApiBackend implements Backend {
  live = true;
  private async call<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const r = await api<T & { error?: string }>(`/people${path}`, { ...(body !== undefined ? { body } : {}), ...(method ? { method } : {}) });
    if (!r.ok || !r.data) throw new Error((r.data as { error?: string } | undefined)?.error ?? "That did not save. Check your connection and try again.");
    return r.data;
  }
  overview() { return this.call<Overview>(""); }
  detail(id: string) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}`); }
  add(b: Record<string, unknown>) { return this.call<StaffDetail & { rotaNote?: string }>("", b); }
  update(id: string, b: Record<string, unknown>) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}`, b); }
  setDocument(id: string, key: string, b: object) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/documents/${key}`, b); }
  setChecklist(id: string, key: string, done: boolean) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/checklist/${key}`, { done }); }
  addLeave(id: string, b: Record<string, unknown>) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/leave`, b); }
  decideLeave(id: string, leaveId: string, approve: boolean) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/leave/${encodeURIComponent(leaveId)}/decide`, { approve }); }
  completeReview(id: string, reviewId: string) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}/done`, {}); }
  setLeaving(id: string, endDate: string | null) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/leaving`, { endDate }); }
  async settings(b: Partial<DeskSettings>) { return (await this.call<{ settings: DeskSettings }>("/settings", b)).settings; }
  updateProfile(id: string, b: Record<string, unknown>) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/profile`, b); }
  async createFormLink(id: string) {
    const r = await this.call<{ url: string; expiresOn: string }>(`/${encodeURIComponent(id)}/form-link`, {});
    return { ...r, url: new URL(r.url, location.origin).href };
  }
  stopFormLink(id: string) { return this.call<StaffDetail>(`/${encodeURIComponent(id)}/form-link`, undefined, "DELETE"); }
}

/** The example business, kept in this browser. Uses the same rules; checks are lighter than the server's. */
class LocalBackend implements Backend {
  live = false;
  private staff = exampleStaff();
  private s: DeskSettings = { ...EXAMPLE_SETTINGS };
  private today = () => toIsoDate(new Date());
  private get(id: string): StaffMember {
    const m = this.staff.find((x) => x.id === id);
    if (!m) throw new Error("That person is not on the list");
    return m;
  }
  private put(next: StaffMember): StaffDetail {
    this.staff = this.staff.map((x) => (x.id === next.id ? next : x));
    return staffDetail(next, this.s, this.today());
  }
  private change(id: string, f: (m: StaffMember) => Partial<StaffMember>): Promise<StaffDetail> {
    const m = this.get(id);
    return Promise.resolve(this.put({ ...m, ...f(m), updatedAt: new Date().toISOString() }));
  }
  overview() { return Promise.resolve({ settings: this.s, summary: hrSummary(this.staff, this.s.sector, this.today()), offToday: offOn(this.staff, this.today()) }); }
  detail(id: string) { return Promise.resolve(staffDetail(this.get(id), this.s, this.today())); }
  add(b: Record<string, unknown>) {
    const at = new Date().toISOString();
    const hours = Number(b.hoursPerWeek) || 0;
    const m: StaffMember = {
      id: `eg-${Date.now()}`, workspaceId: "example", name: String(b.name), jobTitle: String(b.jobTitle), startDate: String(b.startDate),
      contract: (b.contract as ContractType) ?? "full_time", hoursPerWeek: hours, daysPerWeek: Math.min(5, Math.max(1, Math.round(hours / 7.5))),
      pension: "to_assess", rtwRoute: "unknown", documents: {}, checklist: {}, leave: [], reviews: [], createdAt: at, updatedAt: at,
    };
    this.staff = [...this.staff, m];
    return Promise.resolve(staffDetail(m, this.s, this.today()));
  }
  update(id: string, b: Record<string, unknown>) { return this.change(id, () => b as Partial<StaffMember>); }
  setDocument(id: string, key: string, b: { status: DocStatus; expiresOn?: string }) {
    return this.change(id, (m) => ({
      documents: { ...m.documents, [key]: { status: b.status, updatedAt: new Date().toISOString(), ...(b.expiresOn ? { expiresOn: b.expiresOn } : {}), ...(b.status === "checked" ? { checkedOn: this.today(), checkedBy: "you" } : {}) } },
      ...(key === "right_to_work" && b.expiresOn ? { rtwExpiresOn: b.expiresOn } : {}),
    }));
  }
  setChecklist(id: string, key: string, done: boolean) {
    return this.change(id, (m) => {
      const checklist = { ...m.checklist };
      if (done) checklist[key] = this.today(); else delete checklist[key];
      return { checklist };
    });
  }
  addLeave(id: string, b: Record<string, unknown>) {
    return this.change(id, (m) => ({ leave: [...m.leave, { id: `l-${Date.now()}`, kind: (b.kind as "holiday") ?? "holiday", from: String(b.from), to: String(b.to ?? b.from), days: Number(b.days), status: b.status === "requested" ? "requested" as const : "approved" as const }] }));
  }
  decideLeave(id: string, leaveId: string, approve: boolean) {
    return this.change(id, (m) => ({ leave: m.leave.map((l) => (l.id === leaveId ? { ...l, status: approve ? "approved" as const : "declined" as const } : l)) }));
  }
  completeReview(id: string, reviewId: string) {
    return this.change(id, (m) => (reviewId === "probation" && !m.reviews.some((r) => r.id === "probation")
      ? { reviews: [...m.reviews, { id: "probation", kind: "probation" as const, dueOn: m.probationEndsOn ?? this.today(), doneOn: this.today() }] }
      : { reviews: m.reviews.map((r) => (r.id === reviewId ? { ...r, doneOn: this.today() } : r)) }));
  }
  setLeaving(id: string, endDate: string | null) {
    const { endDate: _old, ...rest } = this.get(id);
    return Promise.resolve(this.put({ ...rest, ...(endDate ? { endDate } : {}), updatedAt: new Date().toISOString() }));
  }
  settings(b: Partial<DeskSettings>) { this.s = { ...this.s, ...b }; return Promise.resolve(this.s); }
  updateProfile(id: string, b: Record<string, unknown>) {
    try {
      const changes = readProfile(b, this.s.sector);
      return this.change(id, (m) => ({ profile: mergeProfile(m.profile, changes, "owner", this.today()) }));
    } catch (e) { return Promise.reject(e); }
  }
  async createFormLink(id: string) {
    const expiresOn = addDays(this.today(), FORM_LINK_DAYS);
    await this.change(id, () => ({ formLink: { createdOn: this.today(), expiresOn } }));
    // The example has no server, so its link opens a preview that saves nothing.
    return { url: `${location.origin}/staff-form.html#demo`, expiresOn };
  }
  stopFormLink(id: string) {
    const { formLink: _old, ...rest } = this.get(id);
    return Promise.resolve(this.put({ ...rest, updatedAt: new Date().toISOString() }));
  }
}

// ---------- state ----------

let backend: Backend = new LocalBackend();
let view: Overview | undefined;
let businessName = "your business";
let staffFilter: "attention" | "starting" | "leaving" | "all" = "all";
let query = "";
let open: StaffDetail | undefined;
let tab: Tab = "overview";
type Tab = "overview" | "about" | "documents" | "contract" | "leave" | "checklists" | "reviews";
const TABS: [Tab, string][] = [["overview", "Overview"], ["about", "About them"], ["documents", "Documents"], ["contract", "Contract and pay"], ["leave", "Leave and rota"], ["checklists", "Checklists"], ["reviews", "Reviews"]];

const SEV: Record<Severity, [tone: string, label: string]> = { critical: ["crit", "Urgent"], high: ["warn", "Soon"], medium: ["info", "This month"], low: ["", "When you can"] };
const DOC_TONE: Record<DocState, string> = { ok: "good", expiring: "warn", expired: "crit", to_check: "warn", requested: "info", missing: "crit" };
const STATUS_TONE: Record<StaffStatus, string> = { starting: "info", active: "good", on_leave: "warn", leaving: "warn", left: "" };
const statusTag = (tone: string, text: string) => `<span class="status ${tone}"><span class="dot"></span>${esc(text)}</span>`;
const meter = (pct: number) => `<span class="hr-meter" role="img" aria-label="${pct}% complete"><i style="width:${pct}%" class="${pct < 60 ? "low" : ""}"></i></span><span class="mono">${pct}%</span>`;

async function run<T>(f: () => Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const r = await f();
    if (done) toast(done);
    return r;
  } catch (e) {
    toast(e instanceof Error ? e.message : "Something went wrong");
    return undefined;
  }
}

async function refresh(): Promise<void> {
  const v = await run(() => backend.overview());
  if (!v) return;
  view = v;
  renderDesk();
}

// ---------- the desk ----------

function renderDesk(): void {
  if (!view) return;
  const s = view.summary;
  $("hr-sector").innerHTML = `<span class="muted">Document rules for</span> <b>${esc(sectorLabel(view.settings.sector))}</b> <span class="muted">· UK rules pack, checked 11 Nov 2026</span> <button type="button" class="btn btn-quiet btn-sm" id="hr-sector-btn" aria-expanded="false">Change</button>`;
  const urgent = s.bySeverity.critical + s.bySeverity.high;
  $("hr-kpis").innerHTML = [
    kpi("Staff", String(s.headcount), `${s.starting} starting, ${s.leaving} leaving`),
    kpi("Records complete", `${s.recordsComplete}%`, s.recordsComplete === 100 ? "Every required document is in" : "Required documents present and in date", s.recordsComplete < 80 ? "warn" : ""),
    kpi("Expiring in 60 days", String(s.expiringSoon), s.expired ? `${s.expired} already expired` : "Nothing has expired", s.expired ? "warn" : ""),
    kpi("Off today", String(s.offToday), view.offToday.map((o) => o.name.split(" ")[0]).join(", ") || "Everyone is in"),
  ].join("");
  $("hr-count").textContent = urgent ? String(urgent) : "";
  $("hr-count").toggleAttribute("hidden", !urgent);
  renderActions();
  renderTable();
  renderHomeCard();
  document.dispatchEvent(new CustomEvent("hr:updated"));
}

function kpi(label: string, value: string, note: string, tone = ""): string {
  return `<div class="tile-kpi"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span><span class="dl ${tone}">${esc(note)}</span></div>`;
}

function actionButtons(a: HrAction): string {
  const data = `data-staff="${esc(a.staffId)}" data-ref="${esc(a.ref ?? "")}"`;
  switch (a.kind) {
    case "request": case "renew": return `<button type="button" class="btn btn-ghost btn-sm" data-hr="copy" ${data}>Copy request</button><button type="button" class="btn btn-quiet btn-sm" data-hr="open" data-tab="documents" ${data}>Open</button>`;
    case "check": return `<button type="button" class="btn btn-primary btn-sm" data-hr="open" data-tab="documents" ${data}>Check it</button>`;
    case "approve_leave": return `<button type="button" class="btn btn-primary btn-sm" data-hr="leave-yes" ${data}>Approve</button><button type="button" class="btn btn-ghost btn-sm" data-hr="leave-no" ${data}>Decline</button>`;
    case "review": return `<button type="button" class="btn btn-ghost btn-sm" data-hr="review-done" ${data}>Mark done</button>`;
    case "send_form": return `<button type="button" class="btn btn-ghost btn-sm" data-hr="form" ${data}>Copy form link</button><button type="button" class="btn btn-quiet btn-sm" data-hr="open" data-tab="about" ${data}>Fill it in</button>`;
    case "skill": return `<button type="button" class="btn btn-ghost btn-sm" data-hr="open" data-tab="about" ${data}>Open</button>`;
    default: return `<button type="button" class="btn btn-ghost btn-sm" data-hr="open" data-tab="checklists" ${data}>Open checklist</button>`;
  }
}

const ACTIONS_SHOWN = 8;
let showAllActions = false;
function renderActions(): void {
  const s = view!.summary;
  const total = s.actionsTotal ?? s.actions.length;
  const all = s.actions.filter((a) => a.severity !== "low");
  const later = s.bySeverity.low;
  const now = total - later;
  const list = showAllActions ? s.actions : all.slice(0, ACTIONS_SHOWN);
  $("hr-actions-note").textContent = now ? `${plural(now, "thing")} to do${later ? `, ${later} more when you can` : ""}` : "";
  $("hr-actions").innerHTML = list.length
    ? list.map((a) => `<li class="hr-act"><div class="hr-act-main">${statusTag(SEV[a.severity][0], SEV[a.severity][1])}<b><button type="button" class="hr-name" data-hr="open" data-staff="${esc(a.staffId)}">${esc(a.staffName)}</button> · ${esc(a.title)}</b><span class="small muted">${esc(a.detail)}</span></div><div class="acts">${actionButtons(a)}</div></li>`).join("")
    : `<li class="all-clear">Nothing needs doing. Every record is complete and in date.</li>`;
  const more = $("hr-actions-more");
  const hidden = s.actions.length - list.length;
  more.toggleAttribute("hidden", hidden <= 0 && !showAllActions);
  more.textContent = showAllActions ? "Show fewer" : total > s.actions.length ? `Show the ${s.actions.length} most urgent of ${total}` : `Show all ${total}`;
}

function renderTable(): void {
  const q = query.trim().toLowerCase();
  const rows = view!.summary.rows.filter((r) => {
    if (q && !`${r.name} ${r.jobTitle}`.toLowerCase().includes(q)) return false;
    if (staffFilter === "attention") return r.worst === "critical" || r.worst === "high";
    if (staffFilter === "starting") return r.status === "starting";
    if (staffFilter === "leaving") return r.status === "leaving" || r.status === "left";
    return true;
  });
  $("hr-table").innerHTML = `<thead><tr><th scope="col">Name</th><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Records</th><th scope="col">Next thing to do</th></tr></thead><tbody>` +
    (rows.length ? rows.map((r) => `<tr><td><button type="button" class="hr-name" data-hr="open" data-staff="${esc(r.id)}">${esc(r.name)}</button></td><td>${esc(r.jobTitle)}<span class="small muted block">${esc(CONTRACT_LABEL[r.contract])}</span></td><td>${statusTag(STATUS_TONE[r.status], STATUS_LABEL[r.status])}</td><td><span class="hr-rec">${meter(r.complete)}</span></td><td>${r.next ? `${statusTag(SEV[r.worst!][0], SEV[r.worst!][1])} <span class="small">${esc(r.next)}</span>` : `<span class="muted small">Nothing</span>`}</td></tr>`).join("")
      : `<tr><td colspan="5" class="muted">${q ? "Nobody matches that search." : "Nobody here yet. Add your first person: it takes five answers."}</td></tr>`) + "</tbody>";
}

/** The overview's "People today" card. */
function renderHomeCard(): void {
  const el = document.getElementById("ov-people");
  if (!el || !view) return;
  const s = view.summary;
  const top = s.actions[0];
  el.innerHTML = `<div class="ubar ubar-2"><span>Staff</span><span class="mono">${s.headcount}</span></div>
    <div class="ubar ubar-2"><span>Off today</span><span class="mono">${s.offToday}</span></div>
    <div class="ubar ubar-2"><span>Records complete</span><span class="mono">${s.recordsComplete}%</span></div>
    ${top ? `<p class="small">${statusTag(SEV[top.severity][0], SEV[top.severity][1])} ${esc(top.staffName)}: ${esc(top.title)}</p>` : `<p class="small muted">Every record is complete and in date.</p>`}`;
}

// ---------- one person ----------

async function openPerson(id: string, t: Tab = "overview"): Promise<void> {
  const d = await run(() => backend.detail(id));
  if (!d) return;
  open = d;
  tab = t;
  renderPerson();
  const dlg = $<HTMLDialogElement>("hr-person");
  if (!dlg.open) dlg.showModal();
}

function setOpen(d: StaffDetail | undefined): void {
  if (!d) return;
  open = d;
  renderPerson();
  void refresh();
}

function renderPerson(): void {
  if (!open) return;
  const m = open.member;
  $("hr-p-name").textContent = m.name;
  $("hr-p-meta").innerHTML = `${esc(m.jobTitle)} · ${esc(CONTRACT_LABEL[m.contract])} · ${open.status === "starting" ? "starts" : "started"} ${esc(fmtDate(m.startDate))} ${statusTag(STATUS_TONE[open.status], STATUS_LABEL[open.status])} <span class="hr-rec">${meter(open.complete)}</span>`;
  $("hr-tabs").innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" id="hr-tab-${k}" aria-controls="hr-panel" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" data-tab-key="${k}">${esc(label)}${k === "documents" ? ` <span class="mono">${open!.documents.filter((x) => x.state !== "ok").length || ""}</span>` : ""}</button>`).join("");
  $("hr-panel").setAttribute("aria-labelledby", `hr-tab-${tab}`);
  $("hr-panel").innerHTML = ({ overview: tabOverview, about: tabAbout, documents: tabDocuments, contract: tabContract, leave: tabLeave, checklists: tabChecklists, reviews: tabReviews } as const)[tab]();
}

function tabOverview(): string {
  const d = open!;
  const m = d.member;
  const acts = d.actions.length
    ? `<ul class="hr-mini">${d.actions.map((a) => `<li>${statusTag(SEV[a.severity][0], SEV[a.severity][1])} <b>${esc(a.title)}</b> <span class="small muted">${esc(a.detail)}</span></li>`).join("")}</ul>`
    : `<p class="all-clear">This record is complete. Nothing to do.</p>`;
  const lb = d.leave;
  return `<h3 class="hr-h">What needs doing</h3>${acts}
    <div class="grid3 hr-facts">
      ${fact("Manager", m.manager || "Not set")}${fact("Hours", `${m.hoursPerWeek} a week, ${m.daysPerWeek} days`)}${fact("Right to work", RTW_LABEL[m.rtwRoute])}
      ${fact("Holiday left", lb.basis === "days" ? `${lb.left} of ${lb.allowance} days` : "Builds up at 12.07% of hours worked")}${fact("Probation ends", m.probationEndsOn ? fmtDate(m.probationEndsOn) : "Not set")}${fact("Leaving", m.endDate ? fmtDate(m.endDate) : "No")}
    </div>`;
}
function tabAbout(): string {
  const m = open!.member;
  const p = m.profile ?? {};
  const first = m.name.split(" ")[0]!;
  const link = m.formLink;
  const linkLine = link
    ? `Form link made ${esc(fmtDate(link.createdOn))}, works until ${esc(fmtDate(link.expiresOn))}.${link.usedOn ? ` ${esc(first)} last filled it in on ${esc(fmtDate(link.usedOn))}.` : " Not filled in yet."}`
    : `Send ${esc(first)} a link to fill this in themselves. It works for ${FORM_LINK_DAYS} days and shows only their own details, never pay or documents.`;
  const filled = p.updatedOn ? `<p class="small muted">Last updated ${esc(fmtDate(p.updatedOn))} by ${p.updatedBy === "staff" ? esc(first) : "you"}.</p>` : "";
  return `<div class="hr-formlink"><p class="small">${linkLine}</p><div class="acts">
      <button type="button" class="btn btn-ghost btn-sm" data-form-link="copy">${link ? "Copy a new link" : "Copy form link"}</button>
      ${link ? `<button type="button" class="btn btn-quiet btn-sm" data-form-link="stop">Stop the link</button>` : ""}
    </div></div>
    ${filled}
    <form id="hr-about" class="sf-form" novalidate>
      ${profileFieldsHtml(p, questionsNow(), { self: false })}
      <div class="acts"><button type="submit" class="btn btn-primary">Save</button></div>
    </form>`;
}
const questionsNow = () => SECTOR_QUESTIONS[view?.settings.sector ?? "other"];

/** Makes a fresh form link and copies it with a short message, ready to paste into a text or WhatsApp. */
async function copyFormLink(staffId: string): Promise<void> {
  const d = open?.member.id === staffId ? open : await run(() => backend.detail(staffId));
  if (!d) return;
  const r = await run(() => backend.createFormLink(staffId));
  if (!r) return;
  const first = d.member.name.split(" ")[0];
  const msg = `Hi ${first}, please fill in your details for ${businessName}: when you can work, your emergency contact and any certificates. It takes about 5 minutes: ${r.url} (the link works until ${fmtDate(r.expiresOn)}).`;
  let copied = true;
  try { await navigator.clipboard.writeText(msg); } catch { copied = false; }
  toast(copied ? `Link copied. Paste it into a message to ${first}.` : `Copy this link for ${first}: ${r.url}`);
  if (open?.member.id === staffId) setOpen(await run(() => backend.detail(staffId))); else void refresh();
}

const fact = (k: string, v: string) => `<div class="kpi"><span class="l">${esc(k)}</span><span class="small">${esc(v)}</span></div>`;

function docRow(x: DocView): string {
  const when = x.expiresOn ? (x.state === "expired" ? `Expired ${fmtDate(x.expiresOn)}` : `Valid until ${fmtDate(x.expiresOn)}`) : x.doc?.checkedOn ? `Checked ${fmtDate(x.doc.checkedOn)}` : "";
  const needsDate = x.hasExpiry || (x.key === "right_to_work" && (open!.member.rtwRoute === "share_code" || open!.member.rtwRoute === "evisa"));
  const k = esc(x.key);
  const btns = [
    x.state === "missing" || x.state === "expired" || x.state === "expiring" ? `<button type="button" class="btn btn-ghost btn-sm" data-doc="request" data-key="${k}">Copy request</button>` : "",
    x.state === "missing" || x.state === "requested" ? `<button type="button" class="btn btn-quiet btn-sm" data-doc="received" data-key="${k}">Mark received</button>` : "",
    x.state !== "ok" ? `<button type="button" class="btn btn-primary btn-sm" data-doc="checked" data-key="${k}" data-needs-date="${needsDate}">I've checked it</button>` : `<button type="button" class="btn btn-quiet btn-sm" data-doc="missing" data-key="${k}">Undo</button>`,
  ].join("");
  const dateField = needsDate && x.state !== "ok" ? `<label class="hr-date"><span class="small muted">${x.key === "right_to_work" ? "Permission ends" : "Expiry date"}</span><input class="input" type="date" data-expiry="${k}" value="${esc(x.doc?.expiresOn ?? "")}"></label>` : "";
  return `<li class="hr-doc"><div class="hr-act-main"><b>${esc(x.label)}${x.level === "legal" ? ` <span class="badge badge-dark">Required by law</span>` : ""}</b><span class="small muted">${esc(x.why)}</span>${statusTag(DOC_TONE[x.state], DOC_STATE_LABEL[x.state] + (when ? ` · ${when}` : ""))}</div><div class="acts">${dateField}${btns}</div></li>`;
}

function tabDocuments(): string {
  const groups = new Map<Category, DocView[]>();
  for (const x of open!.documents) groups.set(x.category, [...(groups.get(x.category) ?? []), x]);
  const keep = open!.rtwRetainUntil ? `<p class="small muted">Keep right-to-work evidence until ${esc(fmtDate(open!.rtwRetainUntil))} (2 years after leaving), then delete it.</p>` : "";
  return `<p class="small muted">Worked out from the sector, the job and the person's age. Copies of documents stay in your own files for now; record here that you checked them.</p>${keep}` +
    [...groups].map(([c, xs]) => `<h3 class="hr-h">${esc(CATEGORY_LABEL[c])}</h3><ul class="hr-docs">${xs.map(docRow).join("")}</ul>`).join("");
}

function tabContract(): string {
  const m = open!.member;
  const opt = (v: string, label: string, cur?: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const pay = m.payPence === undefined ? "" : (m.payPence / 100).toFixed(2);
  const field = (id: string, label: string, input: string) => `<div class="field"><label for="hr-f-${id}">${esc(label)}</label>${input}</div>`;
  const text = (id: string, label: string, v = "", type = "text", extra = "") => field(id, label, `<input class="input" id="hr-f-${id}" name="${id}" type="${type}" value="${esc(v)}" ${extra}>`);
  return `<form class="hr-form" id="hr-contract" novalidate>
    ${text("jobTitle", "Job title", m.jobTitle, "text", 'maxlength="120" required')}
    ${field("contract", "Contract", `<select class="input" id="hr-f-contract" name="contract">${Object.entries(CONTRACT_LABEL).map(([k, l]) => opt(k, l, m.contract)).join("")}</select>`)}
    ${text("hoursPerWeek", "Hours a week", String(m.hoursPerWeek), "number", 'min="0" max="80" step="0.5"')}
    ${text("daysPerWeek", "Days a week", String(m.daysPerWeek), "number", 'min="0" max="7" step="0.5"')}
    ${text("pay", m.payBasis === "year" ? "Pay a year (£)" : "Pay an hour (£)", pay, "number", 'min="0" step="0.01" inputmode="decimal"')}
    ${field("payBasis", "Paid by", `<select class="input" id="hr-f-payBasis" name="payBasis">${opt("hour", "The hour", m.payBasis ?? "hour")}${opt("year", "Salary", m.payBasis)}</select>`)}
    ${text("payrollId", "Payroll ID", m.payrollId ?? "", "text", 'maxlength="40"')}
    ${field("pension", "Workplace pension", `<select class="input" id="hr-f-pension" name="pension">${opt("to_assess", "Not assessed yet", m.pension)}${opt("enrolled", "Enrolled", m.pension)}${opt("opted_out", "Opted out", m.pension)}${opt("not_eligible", "Not eligible", m.pension)}</select>`)}
    ${text("probationEndsOn", "Probation ends", m.probationEndsOn ?? "", "date")}
    ${field("rtwRoute", "Right-to-work route", `<select class="input" id="hr-f-rtwRoute" name="rtwRoute">${Object.entries(RTW_LABEL).map(([k, l]) => opt(k, l, m.rtwRoute)).join("")}</select>`)}
    ${text("rtwExpiresOn", "Permission ends (share code or eVisa)", m.rtwExpiresOn ?? "", "date")}
    ${text("manager", "Manager", m.manager ?? "", "text", 'maxlength="120"')}
    ${text("email", "Email", m.email ?? "", "email", 'maxlength="200" autocomplete="off"')}
    ${text("phone", "Phone", m.phone ?? "", "tel", 'maxlength="40" autocomplete="off"')}
    ${text("dateOfBirth", "Date of birth (only needed for under-18s)", m.dateOfBirth ?? "", "date")}
    <div class="acts hr-span"><button class="btn btn-primary btn-sm" type="submit">Save changes</button></div>
  </form>
  <h3 class="hr-h">Leaving</h3>
  <form class="hr-inline" id="hr-leaving" novalidate><div class="field"><label for="hr-f-endDate">Last day of work</label><input class="input" id="hr-f-endDate" type="date" value="${esc(m.endDate ?? "")}"></div>
    <button class="btn btn-ghost btn-sm" type="submit">${m.endDate ? "Change leaving date" : "Set leaving date"}</button>${m.endDate ? `<button class="btn btn-quiet btn-sm" type="button" id="hr-unleave">They are staying</button>` : ""}</form>`;
}

function tabLeave(): string {
  const d = open!;
  const b = d.leave;
  const tiles = b.basis === "days"
    ? [fact("Allowance this year", `${b.allowance} days`), fact("Taken", `${b.taken} days`), fact("Booked", `${b.booked} days`), fact("Left", `${b.left} days`)]
    : [fact("Holiday", "Builds up at 12.07% of hours worked"), fact("Taken", `${b.taken} days`), fact("Booked", `${b.booked} days`), fact("Sick days", String(b.sickDays))];
  const rows = [...d.member.leave].sort((x, y) => y.from.localeCompare(x.from));
  const list = rows.length ? `<ul class="hr-mini">${rows.map((l) => `<li>${statusTag(l.status === "approved" ? "good" : l.status === "requested" ? "warn" : "", l.status === "approved" ? "Approved" : l.status === "requested" ? "Waiting for you" : "Declined")} <b>${esc(l.kind === "holiday" ? "Holiday" : l.kind === "sick" ? "Sick" : "Other leave")}</b> ${esc(fmtDate(l.from))}${l.to !== l.from ? ` to ${esc(fmtDate(l.to))}` : ""} · ${l.days} day${l.days === 1 ? "" : "s"}${l.note ? ` <span class="small muted">${esc(l.note)}</span>` : ""}${l.status === "requested" ? ` <button type="button" class="btn btn-primary btn-sm" data-leave="yes" data-id="${esc(l.id)}">Approve</button><button type="button" class="btn btn-ghost btn-sm" data-leave="no" data-id="${esc(l.id)}">Decline</button>` : ""}</li>`).join("")}</ul>` : `<p class="muted small">No leave recorded this year.</p>`;
  const rota = d.rota
    ? `<h3 class="hr-h">Rota this week</h3>${d.rota.shifts.length ? `<ul class="hr-mini">${d.rota.shifts.map((s) => `<li class="mono">${esc(fmtDate(s.date))} ${esc(s.start)} to ${esc(s.end)} · ${s.hours}h</li>`).join("")}</ul>` : `<p class="muted small">No shifts this week.</p>`}<p class="small muted">${d.rota.hours} of ${d.rota.cap} hours this week.</p>`
    : `<p class="small muted">${backend.live ? "Not on the rota yet." : "Shifts from the rota show here once this person is on it."}</p>`;
  return `<div class="kpis kpis-4">${tiles.join("")}</div>
    <p class="small muted">Leave year ${esc(fmtDate(b.yearStart))} to ${esc(fmtDate(b.yearEnd))}. Statutory minimum: 5.6 weeks, at most 28 days, including bank holidays unless the contract adds them on top.</p>
    <h3 class="hr-h">Leave</h3>${list}
    <form class="hr-inline" id="hr-leave-form" novalidate>
      <div class="field"><label for="hr-l-kind">Type</label><select class="input" id="hr-l-kind"><option value="holiday">Holiday</option><option value="sick">Sick</option><option value="other">Other</option></select></div>
      <div class="field"><label for="hr-l-from">First day</label><input class="input" id="hr-l-from" type="date" required></div>
      <div class="field"><label for="hr-l-to">Last day</label><input class="input" id="hr-l-to" type="date"></div>
      <div class="field"><label for="hr-l-days">Working days</label><input class="input" id="hr-l-days" type="number" min="0.5" max="260" step="0.5" required></div>
      <button class="btn btn-ghost btn-sm" type="submit">Add leave</button>
    </form>${rota}`;
}

function tabChecklists(): string {
  const d = open!;
  const list = (title: string, items: StaffDetail["onboarding"]) => items.length ? `<h3 class="hr-h">${esc(title)} <span class="mono muted">${items.filter((i) => i.doneOn).length} of ${items.length}</span></h3><ul class="hr-checks">${items.map((i) => `<li><label class="ow-check"><input type="checkbox" data-check="${esc(i.key)}"${i.doneOn ? " checked" : ""}>${esc(i.label)}${i.doneOn ? ` <span class="small muted">${esc(fmtDate(i.doneOn))}</span>` : ""}</label></li>`).join("")}</ul>` : "";
  return list("Starting", d.onboarding) + (d.leaving.length ? list("Leaving", d.leaving) : `<p class="small muted">The leaving checklist starts when you set a leaving date on Contract and pay.</p>`);
}

function tabReviews(): string {
  const m = open!.member;
  const rows = [...m.reviews];
  if (m.probationEndsOn && !rows.some((r) => r.kind === "probation")) rows.push({ id: "probation", kind: "probation", dueOn: m.probationEndsOn });
  const name = { probation: "Probation review", annual: "Yearly review", one_to_one: "One-to-one" } as const;
  return rows.length
    ? `<ul class="hr-mini">${rows.sort((a, b) => a.dueOn.localeCompare(b.dueOn)).map((r) => `<li>${statusTag(r.doneOn ? "good" : r.dueOn < toIsoDate(new Date()) ? "crit" : "info", r.doneOn ? `Held ${fmtDate(r.doneOn)}` : `Due ${fmtDate(r.dueOn)}`)} <b>${esc(name[r.kind])}</b>${r.note ? ` <span class="small muted">${esc(r.note)}</span>` : ""}${r.doneOn ? "" : ` <button type="button" class="btn btn-ghost btn-sm" data-review="${esc(r.id)}">Mark held</button>`}</li>`).join("")}</ul>`
    : `<p class="muted small">No reviews booked. Set a probation end date on Contract and pay and the review appears here.</p>`;
}

// ---------- actions ----------

async function copyRequest(staffId: string, key: string): Promise<void> {
  const d = open?.member.id === staffId ? open : await run(() => backend.detail(staffId));
  const req = d?.documents.find((x) => x.key === key);
  if (!d || !req) return;
  const msg = requestMessage(d.member, req, businessName);
  try { await navigator.clipboard.writeText(msg); } catch { /* clipboard blocked: the message is still marked requested */ }
  if (req.state === "missing") {
    const next = await run(() => backend.setDocument(staffId, key, { status: "requested" }));
    if (open?.member.id === staffId) setOpen(next); else void refresh();
  }
  toast(`Request copied. Paste it into a message to ${d.member.name.split(" ")[0]}.`);
}

function wire(): void {
  document.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const hr = t.closest<HTMLElement>("[data-hr]");
    if (hr) {
      const { staff = "", ref = "" } = hr.dataset;
      const act = hr.dataset.hr;
      if (act === "open") return void openPerson(staff, (hr.dataset.tab as Tab) ?? "overview");
      if (act === "copy") return void copyRequest(staff, ref);
      if (act === "form") return void copyFormLink(staff);
      if (act === "leave-yes" || act === "leave-no") { await run(() => backend.decideLeave(staff, ref, act === "leave-yes"), act === "leave-yes" ? "Leave approved" : "Leave declined"); return void refresh(); }
      if (act === "review-done") { await run(() => backend.completeReview(staff, ref), "Review marked as held"); return void refresh(); }
    }
    if (t.id === "hr-sector-btn") {
      const pick = $("hr-sector-pick");
      const show = pick.hasAttribute("hidden");
      pick.toggleAttribute("hidden", !show);
      t.setAttribute("aria-expanded", String(show));
      pick.innerHTML = SECTORS.map((s) => `<button type="button" class="chip" aria-pressed="${s.key === view?.settings.sector}" data-sector="${s.key}">${esc(s.label)}</button>`).join("");
      return;
    }
    const sec = t.closest<HTMLElement>("[data-sector]");
    if (sec) {
      await run(() => backend.settings({ sector: sec.dataset.sector as DeskSettings["sector"] }), "Document rules updated");
      $("hr-sector-pick").setAttribute("hidden", "");
      return void refresh();
    }
    if (!open) return;
    const id = open.member.id;
    const tabBtn = t.closest<HTMLElement>("[data-tab-key]");
    if (tabBtn) { tab = tabBtn.dataset.tabKey as Tab; renderPerson(); $(`hr-tab-${tab}`).focus(); return; }
    const doc = t.closest<HTMLElement>("[data-doc]");
    if (doc) {
      const key = doc.dataset.key!;
      if (doc.dataset.doc === "request") return void copyRequest(id, key);
      const expiry = document.querySelector<HTMLInputElement>(`[data-expiry="${CSS.escape(key)}"]`)?.value;
      if (doc.dataset.doc === "checked" && doc.dataset.needsDate === "true" && !expiry) { toast("Add the expiry date first, so we can remind you before it runs out"); document.querySelector<HTMLInputElement>(`[data-expiry="${CSS.escape(key)}"]`)?.focus(); return; }
      const status = doc.dataset.doc as DocStatus;
      return setOpen(await run(() => backend.setDocument(id, key, { status, ...(expiry && status === "checked" ? { expiresOn: expiry } : {}) }), status === "checked" ? "Marked as checked" : undefined));
    }
    const fl = t.closest<HTMLElement>("[data-form-link]");
    if (fl) return fl.dataset.formLink === "copy" ? void copyFormLink(id) : setOpen(await run(() => backend.stopFormLink(id), "Link stopped. It no longer opens."));
    const lv = t.closest<HTMLElement>("[data-leave]");
    if (lv) return setOpen(await run(() => backend.decideLeave(id, lv.dataset.id!, lv.dataset.leave === "yes"), lv.dataset.leave === "yes" ? "Leave approved" : "Leave declined"));
    const rv = t.closest<HTMLElement>("[data-review]");
    if (rv) return setOpen(await run(() => backend.completeReview(id, rv.dataset.review!), "Review marked as held"));
    if (t.id === "hr-unleave") return setOpen(await run(() => backend.setLeaving(id, null), "Leaving date removed"));
    if (t.id === "hr-p-close") $<HTMLDialogElement>("hr-person").close();
  });

  document.addEventListener("change", async (e) => {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("[data-check]");
    if (box && open) setOpen(await run(() => backend.setChecklist(open!.member.id, box.dataset.check!, box.checked)));
  });

  document.addEventListener("submit", async (e) => {
    const f = e.target as HTMLFormElement;
    if (!open || !["hr-contract", "hr-leaving", "hr-leave-form", "hr-about"].includes(f.id)) return;
    e.preventDefault();
    const id = open.member.id;
    if (f.id === "hr-about") return setOpen(await run(() => backend.updateProfile(id, readProfileFields(f, questionsNow()).profile), "Saved. The rota now follows these hours."));
    if (f.id === "hr-contract") {
      const v = (k: string) => (f.elements.namedItem(k) as HTMLInputElement | null)?.value.trim() ?? "";
      const pay = v("pay");
      const b: Record<string, unknown> = {
        jobTitle: v("jobTitle"), contract: v("contract"), hoursPerWeek: Number(v("hoursPerWeek")), daysPerWeek: Number(v("daysPerWeek")),
        payBasis: v("payBasis"), payrollId: v("payrollId"), pension: v("pension"), probationEndsOn: v("probationEndsOn"), rtwRoute: v("rtwRoute"),
        rtwExpiresOn: v("rtwExpiresOn"), manager: v("manager"), email: v("email"), phone: v("phone"), dateOfBirth: v("dateOfBirth"),
        ...(pay ? { payPence: Math.round(Number(pay) * 100) } : { payPence: "" }),
      };
      return setOpen(await run(() => backend.update(id, b), "Saved"));
    }
    if (f.id === "hr-leaving") {
      const end = $<HTMLInputElement>("hr-f-endDate").value;
      if (!isIsoDate(end)) { toast("Pick the last day of work"); return; }
      return setOpen(await run(() => backend.setLeaving(id, end), "Leaving date set. The leaving checklist has started."));
    }
    const from = $<HTMLInputElement>("hr-l-from").value;
    const to = $<HTMLInputElement>("hr-l-to").value || from;
    const days = Number($<HTMLInputElement>("hr-l-days").value);
    if (!isIsoDate(from) || !(days > 0)) { toast("Add the first day and how many working days"); return; }
    setOpen(await run(() => backend.addLeave(id, { kind: $<HTMLSelectElement>("hr-l-kind").value, from, to, days }), "Leave added"));
  });

  wireProfileFields($("hr-panel"));

  // Tabs: arrow keys move between them (WAI-ARIA tabs pattern).
  $("hr-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.findIndex(([k]) => k === tab);
    tab = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]![0];
    renderPerson();
    $(`hr-tab-${tab}`).focus();
  });

  $("hr-search").addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; renderTable(); });
  $("hr-filter").addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>("[data-filter]");
    if (!c) return;
    staffFilter = c.dataset.filter as typeof staffFilter;
    $("hr-filter").querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b === c)));
    renderTable();
  });
  $("hr-actions-more").addEventListener("click", () => { showAllActions = !showAllActions; renderActions(); });

  // Adding a person: five answers, everything else later.
  const add = $<HTMLDialogElement>("hr-add");
  $("hr-add-btn").addEventListener("click", () => {
    $<HTMLInputElement>("hr-a-start").value = addDays(toIsoDate(new Date()), 7);
    add.showModal();
    $<HTMLInputElement>("hr-a-name").focus();
  });
  $("hr-a-cancel").addEventListener("click", () => add.close());
  $<HTMLFormElement>("hr-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $<HTMLInputElement>("hr-a-name").value.trim();
    const jobTitle = $<HTMLInputElement>("hr-a-job").value.trim();
    const startDate = $<HTMLInputElement>("hr-a-start").value;
    const hoursPerWeek = Number($<HTMLInputElement>("hr-a-hours").value);
    const err = !name ? "Add their name" : !jobTitle ? "Add their job title" : !isIsoDate(startDate) ? "Pick a start date" : !(hoursPerWeek >= 0 && hoursPerWeek <= 80) ? "Hours a week must be 0 to 80" : "";
    $("hr-a-err").textContent = err;
    if (err) return;
    const d = await run(() => backend.add({ name, jobTitle, startDate, hoursPerWeek, contract: $<HTMLSelectElement>("hr-a-contract").value }), `${name} added. Here is what to collect.`);
    if (!d) return;
    if (d.rotaNote) toast(d.rotaNote);
    add.close();
    $<HTMLFormElement>("hr-add-form").reset();
    await refresh();
    void openPerson(d.member.id, "documents");
  });
}

export async function initPeople(bizName: string): Promise<void> {
  businessName = bizName;
  wire();
  if (getToken()) {
    const r = await api<Overview>("/people");
    if (r.ok && r.data) {
      backend = new ApiBackend();
      document.querySelector('[data-screen="people"] .eg')?.remove();
      view = r.data;
      renderDesk();
      return;
    }
    if (r.status === 403) {
      $("hr-locked").hidden = false;
      $("hr-body").hidden = true;
      return;
    }
  }
  await refresh();
}

/** Tells the desk the business name once the real organisation has loaded. */
export function setPeopleBusiness(name: string): void { businessName = name; }

/** The latest desk numbers, for the HR manager's own dashboard. Updates fire an "hr:updated" event. */
export function peopleSnapshot(): Overview | undefined { return view; }
