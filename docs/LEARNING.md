# Feedback, learning and the business profile

What a business tells its team, and what the team keeps. Built for three claims on the marketing site: "you steer it and it adapts", "it gets to know your business" and "it learns how you work". This page says exactly what is real and what is not.

## What is real

**Feedback on answers** (Conversations screen, under every answer): *Good*, *Not right*, *Redo* and *Edit*, each with an optional one-line note.

- *Edit* saves the client's own words over the answer and marks it "Edited by you".
- *Redo* sends the note and asks the employee again.
- The client can also type a standing preference on **What your team knows** (`/app.html#learning`).

**What is learned from it** is deliberately small and rule-based. There is **no AI call** in learning, so it costs no energy.

| Signal | What is kept |
|---|---|
| A note (on Not right, Redo, Edit) | The note itself, clipped to one line of 200 characters, for that employee. |
| An edit | Only what can be read from the change: much shorter or longer, no exclamation marks, no emoji (or welcome), lists or plain paragraphs. It never guesses at meaning. |
| A thumbs up, or a thumbs down with no note | A count only. **Nothing is learned from a bare rating**, because there is nothing to say what was liked. |
| A video approved or not approved | Counts as a Good or Not right. A note on "not right" becomes a preference. |

**The memory is small on purpose.** At most 12 preferences and 30 profile lines per business, 40 recent feedback counts. A repeated preference is counted once and stays; past the cap the least repeated and oldest goes. At most 1,400 characters of it are added to an employee's instructions (`CONTEXT_MAX_CHARS`), so it never grows with time and adds a few hundred tokens to a request at most. No answers or histories are kept for learning.

**It reaches the work.** `LearningService.contextFor` is registered as a context source in `createPlatform`, like Rota, People and Data mining. An employee gets the preferences for its own role plus those for the whole team, then the profile lines. Queued (batch) work gets them too, because they are added where the instructions are built.

**The business profile** (same screen) holds lines of five kinds: about, how you work, tools, regular jobs and tone. Where each comes from:

- *Signup*: what was typed (what you sell, kind of business, team size, what you want help with, apps) and the tone and customers from the setup form.
- *Website*: after signup, the home page is read once, in the background, with the same guarded reader as signup (https only, public hosts only, clipped). It adds what the page says about the business, the apps it visibly runs on and the social pages it links to. If the page cannot be read, nothing is added.
- *Connected apps*: the names of apps the client has connected, refreshed when the screen opens.
- *Your work*: a job asked for three or more times in nearly the same words becomes a "regular job". This looks only at the client's own questions.
- *Written by you*: lines the client adds or changes. Their words always win and are never overwritten.

**The client is in control.** Every preference and profile line can be changed or deleted. A learned line that is deleted is remembered as unwanted and is not learned again. "Forget everything" deletes the lot (preferences, profile and counts). Conversations are separate and are not touched.

**Isolation.** Everything is stored per business in the `learning` record, read and written only through the signed-in client's own workspace (`identity.require`), and added only to that business's own employees' instructions. Viewers can read; changing needs the same right as asking a question. Tests check that one business's preferences never appear in another's profile or prompt (`test/learning.test.ts`).

## What is not real (say this plainly)

- It does **not** retrain or fine-tune any model. It adds a few short lines to the instructions.
- It does not understand *why* an edit was made. Only the simple patterns in the table above are read from edits; the client's own written notes carry the rest.
- "Learns your system and flow" is limited to the profile lines above. It does not watch what the client does in other apps, and does not read documents. Say "gets to know your business".
- The website reading is one read at signup. It is not re-read later. A site that blocks it adds nothing.
- Preferences are not suggested or merged by AI, and similar notes written in different words are separate lines.
- Not built: a team-wide "learned" email, importing preferences from another tool, a per-employee view of what it has learned (the screen shows the scope as a label).

## Where it lives

`src/modules/learning/` (service, edit rules, profile sources), `LearningService` wired in `src/server/platform.ts`, routes `POST /api/feedback`, `GET /api/learning`, `POST/DELETE /api/learning/lessons`, `POST/DELETE /api/learning/facts`, `POST /api/learning/forget` in `src/server/app.ts`, screens in `web/src/chat.ts` and `web/src/learning.ts`.
