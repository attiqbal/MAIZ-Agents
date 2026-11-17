// The pre-launch flow against a running server in interest mode: QA_URL=http://localhost:8787 node qa/interest-flow.mjs
// (start the server with SIGNUP_MODE unset or "interest"). Run flows.mjs against a server with SIGNUP_MODE=open instead.
import { chromium } from "playwright";
const B = process.env.QA_URL ?? "http://localhost:8787";
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: 375, height: 812 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
let fails = 0; const ok = (n, c) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) fails++; };
await p.goto(B + "/", { waitUntil: "networkidle" });
ok("home has Register your interest and no 'Start free trial'", (await p.content()).includes("Register your interest") && !(await p.content()).includes("Start free trial"));
await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
ok("old signup redirects to the interest form", p.url().endsWith("/register-interest.html"));
await p.click("#in-go"); ok("empty form shows an error", await p.isVisible("#in-err"));
await p.fill("#in-name", "QA Person"); await p.fill("#in-email", `qa${Date.now()}@example.test`); await p.click("#in-go");
await p.waitForSelector("#in-thanks:not([hidden])", { timeout: 5000 }).catch(() => {});
ok("thank-you shown", await p.isVisible("#in-thanks"));
await b.close();
ok("no page errors", errs.length === 0);
process.exit(fails ? 1 : 0);
