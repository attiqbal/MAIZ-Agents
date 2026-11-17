# MAIZ Agents positioning (read this before writing any script)

Status: draft for Atif, 17 November 2026. Everything below is grounded in the site and docs as merged (PR #60 and earlier). Where something is built but not yet checked against real outside services, it is marked "verify before filming".

## 1. The one-line USP

**A whole back office for £150 a month, run by an AI team that does the work, where nothing leaves your business without your yes.**

Short forms for hooks and captions:

- "Hire a team. Not another tool." (already the homepage line)
- "You approve. They execute."
- "Five employees and a free manager for £150."

## 2. Who we are for (default, change if you disagree)

Primary: owner-run small businesses (1 to 20 staff) in the UK and other English-speaking markets, where the owner personally does the books, the posting, the hiring paperwork and the compliance admin, usually late at night. English only at launch, prices in GBP.

Secondary, only after the primary works: online sellers (the E-commerce, Dropshipping, Marketplace and Shop customer care add-ons exist), and shops, cafes and trades that already use Slack or a till we can read.

Not the audience: large companies, people who want a chatbot, developers who want an agent framework.

## 3. The problem we speak to

The owner is the finance department, the marketing team, HR and compliance, on top of the actual job. Hiring costs money and time, freelancers need briefing, and AI chat tools still need the owner to know what to ask. The pain is not "I lack AI", it is "I am doing five other people's jobs".

## 4. What sets us apart (each point is provable from the product)

| # | Difference | Proof on the site or in the code | Say it like this |
|---|---|---|---|
| 1 | A team, not a tool | Five employees plus a free Admin manager that routes requests and hands work between them (employees page, how it works) | "Not a chatbot. A team with job descriptions." |
| 2 | You approve, they execute | Posts, emails and payments wait for approval; Redo returns the energy; specialist work gets a MAIZ quality review first (how it works, approvals) | "Nothing goes out without your yes." |
| 3 | One flat, visible price | £150 for the whole team, no per-seat fees; cost shown before a task; when energy runs out work pauses, nothing extra is charged; top-ups only if you choose (pricing page) | "£150. That is the price. Not a starting price." |
| 4 | Set up by conversation | About three minutes; reads your website to fill in answers; Slack in one scan; team lives in Slack with approval buttons (how it works) | "Live in three minutes. Paste your website." |
| 5 | Numbers you can trace | Finance uses tested accounting code; entries must balance and are corrected by visible reversal; every figure opens its entries; Business consultant labels every number by source (employees, security pages) | "Every number says where it came from." |
| 6 | Your data stays yours | Per-business isolation enforced in the database and tested on every change (security page) | "Each business is kept apart, in the database itself." Never say "certified" or "audited". |
| 7 | It grows with you | Extra employee £25, specialist hire £35, each adds 2,000 energy a week; store and 12 specialist hires; consultants by the week or month | "Start with five. Add when you need." |
| 8 | Connects to what you already use | Slack, Xero, Square, Stripe, BrightPay, Zapier/Make and 200+ more read-only by link or file; bring your own Claude, ChatGPT, Zapier, Make or n8n key | "Works where you already work." |

The compact story: **it is a team (1), it asks before it acts (2), it costs one known price (3), and it starts working today (4).** Points 5 to 8 are proof and reassurance, used when the viewer asks "but can I trust it" or "what if I grow".


## 4b. More differentiators Atif listed (17 Nov, 13:09), with what we can honestly say today

| Atif's point | Say it? | Wording and limits |
|---|---|---|
| Wide range of service integrations | Yes, carefully | "Connects to the apps you already use: Slack, Xero, Square, Stripe and 200+ more, read-only, by link or file." Connectors were tested against pretend servers only, so never film a live result as proof until checked after deploy. |
| Easy sign up | Yes | Three minutes, conversation not forms, paste your website, Google or Microsoft login, no card for the 7-day trial. |
| Good amount of work in the starter pack (energy) | Yes, as the allowance, not a task count | "8,000 energy a week, shared by the whole team, no per-task limit, cost shown before a task." Do not say how many tasks this equals; it varies. |
| Wide variety of functions | Yes | Five employees in the package plus a free Admin manager, and a store of add-on employees, 12 specialist hires and consultants. |
| Everything in one place | Yes | One control centre and one team, in Slack and the browser. Say "one place to approve, track and pay", not "replaces all your software". |
| Data privacy and segregation | Yes, exactly as the security page says | Each business is kept apart at database level, tested on every change. No audit or certification claimed. Never say "fully secure". |
| Valuing input from customers | Only as "you steer": approve, redo or edit every piece of work | There is no customer feedback or voting feature found in the code, and no proof the team learns from corrections. Do not claim "we build what you ask for" or "it learns from your edits" until that exists. |
| Customization | Partly | True: the team is yours (add and remove employees, your voice learnt from your website, your country's rules, your apps). A new specialist designed by the Admin manager was only a draft flow in the last notes; verify before saying "we build a specialist for you". |
| In-house video and content generation, plus specialised services | Content: yes, video: not yet | Marketing manager drafts posts and emails; a Content creator consultant is sold by the week or month. Video from templates (Creatomate, Shotstack) exists for the owner's promotion agent only; the client side is API-only with no screen and was tested against fake servers. Do not advertise "we make your videos" until a client screen exists and a real render has been checked. The "Creative studio" department is a plan, not a live employee. |
| Learns the system and the flow of information, adapts to your needs | Partly | True today: the Marketing manager learns your voice from your site, signup reads your website, and the Admin manager asks only for what it still needs. Not proven: ongoing learning from your day-to-day corrections. Say "gets to know your business", never "keeps learning". |

Owner decision flagged: to say "learns from your edits", "we build what you ask", or "we make your videos", those features must first exist and be checked. Until then they stay out of scripts (see the guardrails in section 7).

## 5. Why someone hires us (the reasons we stress, in priority order)

1. **Get your evenings back.** The owner's late-night admin is done by morning.
2. **Cheaper than a part-time hire, with no hiring risk.** The pricing page calculator shows about £650 a month for a part-time hire (typical UK hourly pay, before employer costs) against £150. Always present it as an estimate with the assumptions on screen, as the site does.
3. **You stay in charge.** The fear of AI is losing control, so control is the second message of every skit.
4. **No surprises.** Flat price, cost shown first, pause instead of overage, cancel in one click.
5. **Nothing to learn.** No prompts, no setup forms; it asks only for what it still needs.

## 6. What we stress, what we play down

Stress in every video: the team (not one bot), the approval moment, the plain price.

Stress often: three-minute start, Slack buttons, "redo returns your energy", free Admin manager, cancel in one click.

Play down: the word "agents" and technical terms (energy is explained as "a weekly allowance your whole team shares"), model names, anything about how the AI works.

Never lead with: security detail, integrations lists, add-on catalogue. These answer objections in comments and follow-ups.

## 7. Claims we must not make (hard guardrails for every script)

- No customer counts, reviews, testimonials, case studies or "trusted by". We have no verified customers to quote. Characters are fiction and every video says so.
- No guaranteed savings. Savings figures are "an estimate to compare", with the assumptions on screen.
- Never say it replaces an accountant, solicitor, HR adviser or lawyer, or that it gives tax or legal advice. It drafts and checks; the owner approves and some work still needs a person.
- No security certification, audit or compliance accreditation. The security page says none yet.
- Compliance manager: it keeps a dated register and cites official sources. Do not claim it "knows the law" or "guarantees you comply". Live legislation feeds are planned, not live.
- Do not show features as live that are not: Approvals, Books and cash and the Compliance calendar were labelled example data in the 16 November audit; later work was built on branch but not verified live. Verify in the running product before filming any screen that implies real data.
- Integrations, data search (Reddit, YouTube, X, shares, Companies House) and the website reader were only tested against pretend servers. Do not film them as proof of real results until checked after deploy.
- Inviting teammates, outside agents stage 2 and removal of an add-on on cancellation are not built.
- No fake "AI did my whole business" stories. No screens with invented customer data shown as real. Mark dramatised screens "Example".
- Label the series as AI-made and fictional ("The MAIZ Office is a comedy. Characters are fictional.") and use each platform's AI-content label.
- Promo codes only where the code is live. The codes system gives trial days, free energy or a discount taken at checkout; confirm the exact offer exists in the owner's promotions page before printing it.
- UK advertising rules apply (ASA/CAP): price claims must be accurate, "free" must really be free (trial is 7 days, 3,000 energy, no card), comparisons must be fair.

## 8. Competitive framing (by category, not by name)

| They use | Our line |
|---|---|
| A general AI chat assistant | "A chatbot waits for you to ask. A team starts work." |
| Workflow tools (build it yourself) | "No flows to build. Say what you need." |
| A bookkeeper, assistant or part-time hire | "Fewer admin hours, no hiring, and you approve everything." |
| An all-in-one workspace with credits | "One flat price. You see the cost before the task." |

Do not name competitors in videos, and make no claim about their products.

## 9. Messaging hierarchy for every video

1. Hook (0 to 2s): the human problem or the comic situation.
2. The team does it: one named character, one real job.
3. The approval beat: the boss says yes (or "redo"), voice or Slack message only.
4. Button line: one fact (price, three minutes, or "nothing leaves without your yes").
5. CTA: "Start free. 7 days, 3,000 energy, no card." with a character-specific code or link.

## 10. Content pillars, mapped to what exists (feeds the campaign plan)

| Pillar | Product feature | Status |
|---|---|---|
| Monday-morning done | Admin manager daily briefing, weekly reviews, Monday energy refill | Stated on site |
| Nothing goes out without your yes | Approvals, redo returns energy, Slack buttons | Stated on site |
| Money you can trace | Finance manager, receipts inbox, cash snapshot | Stated on site; real data on Books, verify |
| Posting without the dread | Marketing manager, 30-day plan, voice from your site | Stated on site |
| Hiring without the headache | HR manager job ads, scorecards, handbook, offer letters | Stated on site |
| Rules and deadlines | Compliance manager register, draft checks | Stated; no "knows the law" |
| Cost clarity | £150 flat, energy shown first, pause not overage | Stated on site |
| Three-minute start | Website reader, Slack one-scan | Website reader: verify real sites |
| Grow your team | Extra employee, specialists, store, Data mining agent | Data sources: verify |
| Interns vs agents / 3am shift | Comic ground, no product claim beyond the above | Humour only |

## 11. Decisions for Atif (defaults chosen so work continues)

1. **Audience:** UK-first owner-run small businesses (default). Alternative: online sellers first.
2. **Hero message:** "Hire a team. Not another tool." plus "You approve. They execute." (default).
3. **Offer in the CTA:** the plain free trial (7 days, 3,000 energy, no card). Character codes carry no extra discount unless you create one in owner promotions.
4. **Disclosure:** every video tagged as fictional and AI-made (default).
5. **Tone limit:** the humour is about office life, never about customers, real businesses or real regulators.
