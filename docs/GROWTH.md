# Community growth manager (owner only)

The **Content Distribution & Community Growth Manager** for mocktestroom.com, examutor.com and maizagents.com. It is the second owner-only agent next to the promotion agent (`docs/PROMOTER.md`). Page: `/owner-growth.html` ("Community growth" in the owner menu). Routes: `/api/owner/growth/*`, platform owner only (403 for anyone else; the service checks again). Code: `src/modules/growth` (`role.ts`, `rules.ts`, `service.ts`). Tests: `test/growth.test.ts`.

The role brief is stored word for word in `role.ts` (`GROWTH_ROLE`), shown on the page, and given to the model with every draft.

## Operating procedure, as built

1. **Research.** The opportunity database (blogs, publications, Reddit, Quora, LinkedIn, niche forums, other communities). Each place has a site, a public https address (checked: no IPs, no localhost, no logins, the right host for Reddit, Quora and LinkedIn), who reads it, and ratings from 0 to 5 for audience fit, site quality and rules fit, plus whether links and promotion are allowed. The page lists search phrases per site and platform to find places. Nothing here browses the web: a person (or the owner) finds the place and adds it. The agent never fetches a link you give it.
2. **Score.** 0 to 100: audience 40%, site quality 25%, rules fit 20%, openness to links 15%. A place whose rules forbid it, or with the wrong audience, scores 0 ("skip") and cannot be drafted for. Reasons are shown (low-quality site, no self-links, rules unchecked).
3. **Prepare.** Drafting is locked until the place's rules have been read and recorded. A reply needs the discussion's address and what it is asking, so it answers a real question, and needs your own recorded account. A link to the site is only included when the place allows links, audience fit is 3 or more and rules fit is 3 or more; otherwise any link is removed. Drafts go through the Model Gateway (`taskType: "growth"`, so RunPod first with Claude's spot-check), with a labelled template fallback. Every contribution gets an automatic disclosure line ("Disclosure: I run Examutor (...), so I have an interest here"). Drafts too similar to an earlier one (three-word-run overlap of 60% or more) are refused, and generic AI phrasing, fake-engagement wording and company commitments are flagged.
4. **Approval.** Drafts and permission requests wait on the owner Decisions page. Promotional content needs your approval to publish; guest-post pitches need your approval to send; commitments need a ticked confirmation. Editing a draft sends it back for approval.
5. **Publish, by authorised methods only.** There is no posting code and no browser automation: you publish or send by hand, then record it (link, date, account). Pitches get a follow-up reminder after 7 days.
6. **Verify.** You open the live page and confirm you saw the content there; only then is it "verified". You also record the backlink (none, unknown, nofollow, follow).
7. **Record and measure.** Per publication: platform and address, content, date, account, backlink, referral visits, engagement, leads, status and follow-up. The report totals them per website. Links carry UTM tags (`utm_medium=community`).

## Permissions and limits (enforced in code)

- **New accounts:** the agent cannot create one. You approve an account request for a platform, open the account yourself, then record it. **One account per platform**; a second is refused ("several accounts are not allowed"), and recording needs an approved, unused request.
- **Commitments:** wording such as "we will", "exclusive discount" or "free for life" is flagged and cannot be approved without the confirmation box. You can also raise a standalone approval request.
- **Reddit:** at most 3 contributions a day, and no second contribution to the same community within 7 days (applies to every conversation platform). Rules read first, affiliation disclosed, no identical posts, no links in unrelated conversations, one account.
- **Never:** fake accounts, fake engagement or fabricated testimonials (flagged in copy, and there is no way to post from here); bypassing CAPTCHAs, rate limits, access restrictions or moderation (there is no automation to bypass them with). If a platform bans or refuses, mark the place "Not allowed there" and it stays closed.

## Not built

- Automatic discovery of places or discussions (needs search or platform API keys). Today the agent supplies search phrases and you add places.
- Posting through platform APIs. If you want it later it would need each platform's keys, kept in secrets only, authorised accounts and the same approval gate.
- Automatic checking that a link is live: `verify` is your confirmation. A server-side fetch of a user-supplied address was left out on purpose (SSRF risk) until it can be restricted to the platform's own hosts.
- Traffic numbers are typed in from your analytics; they are not pulled in.

## Storage

Platform records (`promo_opportunity`, `promo_post`, `promo_publication`, `promo_account`, `promo_approval`), restricted like coupons and affiliates. No migration.
