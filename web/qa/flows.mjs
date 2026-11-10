import { chromium, devices } from "playwright";
// End-to-end flows against a running server: npm start with ALLOW_DEV_AUTH=1, then QA_URL=http://localhost:8787 npm run qa:flows
const B = process.env.QA_URL ?? "http://localhost:8787";
const b = await chromium.launch();
const res = []; const ok = (n, c, d = "") => { res.push([c ? "PASS" : "FAIL", n, d]); };
const errs = [];
const mk = async (opts = {}) => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, ...opts }); const p = await ctx.newPage(); p.on("pageerror", e => errs.push(String(e))); p.on("console", m => { if (m.type() === "error" && !(p.url().includes("/signin.html") && m.text().includes("400"))) errs.push(p.url() + " " + m.text()); }); return p; };

// 1. Link check: every internal link and anchor on every page
{
  const p = await mk(); const seen = new Map();
  const pages = ["/", "/employees.html", "/pricing.html", "/security.html", "/signin.html", "/onboarding.html", "/app.html", "/404.html"];
  let broken = [];
  for (const pg of pages) {
    await p.goto(B + pg, { waitUntil: "networkidle" });
    const links = await p.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
    for (const h of new Set(links)) {
      if (/^(mailto:|https?:)/.test(h)) continue;
      const u = new URL(h, B + pg); const key = u.pathname + u.hash;
      if (!seen.has(key)) {
        const r = await p.request.get(u.origin + u.pathname); let good = r.ok();
        if (good && u.hash && !u.pathname.startsWith("/app")) { const html = await r.text(); good = new RegExp(`id="${u.hash.slice(1)}"`).test(html); }
        if (good && u.hash && u.pathname.startsWith("/app")) { const html = await r.text(); good = new RegExp(`data-screen="${u.hash.slice(1)}"`).test(html); }
        seen.set(key, good);
      }
      if (!seen.get(key)) broken.push(pg + " -> " + h);
    }
  }
  ok("links: all internal links and anchors resolve", broken.length === 0, `${seen.size} unique; broken: ${broken.join(", ")}`);
  const r404 = await p.request.get(B + "/nope-page"); ok("unknown page returns 404 page", r404.status() === 404 && (await r404.text()).includes("can't find"), String(r404.status()));
  for (const f of ["/robots.txt", "/sitemap.xml", "/favicon.svg", "/og.png"]) ok("serves " + f, (await p.request.get(B + f)).ok());
  const h = (await p.request.get(B + "/")).headers();
  ok("security headers present", !!h["content-security-policy"] && !!h["x-content-type-options"], Object.keys(h).filter(k => /content-security|x-frame|x-content|referrer|strict|permissions/.test(k)).join(","));
  await p.context().close();
}
// 2. Onboarding -> control center (real API, dev sign-in)
{
  const p = await mk();
  await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
  await p.click("#email-go"); ok("onboarding: invalid email shows error", await p.isVisible("#email-err"));
  await p.fill("#email", `owner${Date.now()}@example-bakery.test`); await p.click("#email-go");
  await p.waitForSelector('[data-step="2"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok("onboarding: step 2 shown after email", await p.isVisible("#biz"));
  await p.click("#biz-go"); ok("onboarding: empty business name shows error", await p.isVisible("#biz-err"));
  await p.fill("#biz", "Example Bakery"); await p.fill("#sells", "Fresh bread and cakes"); await p.click("#biz-go");
  for (const step of [3, 4]) { await p.click(`[data-step="${step}"] [data-next]`); }
  ok("onboarding: reached step 5", await p.isVisible('[data-step="5"]'));
  await p.click('[data-step="5"] [data-next]');
  await p.waitForSelector("#open-app", { state: "visible", timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const token = await p.evaluate(() => localStorage.getItem("vn.token"));
  ok("onboarding: account created (login stored)", !!token);
  await p.click("#open-app"); await p.waitForURL(/app\.html/); await p.waitForTimeout(800);
  ok("app (signed in): shows the real business name", (await p.textContent("#org-name")) === "Example Bakery", await p.textContent("#org-name"));
  ok("app (signed in): demo bar hidden, example tags shown", !(await p.isVisible("#demo-banner")) && await p.isVisible('[data-screen="home"] .eg'));
  await p.fill("#ask-in", "finance: what is my runway?"); await p.press("#ask-in", "Enter");
  await p.waitForSelector("#answer", { timeout: 8000 }).catch(() => {});
  ok("app (signed in): ask bar returns an answer", await p.isVisible("#answer"));
  for (const s of ["approvals", "work", "team", "usage", "finance", "compliance", "apps", "setup", "settings"]) {
    await p.click(`.rail a[data-nav="${s}"]`); await p.waitForTimeout(150);
    ok(`app nav: ${s} screen opens`, await p.isVisible(`[data-screen="${s}"] h1`) && (await p.getAttribute(`.rail a[data-nav="${s}"]`, "aria-current")) === "page");
  }
  await p.click('.rail a[data-nav="apps"]'); await p.waitForTimeout(400);
  ok("apps (signed in): catalogue from API", (await p.locator("#apps-grid .app-card").count()) >= 5);
  await p.click('.rail a[data-nav="settings"]'); await p.click("[data-signout]"); await p.waitForURL(/signin/);
  ok("sign out returns to log in", true);
  await p.context().close();
}
// 3. Demo control center: dashboards and gates
{
  const p = await mk();
  await p.goto(B + "/app.html", { waitUntil: "networkidle" });
  ok("demo: example bar shown", await p.isVisible("#demo-banner"));
  ok("demo: overview has 6 tiles", (await p.locator("#ov-kpis .tile-kpi").count()) === 6);
  await p.click('#ov-kpis a[href="#compliance"]'); await p.waitForSelector("#cal-list li", { state: "visible", timeout: 3000 }).catch(() => {}); ok("overview tile opens compliance calendar", await p.isVisible("#cal-list li"));
  await p.click('#cal-filter [data-kind="Tax"]'); ok("compliance filter: Tax shows 1", (await p.locator("#cal-list li").count()) === 1);
  await p.goto(B + "/app.html#work"); await p.waitForTimeout(200);
  const so = p.locator(".so-card").first();
  ok("sign-off: locked while info missing", await so.locator("[data-so-ok]").isDisabled());
  await so.locator('input[type=radio]').first().check();
  ok("sign-off: still locked with direction but missing info", await p.locator(".so-card").first().locator("[data-so-ok]").isDisabled());
  await p.locator(".so-card").first().locator(".so-brief input").fill("Green and cream, kestrel logo"); await p.locator(".so-card").first().locator("[data-so-save]").click();
  ok("sign-off: unlocks once info and direction are in", await p.locator(".so-card").first().locator("[data-so-ok]").isEnabled());
  await p.locator(".so-card").first().locator("[data-so-ok]").click();
  ok("sign-off: signed off state", (await p.locator(".so-card").first().textContent()).includes("Signed off"));
  const c2 = p.locator(".so-card").nth(1);
  await c2.locator('input[type=radio]').nth(1).check();
  await p.locator(".so-card").nth(1).locator(".so-ask input").fill("How long would the full handbook take to read?"); await p.locator(".so-card").nth(1).locator(".so-ask button").click();
  ok("ask for more info: sign-off locks again", await p.locator(".so-card").nth(1).locator("[data-so-ok]").isDisabled() && (await p.locator(".so-card").nth(1).textContent()).includes("finding out"));
  await p.click('#task-filter [data-who="hr"]'); ok("task filter by employee", (await p.locator("#kan .kcard").count()) === 2);
  await p.goto(B + "/app.html#team"); await p.waitForTimeout(200);
  ok("team table has 6 rows", (await p.locator("#team-table tbody tr").count()) === 6);
  await p.click('#rd-form button[type=submit]'); ok("role designer: thin brief lists problems", (await p.locator(".rd-problems li").count()) === 3);
  await p.fill("#rd-title", "Wholesale account coordinator"); await p.fill("#rd-purpose", "Look after cafes that buy in bulk"); await p.fill("#rd-duties", "Prepare price lists\nChase repeat orders");
  await p.click('#rd-form button[type=submit]'); ok("role designer: drafts a job description", await p.isVisible(".rd-draft") && (await p.locator(".rd-draft").textContent()).includes("Wholesale account coordinator"));
  await p.fill("#rd-title", '<img src=x onerror=alert(1)>'); await p.click('#rd-form button[type=submit]');
  ok("role designer: HTML in input is escaped", (await p.locator(".rd-draft img").count()) === 0);
  await p.goto(B + "/app.html#usage"); await p.waitForTimeout(200);
  ok("usage: chart and table render", (await p.locator("#bars rect").count()) > 20 && (await p.locator("#usage-table tbody tr").count()) === 6);
  await p.goto(B + "/app.html#approvals"); await p.click("#a-ok"); await p.waitForTimeout(400);
  ok("approvals: approving removes the item", (await p.locator("#alist [data-a]:not([hidden])").count()) === 2);
  await p.context().close();
}
// 4. Store and cart
{
  const p = await mk();
  await p.goto(B + "/employees.html", { waitUntil: "networkidle" });
  const opts = await p.locator("#store-pick option").count(); ok("store: picker lists items", opts > 40, String(opts));
  const val = await p.locator('#store-pick option[value*="content-creator"]').first().getAttribute("value");
  await p.selectOption("#store-pick", val); await p.locator("#store-item button").first().click();
  ok("store: item added to cart", (await p.locator("#cart-lines li").count()) >= 1, await p.textContent("#cart-totals"));
  await p.click("#cart-checkout"); ok("store: checkout says payments are not open", /Payments open soon/.test(await p.textContent("#cart-note")));
  ok("blueprint: Creative studio department shown", (await p.textContent("#org-blueprint")).includes("Creative studio"));
  await p.locator(".emp-card .jd summary").first().click(); ok("job description opens", await p.locator(".emp-card .jd-body").first().isVisible());
  await p.context().close();
}
// 5. Sign-in page and mobile menu
{
  const p = await mk();
  await p.goto(B + "/signin.html"); await p.fill("#si-email", "someone@example.test"); await p.click("#si-go"); await p.waitForTimeout(600);
  ok("sign in: confirmation shown", /Check your email/.test(await p.textContent("#si-h")), await p.textContent("#si-h"));
  await p.goto("about:blank"); await p.goto(B + "/signin.html#token=bogus"); await p.waitForFunction(() => /didn't work/.test(document.getElementById("si-h")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  ok("sign in: bad link explained, token removed from address bar", /didn't work/.test(await p.textContent("#si-h")) && !p.url().includes("token"));
  await p.context().close();
  const m = await mk({ ...devices["iPhone 13"] });
  await m.goto(B + "/"); await m.click(".nav-toggle"); ok("mobile: menu opens", await m.isVisible("#mobile-menu"));
  await m.keyboard.press("Escape"); ok("mobile: Escape closes menu", !(await m.isVisible("#mobile-menu")));
  await m.goto(B + "/app.html"); await m.click("#menu-btn"); ok("mobile app: rail opens", await m.isVisible('.rail a[data-nav="compliance"]'));
  await m.click('.rail a[data-nav="compliance"]'); await m.waitForTimeout(500); ok("mobile app: navigates and closes rail", await m.isVisible("#cal-list"));
  await m.context().close();
}
// 6. Keyboard
{
  const p = await mk(); await p.goto(B + "/"); await p.keyboard.press("Tab");
  ok("keyboard: first Tab is the skip link", (await p.evaluate(() => document.activeElement?.className)) === "skip-link");
  await p.context().close();
}
await b.close();
for (const r of res) console.log(r.join(" | "));
console.log("console errors:", errs.length, errs.slice(0, 8));
console.log(res.filter(r => r[0] === "FAIL").length, "failed of", res.length);
if (res.some((r) => r[0] === "FAIL") || errs.length) process.exit(1);
