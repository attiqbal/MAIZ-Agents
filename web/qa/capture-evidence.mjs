// Captures the named state screenshots in qa/evidence against a running server: ALLOW_DEV_AUTH=1 npm start, then node qa/capture-evidence.mjs
import { chromium } from "playwright";
const B = process.env.QA_URL ?? "http://localhost:8787", OUT = new URL("./evidence/", import.meta.url).pathname;
const b = await chromium.launch();
const ctxFor = (w, h) => b.newContext({ viewport: { width: w, height: h } });
const sizes = { 1440: [1440, 900], 375: [375, 812] };
const shot = (p, name) => p.screenshot({ path: OUT + name });
async function onboardTo(p, step) {
  await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
  await p.evaluate(() => { sessionStorage.clear(); localStorage.removeItem("maiz.profile"); }); await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
  if (step === 1) { await p.click('#sectors [data-v="food-drink"]'); await p.fill("#biz", "Kestrel Coffee"); return; }
  await p.click('#sectors [data-v="food-drink"]'); await p.fill("#biz", "Kestrel Coffee"); await p.selectOption("#country", "GB"); await p.click("#biz-go");
  if (step === 2) return;
  await p.click("#needs-go"); if (step === 3) { await p.click('#apps [data-v="square"]').catch(() => {}); return; }
  await p.click("#apps-go"); await p.waitForTimeout(300);
}
for (const w of [1440, 375]) {
  const ctx = await ctxFor(...sizes[w]); const p = await ctx.newPage(); const sz = `${sizes[w][0]}x${sizes[w][1]}`;
  for (const s of [1, 2, 3, 4]) { await onboardTo(p, s); await p.waitForTimeout(250); await shot(p, `signup-${s}-${["", "sector", "needs", "apps", "plan"][s]}-${sz}.png`); }
  await p.goto(B + "/employees.html#store", { waitUntil: "networkidle" }); await p.locator("#store").scrollIntoViewIfNeeded(); await p.waitForTimeout(300); await shot(p, `store-${sz}.png`);
  await p.goto(B + "/review.html", { waitUntil: "networkidle" }); await p.waitForTimeout(300); await shot(p, `review-queue-${sz}.png`);
  await ctx.close();
}
// Phone states of onboarding
{
  const ctx = await ctxFor(375, 812); const p = await ctx.newPage();
  await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" }); await p.evaluate(() => sessionStorage.clear()); await p.reload({ waitUntil: "networkidle" }); await p.click("#biz-go"); await p.waitForTimeout(200); await shot(p, "state-error-onboarding-375x812.png");
  await onboardTo(p, 4); await p.fill("#email", `cap${Date.now()}@kestrel.test`); await p.fill("#pw", "correct horse battery"); await p.click("#email-go");
  await p.waitForSelector('[data-step="5"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  await p.click('[data-step="5"] [data-next]'); await p.waitForTimeout(900); await shot(p, "state-loading-onboarding-375x812.png");
  await p.waitForSelector("#open-app", { state: "visible", timeout: 9000 }).catch(() => {}); await p.waitForTimeout(800); await shot(p, "state-success-onboarding-375x812.png");
  await p.click("#open-app"); await p.waitForURL(/app\.html/); await p.goto(B + "/app.html#setup", { waitUntil: "networkidle" }); await p.waitForTimeout(800); await shot(p, "setup-prefilled-375x812.png");
  const token = await p.evaluate(() => localStorage.getItem("maiz.token")); const prof = await p.evaluate(() => localStorage.getItem("maiz.profile"));
  await ctx.close();
  // Signed-in desktop states with the same client
  const c2 = await ctxFor(1440, 900); const q = await c2.newPage();
  await q.goto(B + "/signin.html"); await q.evaluate(([t, pr]) => { localStorage.setItem("maiz.token", t); if (pr) localStorage.setItem("maiz.profile", pr); }, [token, prof]);
  for (const [hash, name] of [["home", "state-partial-app"], ["approvals", "state-empty-approvals"], ["setup", "setup-prefilled"], ["apps", "apps-signed-in"], ["settings", "settings-topups"], ["work", "tasks-signoff"]]) {
    await q.goto(B + "/app.html#" + hash, { waitUntil: "networkidle" }); await q.waitForTimeout(700); await shot(q, `${name}-1440x900.png`);
  }
  await q.goto(B + "/app.html#apps", { waitUntil: "networkidle" }); await q.waitForTimeout(500);
  await q.locator("#apps-grid .app-card button").first().click().catch(() => {}); await q.waitForTimeout(500); await shot(q, "apps-upload-1440x900.png"); await q.keyboard.press("Escape");
  await q.goto(B + "/app.html#store", { waitUntil: "networkidle" }); await q.waitForTimeout(700);
  const opts = await q.$$eval("#store-pick option", (o) => o.map((x) => x.value).filter(Boolean));
  const consultant = opts.find((v) => /:/.test(v)) ?? opts.at(-1);
  await q.selectOption("#store-pick", opts[0]); await q.waitForTimeout(200); await q.click("#store-add").catch(() => {}); await q.waitForTimeout(300); await shot(q, "store-billing-1440x900.png");
  await q.selectOption("#store-pick", consultant); await q.waitForTimeout(300); await q.screenshot({ path: OUT + "store-consultants-1440.png" });
  await c2.close();
}
await b.close();
