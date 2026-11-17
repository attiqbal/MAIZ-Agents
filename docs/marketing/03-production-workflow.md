# The MAIZ Office: production workflow, costs and review gate

How a script becomes a posted video, with AI video and voice tools, and where a person must say yes. Read [00-positioning.md](00-positioning.md), [01-cast-bible.md](01-cast-bible.md) and [02-campaign-plan.md](02-campaign-plan.md) first.

All prices below are **estimates from general knowledge of the market, not quotes**. Tool prices and limits change often; check each vendor's pricing page and licence terms before buying. Where a figure matters (above all the licence for commercial use), a person checks it first.

## 1. Recommended approach: paper-cut puppet animation, AI clips only for hero episodes

The series is flat paper-cut characters on one fixed set (matches the site and the existing avatars). That style is cheap to keep consistent if we build it from stills and simple motion, and it drifts badly if every shot is generated as free-form AI video. So:

- **Main method (about 130 videos):** one set of locked character and set images, animated as paper-cut puppets (slides, tilts, mouth flaps, small bounces, camera push-ins) in an editor with templates. The AI is used for the still art and the voices, not for every frame.
- **Hero episodes (about 10 videos, the 45-second ones):** AI video clips generated from the locked stills, edited into the same template.
- **Why:** consistency, cost, speed, and fewer ways for a character to go off-model.

## 2. Pipeline, step by step

| # | Stage | What happens | Output | Who |
|---|---|---|---|---|
| 0 | One-time setup | Build the style bible images: each character (front, side, 6 to 10 expressions, mouth shapes), the set (empty and with props), the logo stamp, end cards, caption style. Reuse our existing avatars as reference. Lock the voice for each character. | `marketing/style-kit/` in the project files | Producer + Atif approves |
| 1 | Script lock | Take a script from `10-` to `14-`, check it against the claims checklist (section 5), final wording | Locked script, status `Script approved` | Producer, reviewer |
| 2 | Voice | Generate each line with the character's locked voice, short takes, human picks the best | Audio files per line | Producer |
| 3 | Storyboard and assets | Choose the stills and expressions for each shot; for hero episodes generate AI video clips from the stills | Shot list with assets | Producer |
| 4 | Assembly | Build the video in the editor template: timeline, puppet motion, captions burned in, logo stamp, disclosure card, end card with CTA | Rough cut | Editor |
| 5 | Review gate | The review checklist (section 5), run by someone who did not make the cut | Pass or fix list | Reviewer |
| 6 | Owner sign-off | Atif watches the final file with sound off and with sound on and says Approved or Redo | `Approved` in the approvals log | Atif |
| 7 | Scheduling | Upload with caption, hashtags, tracked link, disclosure toggle; schedule at the planned time | Scheduled post | Producer |
| 8 | Post-publish | Check the post played correctly, reply in the first hour, log results weekly | Metrics in the log | Producer |

No video may be scheduled while its status is not `Approved`. The approval, not the schedule, is the gate.

## 3. Tools (options, with a recommendation)

| Need | Recommended | Alternatives | Notes |
|---|---|---|---|
| Still art (characters, set) | An image model, with our avatars as reference | Illustrator or a freelancer for the one-time kit | Use an image tool whose terms allow commercial use; keep prompts and seeds in the style kit; follow the style prefix in the cast bible, section 10 |
| Voices | A text-to-speech service with a licensed voice library or designed voices, on a plan that allows commercial use | Record a voice actor per character | Never clone a real person. Keep one voice id per character |
| Animation and editing | A template-based editor (CapCut, DaVinci Resolve or Premiere with saved templates) | Remotion (code) for fully templated renders | Burn captions into the file and also export a caption file |
| AI video clips (hero only) | One mainstream image-to-video tool, from the locked stills | Another image-to-video tool if the first drifts | Always start from a still; generate 3 to 4 takes per shot and pick one |
| Music and sound | A licensed music library with commercial use, or the platform's commercial library | Original loops from a composer | Keep the licence receipt for every track; no famous songs |
| Scheduling | Native schedulers of each platform | A scheduler such as Buffer or Later | Keep one place that holds the caption, tags, link and approval status |
| Template video rendering (optional) | Creatomate or Shotstack (already connected for the owner's promotion agent, see `docs/PAID-SERVICES.md`) | | Only tested against pretend servers so far; try with a real key before relying on it. Estimated 10 to 20 US cents a render |
| Tracking | The tracked link and the analytics in `docs/GROWTH-ANALYTICS.md` | | Same link format as the plan, section 6 |

## 4. Cost estimate

Assumptions: 140 videos over about 28 weeks, 15 to 30 seconds, one fixed set, about 60 words of dialogue per video, exchange rate £1 = $1.30. These are rough ranges to plan with, not commitments.

| Item | Recommended mix (puppet animation + 10 hero clips) | Alternative: all AI video clips |
|---|---|---|
| Style kit, one time (images, voice design, templates) | £50 to £250 in tools, plus about 15 to 25 hours of setup | same |
| Still art during the run (new poses, props) | £30 to £120 | £30 to £120 |
| Voice (subscription, about 6.5 months) | £100 to £500 | £100 to £500 |
| Animation and editing tools | £0 to £300 | £0 to £300 |
| AI video clips | about £60 to £600 (10 hero videos, about 150 seconds generated each including retries, at roughly $0.05 to $0.50 a second) | about £400 to £4,000 (140 videos, about 70 seconds generated each including retries) |
| Music licence | £60 to £150 | £60 to £150 |
| **Tools total** | **about £300 to £2,000** (about £2 to £14 a video) | **about £700 to £5,500** (about £5 to £40 a video) |
| Labour (main cost) | about 45 to 75 minutes a video in batches of five: roughly 100 to 175 hours over the run. At £25 an hour for a freelancer that is about £2,500 to £4,400; zero cash if Atif or the team does it | about 60 to 90 minutes a video because of retries and clean-up: 140 to 210 hours |
| Paid boost | none to start | none to start |

Cheaper ways to start: pilot five videos first (about £100 to £300 of tools) before committing to a plan. If the pilot fails the review, change the method before spending more.

How the cost is kept honest: log tools and spend per batch in `marketing/cost-log.csv` (date, item, vendor, amount, videos covered) and compare with this table every four weeks.

## 5. The human review gate

Two people, two checks. The producer cannot approve their own cut.

### 5a. Script check (before voice, status `Script approved`)

- [ ] The script follows [00-positioning.md](00-positioning.md) section 7. In particular: no customer numbers, testimonials, "replaces", "guarantee", "certified", "legal advice", "audited", "trusted by".
- [ ] Every product line is in the "Stated on site" or "Verified live" list. If the script is gated (M or N), the gate in [02-campaign-plan.md](02-campaign-plan.md) section 8 is marked Verified live.
- [ ] Price and offer match the site today (£150, 8,000 energy a week, £25 extra employee, £35 specialist, 7 days free, 3,000 energy, no card). Any discount is a live code.
- [ ] Nothing mocks a real person, business or regulator, or any group.
- [ ] The Boss is never mocked and the Boss has the last word before the CTA.
- [ ] Dialogue is 12 words or fewer per line where possible; total spoken length fits the time.

### 5b. Final cut check (before sign-off)

- [ ] Watched with sound off: story makes sense from captions alone; captions are accurate and large enough.
- [ ] Watched with sound on: voices are the right character, no clipping, no robotic glitches, music does not cover speech.
- [ ] Character looks match the cast bible; set matches; no extra fingers, garbled text or off-model faces; any text in the image is correct.
- [ ] Any app or product screen is recorded from the real product (or labelled "Example"); no invented customer or financial data that looks real.
- [ ] Disclosure card ("A comedy. Fictional characters. Made with AI.") is present and readable; the platform's AI-content label is switched on when posting.
- [ ] Logo stamp, tracked link and CTA match the plan; the link works and carries the right script id.
- [ ] Music and any sound effects have a licence on file.
- [ ] Format: 9:16, correct length, caption file exported, no safe-zone violations (text clear of platform buttons), no flashing content.
- [ ] Caption, hashtags and first comment are drafted and have no claim beyond the video's.

### 5c. Owner sign-off

Atif watches and replies in the approvals log or in the thread: `Approved`, `Approved with changes (list)`, or `Redo (reason)`. A video that changes after approval goes through 5b again.

### 5d. Approvals log

A simple sheet kept in the project files (`marketing/approvals.csv`): script id, title, date made, producer, reviewer, reviewer pass date, owner decision and date, scheduled date and platforms, tracked link, notes. Nothing is scheduled while the owner decision is blank.

## 6. Batching and timeline

- **Week of 23 November 2026:** build the style kit and voices; make a five-video pilot (A01, B01, C01, H01, I01); review them with the full gate; fix the template.
- **Week of 30 November:** batch 1: weeks 1 and 2 of the calendar (10 videos), all through the gate.
- **From 7 December:** stay two weeks ahead. Each week, produce the week two weeks out in one half-day batch of five, and review the week one week out.
- **Hero episodes:** one every four weeks, made in a two-week lead.
- **Gated pack (weeks 25 to 28 or earlier):** produced only after the gate is verified; the shipped screens are recorded then.
- **Review of results:** every Monday, per [02-campaign-plan.md](02-campaign-plan.md) section 7.

## 7. Roles

- **Producer:** runs the pipeline and the logs (I can do this with the AI tools, or a freelancer).
- **Reviewer:** someone who did not make the cut. For claim checks the product's own Compliance manager (Cato) can be asked to read a script as a second check, but a person still signs off.
- **Atif:** final sign-off, brand and money decisions.

## 8. Risks and how they are handled

| Risk | Handling |
|---|---|
| Characters drift off-model | Generate only from locked stills; reject off-model frames; keep a "model sheet" next to every edit |
| Voice quality or licence problem | Use only licensed or designed voices on a commercial plan; keep the licence; no cloning real people |
| A claim goes beyond the product | The claim check in 5a; the gated pack waits for Verified live |
| Platform labelling rules | Switch on the platform's AI label and keep our own disclosure card; reread each platform's rules before launch |
| Advertising rules (UK) | Accurate price, fair comparison, real "free" (trial is real and needs no card); the content is marketing, so keep claims substantiable |
| Copyright of music and art | Licensed music only; our own art only; no stock or copied art |
| Burn-out or a late video | Stay two weeks ahead; keep five "evergreen" spare videos approved in advance |
| Cost creep | The cost log and the four-week comparison |
