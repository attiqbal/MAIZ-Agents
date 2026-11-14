// "Can I see your numbers?" One employee asks for read access to an app, the owner connects it
// right in the conversation, and the employee TESTS the connection and reports what they actually
// read, or the real reason it failed. Nothing is reported as connected unless the app answered.
import { api, getToken } from "./api";
import { chips, esc, note, reply, speak } from "./firstday-ui";

export interface CatalogueItem {
  key: string; name: string; category: string; summary: string; availability: string;
  connect: "oauth" | "api_key" | "webhook" | "file" | "bridge"; fields?: { key: string; label: string; help?: string }[];
  howToExport?: string[]; acceptsFiles: boolean;
}
export interface Connection { id: string; connectorKey: string; status: string; lastSyncAt?: string; lastError?: string }
interface ImportResult { added: number; updated: number; unchanged: number; warnings: string[]; conflicts: string[] }

const MAX_FILE = 2_000_000; // the server's own limit is a little higher; this keeps a bad pick from hanging the page

/** What the employee says after reading: only counts the app really returned. */
export function describeRead(name: string, r: ImportResult): string {
  const total = r.added + r.updated + r.unchanged;
  if (!total) return `${name} answered, but there was nothing in the last 30 days, so I have nothing to show yet. That's fine: I'll pick up new records as they appear.`;
  const bits = [r.added ? `${r.added} new` : "", r.updated ? `${r.updated} updated` : "", r.unchanged ? `${r.unchanged} I already had` : ""].filter(Boolean).join(", ");
  const warn = r.warnings.length ? ` One thing to know: ${r.warnings[0]}` : "";
  return `It works. I just read ${total} record${total === 1 ? "" : "s"} from ${name} (${bits}).${warn} I can only look: I can't change anything there.`;
}

const failText = (name: string, why: string | undefined) => `That didn't work${why ? `: ${why}` : ""}. Nothing was changed on your side. You can try again from Apps whenever you like.`;

/** Test a connection that exists. Returns true when the app answered. */
export async function testConnection(who: string, item: CatalogueItem, conn: Connection): Promise<boolean> {
  await speak({ who, text: `Let me check that ${item.name} really answers…` });
  if (item.connect === "file" || item.connect === "webhook") {
    await speak({ who, text: conn.lastSyncAt ? `${item.name} has data from ${new Date(conn.lastSyncAt).toLocaleDateString()}.` : `${item.name} is set up, but nothing has arrived yet. I'll use it as soon as something does.` });
    return !!conn.lastSyncAt;
  }
  const r = await api<ImportResult & { error?: string }>(`/integrations/connections/${encodeURIComponent(conn.id)}/sync`, { body: {} });
  if (r.ok && r.data) { await speak({ who, text: describeRead(item.name, r.data) }); return true; }
  await speak({ who, text: failText(item.name, r.data?.error) });
  return false;
}

type Outcome = "connected" | "skipped" | "redirected";

/** Offer the apps; run the owner's choice end to end. */
export async function offerApps(who: string, items: CatalogueItem[], returnToFirstDay = true): Promise<Outcome> {
  const choice = await reply<string>((host, done) => {
    chips(host, "Apps you can connect", [...items.map((i) => ({ v: i.key, label: `${i.name}${i.connect === "file" ? " (upload a file)" : ""}` })), { v: "", label: "Not now", quiet: true }],
      (v, label) => done(v, v ? `Let's do ${items.find((i) => i.key === v)?.name ?? label}.` : "Not now, thanks."));
  });
  const item = items.find((i) => i.key === choice);
  if (!item) { await speak({ who, text: "No problem. I'll work from what you've told me, and you can connect any app later from Apps." }); return "skipped"; }
  if (!getToken()) {
    await speak({ who, text: `In a real account this is where ${item.name} would ask you to approve read-only access, and I'd test it straight away. This is a preview, so nothing is connected.` });
    return "skipped";
  }
  switch (item.connect) {
    case "oauth": return startOAuth(who, item, returnToFirstDay);
    case "api_key": return withKey(who, item);
    case "file": return withFile(who, item);
    default: return withLink(who);
  }
}

async function startOAuth(who: string, item: CatalogueItem, back: boolean): Promise<Outcome> {
  await speak({ who, text: `I'll send you to ${item.name} to approve read-only access. When you come back I'll test it.` });
  const r = await api<{ url?: string; error?: string }>(`/integrations/apps/${encodeURIComponent(item.key)}/connect`, { body: back ? { returnTo: "firstday" } : {} });
  if (r.ok && r.data?.url) {
    try { sessionStorage.setItem("maiz.fd.pending", item.key); } catch { /* storage unavailable */ }
    location.assign(r.data.url);
    return "redirected";
  }
  await speak({ who, text: failText(item.name, r.data?.error ?? "connecting isn't switched on for this app on this site yet") });
  return "skipped";
}

async function withKey(who: string, item: CatalogueItem): Promise<Outcome> {
  await speak({ who, text: `${item.name} gives you a key I can use to read. Paste it here. It's stored encrypted and used only to read.` });
  const values = await reply<Record<string, string>>((host, done) => {
    const form = document.createElement("form");
    form.className = "fd-form";
    form.innerHTML = (item.fields ?? []).map((f) => `<div class="field"><label for="fdk-${esc(f.key)}">${esc(f.label)}</label><input class="input" id="fdk-${esc(f.key)}" name="${esc(f.key)}" type="password" autocomplete="off" spellcheck="false">${f.help ? `<span class="hint">${esc(f.help)}</span>` : ""}</div>`).join("") +
      `<div class="acts"><button class="btn btn-primary btn-sm" type="submit">Connect</button><button class="btn btn-quiet btn-sm" type="button" data-skip>Not now</button></div>`;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v: Record<string, string> = {};
      new FormData(form).forEach((val, k) => { v[k] = String(val).trim(); });
      if (Object.values(v).some((x) => !x)) { note(form, "Fill in each box, or choose Not now.", "err"); return; }
      done(v, "Here's the key.");
    });
    form.querySelector("[data-skip]")!.addEventListener("click", () => done({}, "Actually, not now."));
    host.appendChild(form);
  });
  if (!Object.keys(values).length) { await speak({ who, text: "Okay. It'll be there in Apps when you're ready." }); return "skipped"; }
  const r = await api<{ connection?: Connection; error?: string }>(`/integrations/apps/${encodeURIComponent(item.key)}/connect`, { body: { values } });
  if (!r.ok || !r.data?.connection) { await speak({ who, text: failText(item.name, r.data?.error) }); return "skipped"; }
  return (await testConnection(who, item, r.data.connection)) ? "connected" : "skipped";
}

async function withFile(who: string, item: CatalogueItem): Promise<Outcome> {
  const steps = (item.howToExport ?? ["Export the report as a CSV file from the app."]).map((s, i) => `${i + 1}. ${s}`).join("\n");
  await speak({ who, text: `${item.name} doesn't let me read it directly, so I'll work from a file you export. Here's how:\n${steps}` });
  const payroll = item.category === "payroll";
  const file = await reply<{ text: string; date?: string } | null>((host, done) => {
    const form = document.createElement("form");
    form.className = "fd-form";
    form.innerHTML = `<div class="field"><label for="fdf">Your exported file (CSV)</label><input class="input" id="fdf" type="file" accept=".csv,text/csv,text/plain"></div>${payroll ? `<div class="field"><label for="fdd">Pay date of this file</label><input class="input" id="fdd" type="date"></div>` : ""}<div class="acts"><button class="btn btn-primary btn-sm" type="submit">Send the file</button><button class="btn btn-quiet btn-sm" type="button" data-skip>Not now</button></div>`;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = (form.querySelector("#fdf") as HTMLInputElement).files?.[0];
      if (!f) { note(form, "Choose the file first, or pick Not now.", "err"); return; }
      if (f.size > MAX_FILE) { note(form, "That file is too big. Export a shorter date range.", "err"); return; }
      done({ text: await f.text(), date: (form.querySelector("#fdd") as HTMLInputElement | null)?.value || undefined }, `Sent ${f.name}.`);
    });
    form.querySelector("[data-skip]")!.addEventListener("click", () => done(null, "Not now."));
    host.appendChild(form);
  });
  if (!file) { await speak({ who, text: "No problem. You can upload it any time from Apps." }); return "skipped"; }
  await speak({ who, text: "Reading it now…" });
  const r = await api<ImportResult & { error?: string }>(`/integrations/apps/${encodeURIComponent(item.key)}/import`, { body: { csv: file.text, date: file.date } });
  if (r.ok && r.data) { await speak({ who, text: describeRead(item.name, r.data) }); return "connected"; }
  await speak({ who, text: failText(item.name, r.data?.error) });
  return "skipped";
}

async function withLink(who: string): Promise<Outcome> {
  const r = await api<{ url?: string; error?: string }>("/integrations/apps/webhook/connect", { body: {} });
  if (!r.ok || !r.data?.url) { await speak({ who, text: failText("the link", r.data?.error) }); return "skipped"; }
  await speak({ who, text: "This app connects through Zapier or Make. Here's your private link; paste it into a step that sends data to a URL. I'm showing it once, and I can't recover it, only replace it. I'll only be able to tell it works once data actually arrives." });
  await reply<true>((host, done) => {
    const box = document.createElement("div");
    box.className = "fd-form";
    box.innerHTML = `<div class="field"><label for="fdl">Your private link</label><input class="input mono" id="fdl" readonly value="${esc(r.data!.url!)}"></div><div class="acts"><button class="btn btn-primary btn-sm" type="button">I've saved it</button></div>`;
    (box.querySelector("#fdl") as HTMLInputElement).addEventListener("focus", (e) => (e.target as HTMLInputElement).select());
    box.querySelector("button")!.addEventListener("click", () => done(true, "Saved it."));
    host.appendChild(box);
  });
  return "connected";
}
