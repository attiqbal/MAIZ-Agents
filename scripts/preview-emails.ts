/** Writes every email to email-preview/ and an index page that shows each one at desktop and phone width. Run: npm run emails:preview */
import { mkdirSync, writeFileSync } from "node:fs";
import { sampleEmails } from "../src/server/email-samples.js";

const out = "email-preview";
mkdirSync(out, { recursive: true });
const base = process.env.APP_URL ?? "https://maizagents.com";
const items = sampleEmails({ baseUrl: base, supportEmail: process.env.SUPPORT_EMAIL || undefined });
for (const [name, m] of Object.entries(items)) {
  writeFileSync(`${out}/${name}.html`, m.html!);
  writeFileSync(`${out}/${name}.txt`, m.text);
}
const cards = Object.entries(items).map(([name, m]) => `<section><h2>${name}</h2><p>Subject: <b>${m.subject.replace(/</g, "&lt;")}</b> · <a href="${name}.txt">plain text</a></p><div class="row"><iframe src="${name}.html" title="${name} desktop" style="width:640px"></iframe><iframe src="${name}.html" title="${name} phone" style="width:375px"></iframe></div></section>`).join("\n");
writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>MAIZ emails</title><style>body{font:15px system-ui;margin:24px;background:#eee}section{margin-bottom:40px}.row{display:flex;gap:20px;flex-wrap:wrap}iframe{height:760px;border:1px solid #ccc;background:#fff}</style><h1>MAIZ Agents emails</h1>${cards}`);
console.log(`Wrote ${Object.keys(items).length} emails to ${out}/index.html`);
