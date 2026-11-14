// Social accounts (connect-social.html): a business connects its own Facebook Page, Instagram account and WhatsApp
// number, writes posts and approves them. Everything goes through /api/meta. In test mode (before Meta approves MAIZ)
// the same screens work against a pretend Meta, so this file has no sandbox-only paths except the phone simulator.
import "./styles.css";
import { api, getToken } from "./api";
import { initNav, toast } from "./common";
import { esc, gate } from "./owner-common";

initNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Kind = "facebook" | "instagram" | "whatsapp";
interface Conn { id: string; kind: Kind; name: string; handle?: string; status: "connected" | "needs_reconnect"; mode: string; expiresAt?: string; lastError?: string; displayNumber?: string; approverNumber?: string; approverConfirmed?: boolean }
interface Post { id: string; connectionId: string; kind: "facebook" | "instagram"; text: string; code: string; status: string; scheduledFor?: string; url?: string; simulated?: boolean; error?: string; retryAt?: string; decidedVia?: string; results?: { likes: number; comments: number; shares?: number } }
interface Info { mode: "sandbox" | "live"; connections: Conn[]; kinds: Record<Kind, { key: string; plain: string }[]>; limits: { postsPerDay: number; postsPerMonth: number }; embeddedSignup?: { appId: string; configId: string; version: string } }

const TITLE: Record<Kind, string> = { facebook: "Facebook Page", instagram: "Instagram account", whatsapp: "WhatsApp number" };
const POST_STATUS: Record<string, [string, string]> = {
  awaiting_approval: ["info", "Waiting for your approval"], approved: ["info", "Approved, going out soon"], publishing: ["info", "Posting now"], retry_wait: ["warn", "Waiting to try again"],
  posted: ["good", "Posted"], rejected: ["", "Skipped"], failed: ["warn", "Did not go out"], cancelled: ["", "Cancelled"],
};
let infoState: Info | undefined;
const I = (): Info => infoState!;
let posts: Post[] = [];

const say = (text: string, bad = false): void => { const m = $("ms-msg"); m.textContent = text; m.style.color = bad ? "var(--danger, #b3261e)" : ""; };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const errOf = (r: { data?: any }) => String(r.data?.error ?? "That did not work. Nothing was changed.");

function card(kind: Kind): string {
  const c = I().connections.find((x) => x.kind === kind);
  const perms = `<details><summary class="small">What this lets MAIZ do</summary><ul class="ow-list">${I().kinds[kind].map((p) => `<li>${esc(p.plain)}</li>`).join("")}</ul></details>`;
  if (!c) {
    const action = kind === "whatsapp"
      ? `<form class="ow-stack" data-wa novalidate><div class="field"><label for="wa-num">Your own mobile number (you approve posts from it)</label><input class="input" id="wa-num" inputmode="tel" autocomplete="tel" placeholder="+44 7700 900123"><span class="hint">Include the country code. MAIZ sends a code to this number to check it is yours.</span></div><div class="acts"><button class="btn btn-primary" type="submit">Connect WhatsApp</button></div></form>`
      : `<div class="acts"><button class="btn btn-primary" type="button" data-connect="${kind}">Connect ${kind === "facebook" ? "Facebook Page" : "Instagram"}</button></div>`;
    return `<article class="panel-inset" aria-labelledby="c-${kind}"><h3 id="c-${kind}" style="margin:0 0 6px">${TITLE[kind]}</h3><p class="muted small" style="margin:0 0 10px">Not connected</p>${perms}${action}</article>`;
  }
  const ok = c.status === "connected";
  const sub = [c.handle, c.displayNumber].filter(Boolean).map((s) => esc(s!)).join(" · ");
  const wa = kind === "whatsapp" ? `<p class="small" style="margin:8px 0">Approver number ${esc(c.approverNumber ?? "")}: ${c.approverConfirmed ? "confirmed. You can approve posts by replying YES or NO." : "not confirmed yet. Reply <b>CONFIRM</b> and the 6-digit code from the message we sent."}</p><form class="acts" data-approver="${esc(c.id)}" novalidate><label class="sr-only" for="ap-${esc(c.id)}">New approver number</label><input class="input" id="ap-${esc(c.id)}" inputmode="tel" placeholder="Change number" style="max-width:220px"><button class="btn btn-quiet btn-sm" type="submit">${c.approverConfirmed ? "Change" : "Send a new code"}</button></form>` : "";
  return `<article class="panel-inset" aria-labelledby="c-${kind}"><h3 id="c-${kind}" style="margin:0 0 6px">${TITLE[kind]}</h3>
    <p style="margin:0 0 6px"><span class="status ${ok ? "good" : "warn"}"><span class="dot"></span>${ok ? "Connected" : "Needs reconnecting"}</span> <b>${esc(c.name)}</b> ${sub ? `<span class="muted small">${sub}</span>` : ""}${c.mode === "sandbox" ? ` <span class="badge">Test</span>` : ""}</p>
    ${c.lastError ? `<p class="small" style="margin:0 0 6px">${esc(c.lastError)}</p>` : ""}${wa}${perms}
    <div class="acts">${!ok && kind !== "whatsapp" ? `<button class="btn btn-primary btn-sm" type="button" data-connect="${kind}">Reconnect</button>` : ""}<button class="btn btn-quiet btn-sm" type="button" data-disconnect="${esc(c.id)}" aria-label="Disconnect ${esc(c.name)}">Disconnect</button></div></article>`;
}

function renderPosts(): void {
  const postable = I().connections.filter((c) => c.kind !== "whatsapp" && c.status === "connected");
  $("ms-post-panel").hidden = !postable.length;
  $("ms-list-panel").hidden = !posts.length && !postable.length;
  const sel = $<HTMLSelectElement>("ms-acct"), keep = sel.value;
  sel.innerHTML = postable.map((c) => `<option value="${esc(c.id)}">${esc(TITLE[c.kind])}: ${esc(c.name)}</option>`).join("");
  if (keep) sel.value = keep;
  $("ms-limits").textContent = `Up to ${I().limits.postsPerDay} posts a day per account`;
  $("ms-posts").innerHTML = posts.map((p) => {
    const [tone, label] = POST_STATUS[p.status] ?? ["", p.status];
    const waiting = p.status === "awaiting_approval";
    const res = p.results ? `<p class="small muted" style="margin:6px 0 0">${p.results.likes} likes · ${p.results.comments} comments${p.results.shares !== undefined ? ` · ${p.results.shares} shares` : ""}</p>` : "";
    return `<article class="panel-inset" aria-label="Post: ${esc(p.text.slice(0, 40))}">
      <p style="margin:0 0 6px"><span class="status ${tone}"><span class="dot"></span>${esc(label)}</span> <span class="muted small">${p.kind === "facebook" ? "Facebook" : "Instagram"}${p.scheduledFor ? ` · for ${esc(when(p.scheduledFor))}` : ""}${waiting ? ` · code <b class="mono">${esc(p.code)}</b>` : ""}${p.decidedVia === "whatsapp" ? " · approved on WhatsApp" : ""}</span></p>
      <p style="margin:0;white-space:pre-wrap">${esc(p.text)}</p>${res}
      ${p.error ? `<p class="small" style="margin:6px 0 0">${esc(p.error)}</p>` : ""}
      ${p.status === "posted" && p.url ? `<p class="small" style="margin:6px 0 0">${p.simulated ? "Test post (nothing was published)" : `<a class="link" href="${esc(p.url)}" rel="noopener" target="_blank">See it on ${p.kind === "facebook" ? "Facebook" : "Instagram"}</a>`}</p>` : ""}
      <div class="acts">${waiting ? `<button class="btn btn-primary btn-sm" type="button" data-post="${esc(p.id)}" data-act="approve">Approve and post</button><button class="btn btn-quiet btn-sm" type="button" data-post="${esc(p.id)}" data-act="reject">Skip it</button>` : ""}
        ${["approved", "retry_wait"].includes(p.status) ? `<button class="btn btn-quiet btn-sm" type="button" data-post="${esc(p.id)}" data-act="cancel">Cancel</button>` : ""}
        ${p.status === "posted" ? `<button class="btn btn-quiet btn-sm" type="button" data-post="${esc(p.id)}" data-act="results">Refresh results</button>` : ""}</div></article>`;
  }).join("") || `<p class="muted">No posts yet.</p>`;
}

function render(): void {
  $("ms-mode").hidden = I().mode !== "sandbox";
  $("ms-sandbox").hidden = I().mode !== "sandbox";
  $("ms-cards").innerHTML = (["facebook", "instagram", "whatsapp"] as Kind[]).map(card).join("");
  const wa = I().connections.find((c) => c.kind === "whatsapp");
  $("ms-sbx-panel").hidden = I().mode !== "sandbox" || !wa;
  renderPosts();
}

async function load(): Promise<void> {
  const [i, p] = await Promise.all([api<Info>("/meta"), api<{ posts: Post[] }>("/meta/posts")]);
  if (!i.ok || !i.data) { if (i.status === 401 || i.status === 403) gate("Log in to connect your accounts", "Log in, then come back to this page.", ["/signin.html", "Log in"]); else gate("This page did not load", "Nothing was changed. Reload the page to try again.", [location.pathname, "Reload"]); return; }
  infoState = i.data; posts = p.data?.posts ?? [];
  render();
  void showInsights();
  if (I().mode === "sandbox") void showOutbox();
}

async function showInsights(): Promise<void> {
  const r = await api<{ insights: { name: string; kind: Kind; insights?: { followers: number; reach?: number }; error?: string }[] }>("/meta/insights");
  const rows = r.data?.insights ?? [];
  $("ms-ins-panel").hidden = !rows.length;
  $("ms-ins").innerHTML = rows.map((x) => `<div class="tile-kpi"><span class="l">${esc(x.name)}</span><span class="v">${x.insights ? x.insights.followers.toLocaleString("en-GB") : "–"}</span><span class="dl">${x.insights ? `followers${x.insights.reach !== undefined ? ` · reach ${x.insights.reach.toLocaleString("en-GB")}` : ""}` : esc(x.error ?? "")}</span></div>`).join("");
}

async function showOutbox(): Promise<void> {
  const r = await api<{ outbox: { at: string; text: string }[] }>("/meta/sandbox/outbox");
  $("ms-outbox").innerHTML = (r.data?.outbox ?? []).map((m) => `<li><span class="muted small">${esc(when(m.at))}</span> ${esc(m.text)}</li>`).join("") || `<li class="muted">Nothing sent yet.</li>`;
}

// ---- the Meta window comes back with ?result=... and #pending=... ----
async function afterLogin(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const result = q.get("result");
  const pending = /pending=([0-9a-f]+)/.exec(location.hash)?.[1];
  if (!result) return;
  history.replaceState(null, "", location.pathname);
  if (result === "cancelled") return say("No problem. Nothing was connected.");
  if (result === "failed") return say("That login did not work. Nothing was connected. Please try again.", true);
  if (result !== "choose" || !pending) return;
  const kind = (q.get("kind") ?? "facebook") as Kind;
  const r = await api<{ choices: { index: number; name: string; handle?: string }[]; missing: { key: string; plain: string }[] }>(`/meta/pending/${pending}`);
  if (!r.ok || !r.data) return say("That choice has expired. Please start again.", true);
  $("ms-choose").hidden = false;
  $("ms-choices").innerHTML = r.data.choices.map((c) => `<button type="button" class="btn btn-ghost" data-pick="${c.index}">${esc(c.name)}${c.handle ? ` ${esc(c.handle)}` : ""}</button>`).join("") || `<p class="muted">We could not find a ${esc(TITLE[kind])} on that login. Check that you ticked it in the Facebook window, then try again.</p>`;
  $("ms-missing").innerHTML = r.data.missing.length ? `<b>Facebook did not give MAIZ everything it needs:</b><ul class="ow-list">${r.data.missing.map((m) => `<li>${esc(m.plain)}</li>`).join("")}</ul>Reconnect and leave every box ticked.` : "";
  $("ms-choices").dataset.pending = pending;
}

// ---- WhatsApp Embedded Signup (real Meta window; test mode uses a pretend one) ----
function loadSdk(cfg: NonNullable<Info["embeddedSignup"]>): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).FB) return resolve();
    (window as any).fbAsyncInit = () => { (window as any).FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.version }); resolve(); };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js"; s.async = true; s.onerror = () => reject(new Error("blocked"));
    document.head.appendChild(s);
  });
}

async function connectWhatsApp(number: string): Promise<void> {
  const cfg = I().embeddedSignup;
  let body: Record<string, string>;
  if (I().mode === "sandbox" || !cfg) body = { code: "sandbox-whatsapp", wabaId: "sandbox-waba-1", phoneNumberId: "sandbox-phone-1" };
  else {
    try { await loadSdk(cfg); } catch { return say("The WhatsApp window could not open. Check that an ad blocker is not stopping it, then try again.", true); }
    body = await new Promise<Record<string, string>>((resolve) => {
      let ids: { waba_id?: string; phone_number_id?: string } | undefined;
      const onMessage = (e: MessageEvent) => {
        if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
        try { const d = JSON.parse(String(e.data)); if (d.type === "WA_EMBEDDED_SIGNUP" && d.event === "FINISH") ids = d.data; } catch { /* not ours */ }
      };
      window.addEventListener("message", onMessage);
      (window as any).FB.login((resp: any) => {
        window.removeEventListener("message", onMessage);
        const code = resp?.authResponse?.code;
        setTimeout(() => resolve(code && ids?.waba_id && ids.phone_number_id ? { code, wabaId: ids.waba_id, phoneNumberId: ids.phone_number_id } : {}), 400);
      }, { config_id: cfg.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: "3" } });
    });
    if (!body.code) return say("WhatsApp was not connected. Nothing was changed.");
  }
  const r = await api("/meta/whatsapp", { body: { ...body, approverNumber: number } });
  if (!r.ok) return say(errOf(r), true);
  say("WhatsApp is connected. We sent a code to your phone: reply CONFIRM and the code to approve posts from it.");
  await load();
}

document.addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!t) return;
  if (t.dataset.connect) {
    say("Opening Facebook…");
    const r = await api<{ url: string }>("/meta/connect", { body: { kind: t.dataset.connect } });
    if (r.ok && r.data?.url) location.assign(r.data.url); else say(errOf(r), true);
  } else if (t.dataset.disconnect) {
    const r = await api(`/meta/connections/${encodeURIComponent(t.dataset.disconnect)}`, { method: "DELETE" });
    say(r.ok ? "Disconnected. MAIZ can no longer reach that account." : errOf(r), !r.ok); await load();
  } else if (t.dataset.pick) {
    const r = await api("/meta/choose", { body: { pendingId: $("ms-choices").dataset.pending, index: Number(t.dataset.pick) } });
    $("ms-choose").hidden = true; say(r.ok ? "Connected." : errOf(r), !r.ok); await load();
  } else if (t.dataset.post) {
    t.setAttribute("disabled", "");
    const r = await api(`/meta/posts/${encodeURIComponent(t.dataset.post)}/${t.dataset.act}`, { body: {} });
    say(r.ok ? (t.dataset.act === "approve" ? "Approved." : "Done.") : errOf(r), !r.ok); await load();
  } else if (t.id === "ms-delete") {
    if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "Press again to delete everything. This cannot be undone."; return; }
    const r = await api<{ deletion: { code: string } }>("/meta/delete-data", { body: {} });
    say(r.ok ? `Deleted. Your confirmation code is ${r.data?.deletion.code}.` : errOf(r), !r.ok); await load();
  }
});

document.addEventListener("submit", async (e) => {
  const f = e.target as HTMLFormElement;
  if (f.dataset.wa !== undefined) { e.preventDefault(); await connectWhatsApp((f.querySelector("input") as HTMLInputElement).value); }
  else if (f.dataset.approver) {
    e.preventDefault();
    const r = await api(`/meta/connections/${encodeURIComponent(f.dataset.approver)}/approver`, { body: { number: (f.querySelector("input") as HTMLInputElement).value } });
    say(r.ok ? "We sent a new code to that number." : errOf(r), !r.ok); await load();
  }
});

$("ms-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = (id: string) => $<HTMLInputElement>(id).value.trim();
  const when = v("ms-when");
  const r = await api("/meta/posts", { body: { connectionId: v("ms-acct"), text: v("ms-text"), imageUrl: v("ms-img") || undefined, linkUrl: v("ms-link") || undefined, scheduledFor: when ? new Date(when).toISOString() : undefined } });
  if (!r.ok) return say(errOf(r), true);
  ($("ms-form") as HTMLFormElement).reset();
  toast("Waiting for your approval"); say(""); await load();
});

$("ms-reply").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $<HTMLInputElement>("ms-reply-t");
  await api("/meta/sandbox/whatsapp-reply", { body: { text: t.value } });
  t.value = ""; await load();
});

void (async () => {
  if (!getToken()) { gate("Log in to connect your accounts", "Log in, then come back to this page.", ["/signin.html", "Log in"]); return; }
  await load();
  if (infoState) await afterLogin();
})();
