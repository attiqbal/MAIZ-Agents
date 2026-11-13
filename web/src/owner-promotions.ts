// Coupons and affiliates (owner-promotions.html): the platform owner makes codes that give free trial days, free
// energy or a discount, and runs the affiliate programme. Payouts are marked by hand; nothing is paid automatically.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, gbp, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import type { Coupon, Redemption, AffiliateView } from "../../src/modules/promotions/index";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type CouponRow = Coupon & { used: number; status: "active" | "disabled" | "expired" | "used_up"; summary: string };
type AffiliateRow = AffiliateView & { link: string; commissionText: string };
interface Overview { coupons: CouponRow[]; affiliates: AffiliateRow[]; defaults: { commission: { kind: string; value: number; months: number }; holdDays: number } }

let data: Overview;
let live = false;

const DEMO: Overview = {
  coupons: [
    { id: "eg1", code: "WELCOME-30", kind: "trial_days", value: 30, duration: { kind: "once" }, enabled: true, createdAt: "2026-11-10T09:00:00Z", createdBy: "x", used: 4, status: "active", summary: "30 more days of free trial", maxRedemptions: 50 },
    { id: "eg2", code: "HALF-OFF-3", kind: "percent_off", value: 50, duration: { kind: "months", months: 3 }, enabled: true, createdAt: "2026-11-09T09:00:00Z", createdBy: "x", used: 1, status: "active", summary: "50% off your monthly bill for 3 months", plan: "paid" },
  ],
  affiliates: [
    { id: "ea1", name: "Sam Example", email: "sam@example.co", code: "sam", commission: { kind: "percent", value: 20, months: 12 }, holdDays: 30, enabled: true, clicks: 42, createdAt: "2026-11-08T09:00:00Z", createdBy: "x", link: "https://maizagents.com/r/sam", commissionText: "20% of each payment for the first 12 months", stats: { clicks: 42, signups: 5, paying: 2, earnedGbp: 90, pendingGbp: 60, payableGbp: 30, paidGbp: 0 } },
  ],
  defaults: { commission: { kind: "percent", value: 20, months: 12 }, holdDays: 30 },
};

const KIND_LABEL: Record<string, string> = { trial_days: "Trial days", energy_credit: "Free energy", percent_off: "Percent off", fixed_off: "Pounds off", free_months: "Free months" };
const STATUS: Record<CouponRow["status"], [string, string]> = { active: ["good", "Active"], disabled: ["", "Turned off"], expired: ["warn", "Expired"], used_up: ["warn", "Used up"] };
const pill = ([tone, text]: [string, string]) => `<span class="status ${tone}"><span class="dot"></span>${esc(text)}</span>`;
const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");

function renderCoupons(): void {
  $("cp-count").textContent = `${data.coupons.length} coupon${data.coupons.length === 1 ? "" : "s"}`;
  const rows = data.coupons.map((c) => {
    const who = [c.plan === "trial" ? "Trial clients" : c.plan === "paid" ? "Paying clients" : "", c.email ?? ""].filter(Boolean).join(" · ") || "Anyone";
    return `<tr>
      <td class="ow-title"><b class="mono">${esc(c.code)}</b><span>${esc(KIND_LABEL[c.kind] ?? c.kind)}${c.note ? ` · ${esc(c.note)}` : ""}</span></td>
      <td>${esc(c.summary)}</td>
      <td class="num">${c.used.toLocaleString("en-GB")}${c.maxRedemptions ? ` of ${c.maxRedemptions.toLocaleString("en-GB")}` : ""}</td>
      <td>${esc(date(c.expiresAt))}</td><td>${esc(who)}</td><td>${pill(STATUS[c.status])}</td>
      <td><div class="acts"><button type="button" class="btn btn-quiet btn-sm" data-toggle="${esc(c.id)}" aria-label="${c.enabled ? "Turn off" : "Turn on"} ${esc(c.code)}">${c.enabled ? "Turn off" : "Turn on"}</button>
        <button type="button" class="btn btn-quiet btn-sm" data-history="${esc(c.id)}" aria-label="Uses of ${esc(c.code)}">Uses</button>
        <button type="button" class="btn btn-quiet btn-sm" data-send="${esc(c.id)}" aria-label="Email the code ${esc(c.code)}">Email it</button></div></td></tr>`;
  }).join("");
  $("cp-table").innerHTML = `<thead><tr><th scope="col">Code</th><th scope="col">Gives</th><th scope="col" class="num">Used</th><th scope="col">Stops</th><th scope="col">Who</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">No coupons yet. Make one above.</td></tr>`}</tbody>`;
}

function renderAffiliates(): void {
  $("af-count").textContent = `${data.affiliates.length} affiliate${data.affiliates.length === 1 ? "" : "s"}`;
  const rows = data.affiliates.map((a) => `<tr>
      <td class="ow-title"><b>${esc(a.name)}</b><span><a class="link" href="mailto:${esc(a.email)}">${esc(a.email)}</a></span><span class="mono">${esc(a.link)}</span></td>
      <td>${esc(a.commissionText)}<span class="xs muted" style="display:block">Paid after ${a.holdDays} days${a.enabled ? "" : " · link paused"}</span></td>
      <td class="num">${a.stats.clicks.toLocaleString("en-GB")}</td><td class="num">${a.stats.signups}</td><td class="num">${a.stats.paying}</td>
      <td class="num">${gbp(a.stats.earnedGbp)}</td><td class="num">${gbp(a.stats.pendingGbp)}</td><td class="num"><b>${gbp(a.stats.payableGbp)}</b></td><td class="num">${gbp(a.stats.paidGbp)}</td>
      <td><div class="acts"><input class="input" data-ref="${esc(a.id)}" maxlength="200" placeholder="Payment reference" aria-label="Payment reference for ${esc(a.name)}" style="min-width:150px">
        <button type="button" class="btn btn-primary btn-sm" data-pay="${esc(a.id)}"${a.stats.payableGbp > 0 ? "" : " disabled"} aria-label="Mark ${gbp(a.stats.payableGbp)} as paid to ${esc(a.name)}">Mark as paid</button>
        <button type="button" class="btn btn-quiet btn-sm" data-pause="${esc(a.id)}">${a.enabled ? "Pause" : "Resume"}</button></div></td></tr>`).join("");
  $("af-table").innerHTML = `<thead><tr><th scope="col">Affiliate</th><th scope="col">Commission</th><th scope="col" class="num">Clicks</th><th scope="col" class="num">Signups</th><th scope="col" class="num">Paying</th><th scope="col" class="num">Earned</th><th scope="col" class="num">Waiting</th><th scope="col" class="num">Ready to pay</th><th scope="col" class="num">Paid</th><th scope="col">Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="10" class="muted">No affiliates yet. Add one above.</td></tr>`}</tbody>`;
}

function renderAll(): void { renderCoupons(); renderAffiliates(); }

/** Form fields change with what the coupon gives. */
function syncCouponForm(): void {
  const kind = $<HTMLSelectElement>("cp-kind").value;
  const label: Record<string, [string, string, string]> = {
    trial_days: ["Days", "Added to the end of the client's free trial. Up to 90.", "1"], energy_credit: ["Energy", "Added to the team's energy once. Up to 100,000.", "1"],
    percent_off: ["Percent", "From 1 to 100.", "0.01"], fixed_off: ["Pounds off each month", "Taken off the monthly bill.", "0.01"], free_months: ["Free months", "Whole months with no charge. Up to 12.", "1"],
  };
  const [l, h, step] = label[kind]!;
  $("cp-value-l").textContent = l;
  $("cp-value-h").textContent = h;
  $("cp-value").setAttribute("step", step);
  const discount = kind === "percent_off" || kind === "fixed_off";
  $("cp-dur-f").hidden = !discount;
  $("cp-months-f").hidden = !discount || $<HTMLSelectElement>("cp-dur").value !== "months";
}
$("cp-kind").addEventListener("change", syncCouponForm);
$("cp-dur").addEventListener("change", syncCouponForm);
$("af-kind").addEventListener("change", () => { $("af-value-l").textContent = $<HTMLSelectElement>("af-kind").value === "percent" ? "Percent" : "Pounds per payment"; });

const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const msg = (id: string, text: string) => { $(id).textContent = text; };

$<HTMLFormElement>("cp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kind = $<HTMLSelectElement>("cp-kind").value;
  const discount = kind === "percent_off" || kind === "fixed_off";
  const dur = $<HTMLSelectElement>("cp-dur").value;
  const body = {
    code: val("cp-code"), kind, value: Number(val("cp-value")),
    ...(discount ? { duration: dur === "months" ? { kind: "months", months: Number(val("cp-months")) } : { kind: dur } } : {}),
    ...(val("cp-max") ? { maxRedemptions: Number(val("cp-max")) } : {}), ...(val("cp-exp") ? { expiresAt: `${val("cp-exp")}T23:59:59Z` } : {}),
    ...($<HTMLSelectElement>("cp-plan").value ? { plan: $<HTMLSelectElement>("cp-plan").value } : {}), ...(val("cp-email") ? { email: val("cp-email") } : {}), ...(val("cp-note") ? { note: val("cp-note") } : {}),
  };
  if (!live) { toast("Example data: connect the API to save coupons."); return; }
  const r = await api<Overview & { error?: string }>("/owner/coupons", { body });
  if (!r.ok || !r.data) { msg("cp-msg", r.data?.error ?? "Could not save. Try again."); $("cp-code").focus(); return; }
  data = r.data; renderAll();
  msg("cp-msg", `Created ${body.code.toUpperCase()}.`);
  ($("cp-form") as HTMLFormElement).reset(); syncCouponForm();
});

$<HTMLFormElement>("af-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: val("af-name"), email: val("af-email"), ...(val("af-code") ? { code: val("af-code") } : {}), commission: { kind: $<HTMLSelectElement>("af-kind").value, value: Number(val("af-value")), months: Number(val("af-months")) }, holdDays: Number(val("af-hold")) };
  if (!live) { toast("Example data: connect the API to save affiliates."); return; }
  const r = await api<Overview & { error?: string }>("/owner/affiliates", { body });
  if (!r.ok || !r.data) { msg("af-msg", r.data?.error ?? "Could not save. Try again."); $("af-name").focus(); return; }
  data = r.data; renderAll();
  msg("af-msg", `Added ${body.name}. Their link was emailed to ${body.email}.`);
  ($("af-form") as HTMLFormElement).reset(); $("af-kind").dispatchEvent(new Event("change"));
});

$("cp-table").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-toggle],[data-history],[data-send]");
  if (!b) return;
  if (!live) { toast("Example data: connect the API to use this."); return; }
  if (b.dataset.toggle) {
    const c = data.coupons.find((x) => x.id === b.dataset.toggle)!;
    const r = await api<Overview>(`/owner/coupons/${encodeURIComponent(c.id)}/enabled`, { body: { enabled: !c.enabled } });
    if (r.ok && r.data) { data = r.data; renderCoupons(); toast(c.enabled ? `${c.code} turned off` : `${c.code} turned on`); }
  } else if (b.dataset.history) {
    const c = data.coupons.find((x) => x.id === b.dataset.history)!;
    const r = await api<{ redemptions: Redemption[] }>(`/owner/coupons/${encodeURIComponent(c.id)}/redemptions`);
    if (!r.ok || !r.data) return;
    $("cp-hist-h").textContent = `Uses of ${c.code}`;
    $("cp-hist").innerHTML = `<thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What they got</th></tr></thead><tbody>${r.data.redemptions.map((x) => `<tr><td>${esc(date(x.at))}</td><td>${esc(x.email)}</td><td>${esc(x.applied)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Not used yet.</td></tr>`}</tbody>`;
    $("cp-hist-panel").hidden = false;
    $("cp-hist-close").focus();
  } else if (b.dataset.send) {
    const c = data.coupons.find((x) => x.id === b.dataset.send)!;
    const to = val("cp-send-to");
    if (!to) { toast("Type the email address in “Email a code to” first"); $("cp-send-to").focus(); return; }
    const r = await api<{ sent?: boolean; error?: string }>(`/owner/coupons/${encodeURIComponent(c.id)}/send`, { body: { to } });
    toast(r.ok ? `Sent to ${to}` : r.data?.error ?? "Could not send. Try again.");
  }
});
$("cp-hist-close").addEventListener("click", () => { $("cp-hist-panel").hidden = true; });

$("af-table").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pay],[data-pause]");
  if (!b) return;
  if (!live) { toast("Example data: connect the API to use this."); return; }
  if (b.dataset.pay) {
    const id = b.dataset.pay;
    const reference = document.querySelector<HTMLInputElement>(`[data-ref="${CSS.escape(id)}"]`)?.value.trim() ?? "";
    const r = await api<Overview & { error?: string }>(`/owner/affiliates/${encodeURIComponent(id)}/payout`, { body: { reference } });
    if (!r.ok || !r.data) { toast(r.data?.error ?? "Could not mark it as paid. Try again."); return; }
    data = r.data; renderAffiliates(); toast("Marked as paid. The affiliate was told by email.");
  } else if (b.dataset.pause) {
    const a = data.affiliates.find((x) => x.id === b.dataset.pause)!;
    const r = await api<Overview>(`/owner/affiliates/${encodeURIComponent(a.id)}/enabled`, { body: { enabled: !a.enabled } });
    if (r.ok && r.data) { data = r.data; renderAffiliates(); toast(a.enabled ? "Link paused: new visits stop counting" : "Link resumed"); }
  }
});

syncCouponForm();
void (async () => {
  const r = await ownerLoad<Overview>("/owner/promotions");
  if (!r) return;
  if (r === "demo") { data = DEMO; markDemo(); } else { data = r; live = true; }
  $<HTMLInputElement>("af-value").value = String(data.defaults.commission.value);
  $<HTMLInputElement>("af-months").value = String(data.defaults.commission.months);
  $<HTMLInputElement>("af-hold").value = String(data.defaults.holdDays);
  renderAll();
})();
