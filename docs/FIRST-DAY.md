# First day: onboarding as meeting your team

Signup and the control centre treat each AI employee as a person joining the client's team, not as a form.

## What the client sees

1. **Onboarding (`/onboarding.html`)**: Maya (Admin manager) asks the questions in her own voice; Felix (Finance manager) asks which apps are used. The plan names who starts on what. After the team is created, the page ends on the team arriving one by one, each saying hello.
2. **First day (`/app.html#firstday`)**: a conversation, not a page of fields.
   - Everyone introduces themselves, including what they will *not* do.
   - Each question comes from the person who needs the answer. Sign-up answers are offered back ("I've put X, is that right?"), guesses are labelled, optional questions can be skipped.
   - The answers go to the Admin manager's existing `POST /api/setup` in one go, then the real setup steps are reported.
   - Finance and HR then ask for read-only access to the apps they work from and **test it**: the connection is synced and the employee reports the records actually read, or the real error. Direct apps connect by OAuth (returning to the conversation) or by pasted key, file-only apps by uploading an export, Zapier/Make by a private link (shown once; not reported as working until data arrives).
   - Slack is offered by Maya. The server cannot report whether Slack finished, so she says so rather than claiming success.
3. **Hiring later**: after a purchase (in-app, or Stripe's return to `/app.html?order=…`) anyone on the team the owner has not met is introduced in the same conversation, and can ask for access to their apps.
4. **Prefer a form?** `/app.html#setup` is the same questions on one page, kept as the plain alternative. Both read and write the same Admin manager state.

## Where it lives

| Piece | File |
| --- | --- |
| Names, introductions, what each person asks for | `src/modules/onboarding/people.ts` (pure, tested in `test/people.personas.test.ts`) |
| Conversation script and state | `web/src/firstday.ts` (progress kept in `localStorage` key `maiz.firstday`) |
| Message and reply UI | `web/src/firstday-ui.ts` |
| Connect-and-test flows | `web/src/firstday-connect.ts` |
| Return to the conversation after OAuth or Slack | `returnTo=firstday` in `src/server/app.ts` (whitelisted value, signed into the state token) |

## Notes and limits

- First names are display text only, in one file; the stored employee keeps its role title. Change a name in `people.ts`.
- Answers for people hired after setup are not stored in the setup form (the form is fixed at signup). They introduce themselves and ask for app access; their work starts from what the owner asks them.
- Marketing and Compliance have no app to connect yet; Marketing's social accounts belong to the Connections work on the owner side.
- End-to-end: `QA_URL=http://localhost:8787 node web/qa/journey.mjs` (API running with `ALLOW_DEV_AUTH=1`) drives onboarding through the whole first day at 375 and 1440 px.
