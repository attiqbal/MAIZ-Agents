// Affiliate page (affiliate.html): an affiliate logs in with their email and sees their own link, clicks, signups
// and commission. It never shows who the referred businesses are.
import "./styles.css";
import { api, getToken } from "./api";
import { initNav, toast } from "./common";
import { esc, gbp, gate } from "./owner-common";

initNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface View {
  name: string; code: string; link: string; enabled: boolean; commissionText: string; holdDays: number;
  stats: { clicks: number; signups: number; paying: number; earnedGbp: number; pendingGbp: number; payableGbp: number; paidGbp: number };
  commissions: { at: string; amountGbp: number; status: "pending" | "payable" | "paid"; payableFrom: string }[];
  payouts: { at: string; amountGbp: number; reference: string | null }[];
}

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const STATUS = { pending: ["warn", "Waiting"], payable: ["info", "Ready to be paid"], paid: ["good", "Paid"] } as const;

function render(v: View): void {
  $<HTMLInputElement>("af-link").value = v.link;
  $("af-terms").textContent = `${v.enabled ? "" : "This link is paused, so new visits do not count. "}You earn ${v.commissionText}. Commission is paid by hand ${v.holdDays} days after the payment it comes from.`;
  const tile = (label: string, value: string, note: string) => `<div class="tile-kpi"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span><span class="dl">${esc(note)}</span></div>`;
  const s = v.stats;
  $("af-kpis").innerHTML = [
    tile("Link opened", s.clicks.toLocaleString("en-GB"), "Visits to your link"), tile("Signed up", String(s.signups), `${s.paying} paying`),
    tile("Earned", gbp(s.earnedGbp), `${gbp(s.pendingGbp)} still waiting`), tile("Ready to be paid", gbp(s.payableGbp), "You are paid by hand"), tile("Paid to you", gbp(s.paidGbp), "So far"),
  ].join("");
  $("af-comm").innerHTML = `<thead><tr><th scope="col">Payment date</th><th scope="col" class="num">Your commission</th><th scope="col">Status</th></tr></thead><tbody>${
    v.commissions.map((c) => `<tr><td>${esc(date(c.at))}</td><td class="num">${gbp(c.amountGbp)}</td><td><span class="status ${STATUS[c.status][0]}"><span class="dot"></span>${STATUS[c.status][1]}${c.status === "pending" ? ` until ${esc(date(c.payableFrom))}` : ""}</span></td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">No commission yet. It appears when someone you referred makes a payment.</td></tr>`}</tbody>`;
  $("af-pay").innerHTML = `<thead><tr><th scope="col">Date</th><th scope="col" class="num">Amount</th><th scope="col">Reference</th></tr></thead><tbody>${
    v.payouts.map((p) => `<tr><td>${esc(date(p.at))}</td><td class="num">${gbp(p.amountGbp)}</td><td>${esc(p.reference ?? "")}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nothing paid yet.</td></tr>`}</tbody>`;
}

$("af-copy").addEventListener("click", async () => {
  const link = $<HTMLInputElement>("af-link").value;
  try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { $<HTMLInputElement>("af-link").select(); toast("Press Ctrl+C to copy the link"); }
});

void (async () => {
  if (!getToken()) {
    if ((await api("/health")).status === 0) {
      $("ow-eg").hidden = false;
      render({ name: "Sam Example", code: "sam", link: "https://maizagents.com/r/sam", enabled: true, commissionText: "20% of each payment for the first 12 months", holdDays: 30, stats: { clicks: 42, signups: 5, paying: 2, earnedGbp: 90, pendingGbp: 60, payableGbp: 30, paidGbp: 0 }, commissions: [], payouts: [] });
      return;
    }
    gate("Log in to see your affiliate page", "Log in with the email address your link was sent to. If you have no password, choose “Email me a log-in link”. Then come back to this page.", ["/signin.html", "Log in"]);
    return;
  }
  const r = await api<{ affiliate: View | null }>("/affiliate/me");
  if (r.status === 401) { gate("Log in to see your affiliate page", "Your login has ended. Log in again with the email address your link was sent to.", ["/signin.html", "Log in"]); return; }
  if (!r.ok || !r.data) { gate("This page did not load", "Reload the page to try again.", [location.pathname, "Reload"]); return; }
  if (!r.data.affiliate) { gate("This email is not an affiliate", "You are logged in with an email that has no affiliate page. Log in with the address your link was sent to.", ["/signin.html", "Switch account"]); return; }
  render(r.data.affiliate);
})();
