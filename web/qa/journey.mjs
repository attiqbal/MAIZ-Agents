// One owner's whole journey, driven like a person: onboarding as a conversation, arrival of the team,
// then the first-day conversation in the control centre. Needs the API running (see flows.mjs).
// Usage: QA_URL=http://localhost:8787 [SHOTS=dir] node qa/journey.mjs
import { chromium } from "playwright";
const B = process.env.QA_URL ?? "http://localhost:8787";
const SHOTS = process.env.SHOTS;
let fails = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + d}`); if (!c) fails++; };
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [w, h] of [[375, 812], [1440, 900]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404") && !m.text().includes("503")) errs.push(m.text()); });
  const shot = (n) => SHOTS && p.screenshot({ path: `${SHOTS}/${n}-${w}.png`, fullPage: false });
  await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
  ok(`${w}: step 1 is Maya talking`, /Maya/.test(await p.textContent('[data-step="1"] .ob-who')));
  await p.click('#sectors [data-v="food-drink"]'); await p.fill("#biz", "Kestrel Coffee"); await p.selectOption("#country", "GB");
  await shot("1-hello"); await p.click("#biz-go"); await p.click("#needs-go");
  await p.click('#apps [data-v="square"]'); await shot("3-apps"); await p.click("#apps-go");
  ok(`${w}: plan names the people`, /will start with/.test(await p.textContent("#plan-focus")));
  await shot("4-plan");
  await p.fill("#email", `j${Date.now()}${w}@example-cafe.test`); await p.fill("#pw", "correct horse battery"); await p.click("#email-go");
  await p.waitForSelector('[data-step="5"]:not([hidden])'); await p.click('[data-step="5"] [data-next]');
  await p.waitForSelector("#open-app", { state: "visible", timeout: 10000 });
  ok(`${w}: team arrives as people`, (await p.locator(".arrival").count()) >= 5, String(await p.locator(".arrival").count()));
  await shot("6-arrival");
  await p.click("#open-app"); await p.waitForURL(/app\.html#firstday/);
  await p.waitForSelector(".fd-msg");
  // Answer every question the team asks until the closing options appear.
  for (let i = 0; i < 80; i++) {
    if (await p.locator('.fd-reply [data-v="home"]').count()) break;
    const r = p.locator("#fd-reply");
    if (await r.isHidden()) { await p.waitForTimeout(150); continue; }
    const text = (await r.innerText()).trim();
    if (!text) { await p.waitForTimeout(150); continue; }
    if (await r.locator("[data-skip]").count()) await r.locator("[data-skip]").click();
    else if (await r.locator('[data-v="y"]').count() && await r.locator(".chip").count() <= 3) await r.locator('[data-v="y"]').first().click();
    else if (await r.locator('[data-v="__skip"]').count()) await r.locator('[data-v="__skip"]').click();
    else if (await r.locator('textarea, input:not([type=file]):not([type=password])').count()) { const f = r.locator("textarea, input").first(); await f.fill((await f.getAttribute("inputmode")) === "numeric" ? "5" : "Grow the café and tidy the books"); await r.locator('button[type="submit"]').click(); }
    else if (await r.locator('[data-v=""]').count()) await r.locator('[data-v=""]').click();
    else if (await r.locator('[data-v="n"]').count() && await r.locator('[data-v]').count() === 2) await r.locator('[data-v="n"]').click();
    else if (await r.locator(".fd-opts [aria-pressed]").count()) await r.getByRole("button", { name: "Done" }).click();
    else if (await r.locator(".fd-opts .chip").count()) await r.locator(".fd-opts .chip").first().click();
    else await p.waitForTimeout(150);
    await p.waitForTimeout(60);
    if (i === 6) await shot("7-first-day-questions");
  }
  ok(`${w}: conversation reached the end`, await p.locator('.fd-reply [data-v="home"]').count() > 0);
  const log = await p.locator("#fd-log").innerText();
  ok(`${w}: setup actually ran`, /✓/.test(log), log.slice(-300));
  ok(`${w}: the team introduced themselves`, /Felix/.test(log) && /Poppy/.test(log));
  await shot("8-first-day-end");
  await p.click('.fd-reply [data-v="home"]'); await p.waitForTimeout(500);
  ok(`${w}: setup form screen agrees it is done`, await p.evaluate(() => fetch("/api/setup", { headers: { authorization: "Bearer " + localStorage.getItem("maiz.token") } }).then((r) => r.json()).then((j) => j.state === "ready")));
  if (w === 1440) {
    // Hire someone later: they should be introduced in the same conversation, and nobody else repeated.
    const hired = await p.evaluate(() => fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + localStorage.getItem("maiz.token") }, body: JSON.stringify({ lines: [{ key: "supply-chain-manager", qty: 1 }] }) }).then((r) => r.json()));
    const paid = hired.order?.status === "paid";
    if (!paid) console.log("SKIP  hire-later: checkout did not complete in this environment", JSON.stringify(hired).slice(0, 120));
    else {
      await p.goto(B + "/app.html?order=test#team"); await p.waitForURL(/#firstday/, { timeout: 8000 }).catch(() => {});
      await p.waitForSelector(".fd-msg"); await p.waitForTimeout(1500);
      const t = await p.locator("#fd-log").innerText();
      ok(`${w}: hire-later: the new person is introduced`, /I'm Sol/.test(t), t.slice(-300));
      ok(`${w}: hire-later: nobody is introduced twice`, (t.match(/I'm Felix/g) ?? []).length === 1);
      await shot("9-new-hire");
    }
  }
  ok(`${w}: no page errors`, errs.length === 0, errs.join(" | "));
  await ctx.close();
}
await b.close();
process.exit(fails ? 1 : 0);
