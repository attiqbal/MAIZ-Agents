# The MAIZ Office: cast bible

Series pitch: a relaxed, warm, dry comedy set in the back office of a small business whose staff are the MAIZ team. Think Sesame Street warmth with The Office timing. The humour comes from each employee's one comic trait, which is always a funny exaggeration of their real job. The human boss is the straight man and is never seen.

Read [00-positioning.md](00-positioning.md) first. Names below are the display names already in `src/modules/onboarding/people.ts`; Atif has not formally signed them off, so they are easy to change (the whole series uses `{NAME}` from this file).

## 1. Format rules (apply to every video)

- Vertical 9:16, 15 to 30 seconds (hero episodes up to 45). Hook inside 2 seconds.
- One situation per video. Maximum two speaking characters plus the Boss voice. Maximum six shots.
- Same single set every time (section 5). No location changes.
- Captions burned in (most people watch muted). Dialogue is also in the caption track.
- Every video ends on the same four-beat button: the Boss line, a character reaction, a price or fact card (max one), the CTA card with the character's code or tracked link.
- Opening 0.5s: the paper-cut M-with-hat logo "stamp". Closing 1s: logo stamp and `maizagents.com`.
- Disclosure card in every video, bottom-left, small: "A comedy. Fictional characters. Made with AI." Use each platform's AI-content label as well.
- Product screens appear only as inserts (maximum 3 seconds) and are labelled "Example" unless recorded from a verified real account.

## 2. The Boss (the straight man)

- Never seen. Heard as a voice from off-screen (voice-over, relaxed, slightly tired, kind) or read as a Slack message on screen (white speech bubble, grass-green tick when approved).
- Gender-neutral, name never said. The characters call them "boss" or "Boss".
- Role: asks reasonable and sometimes impossible things, approves with a short "Yes", "Go on then" or "Redo it". The approval line is the comic and product beat: nothing goes out without it.
- Boss is never mocked. The joke is always the situation or the employee's quirk.
- Recurring Boss lines: "Is it done?" (it was done yesterday), "Yes." (approval), "Redo that, please." (redo returns energy, said once per week-arc), "Who approved that?" (answer: "You did, boss. Tuesday.")

## 3. The managers

Each manager: name, job, comic trait (tied to the real job), voice, look, catchphrase, flaw (never serious), what they love, what they dread, and the product feature they carry. Look uses the existing flat paper-cut avatars (`av-*` classes in `web/src/styles.css`). Do not use stock or copied art; all new character art is generated from our own avatars as reference.

### Maya, Admin manager (the glue)
- Job: sets everything up, routes every request to the right employee, writes the daily briefing, costs no energy.
- Comic trait: runs the office like air traffic control, calm, always three moves ahead, says "I've already sent that to Felix" before the boss finishes the sentence.
- Voice: warm, quick, bright, slightly British. Never rushed. Short sentences.
- Look: tidy bun, headset, a clipboard that is always exactly the right clipboard. Colour: grass green.
- Catchphrase: "Already on it."
- Flaw: cannot leave a loose end alone; labels the labels.
- Loves: handovers. Dreads: "can you just quickly...".
- Carries: routing, daily briefing, three-minute setup, free manager, Slack.

### Felix, Finance manager (the accountant who counts everything)
- Job: books, receipts, cash snapshot, profit and loss.
- Comic trait: deadpan, counts things that do not need counting (biscuits, steps, the number of times boss says "quickly"). Treats every number as sacred.
- Voice: dry, precise, measured, one raised eyebrow in the voice. Says numbers slowly.
- Look: round glasses, cardigan, calculator on a lanyard. Colour: deep ink blue.
- Catchphrase: "Every figure has a source."
- Flaw: cannot round. Will not say "about".
- Loves: reconciled accounts. Dreads: the Shoebox.
- Carries: finance manager, receipts inbox, cash and runway, reversals not edits, traceable figures.

### Poppy, Marketing manager (the enthusiast)
- Job: 30-day plan, posts and emails in the owner's voice.
- Comic trait: relentlessly upbeat, everything is "a moment", speaks in headline drafts, then asks permission.
- Voice: bright, bouncy, fast, rises at the end of sentences. Gets noticeably quieter when asking "Approve?".
- Look: big hair, scarf, coral accents, a megaphone she is learning not to use. Colour: coral.
- Catchphrase: "I've drafted three! Pick one!"
- Flaw: over-celebrates small things.
- Loves: a good first line. Dreads: "make it pop" with no brief.
- Carries: voice learnt from your site, drafts and approvals, 30-day plan, Slack approval buttons.

### Basil, Business consultant (the pensive strategist)
- Job: reviews costs and suppliers, compares to the market, brings ideas, weekly review, every number labelled by source.
- Comic trait: speaks in considered, slightly gloomy pronouncements, then turns out to be right. Labels his own hunches "low confidence".
- Voice: low, slow, thoughtful, wry. Long pauses.
- Look: tall, tweed jacket, tea in a chipped mug, eyebrows doing most of the talking. Colour: sky blue.
- Catchphrase: "Confidence: medium."
- Flaw: cannot give a straight yes without a caveat.
- Loves: a good chart. Dreads: "just go with your gut".
- Carries: cost check, supplier review, source labels, weekly review, hand-offs to Finance and Marketing.

### Hana, HR manager (the kind one)
- Job: job ads, interview scorecards, offer letters, onboarding checklists, handbook, staff records.
- Comic trait: relentlessly kind and fair, with a warm voice that is occasionally terrifying when a form is missing. Hugs by checklist.
- Voice: gentle, patient, clear. Pauses before saying a person's name. Quietly firm.
- Look: soft cardigan, lanyard of tiny enamel pins, a mug that says "Be kind (and keep records)". Colour: sunshine.
- Catchphrase: "Let's do this properly."
- Flaw: cannot help giving an onboarding checklist to a plant.
- Loves: a complete file. Dreads: a hire that starts without a contract.
- Carries: HR manager, ads, scorecards, offer letters, handbook, privacy of staff details. Never says "employment lawyer".

### Cato, Compliance manager (the lighthouse)
- Job: register of what applies, dated statements citing official sources, checks drafts before approval.
- Comic trait: treats every deadline like weather. Gravely announces that something "is approaching" three weeks early. Always dated, always cited.
- Voice: slow, formal, soft. Reads dates as if they were poetry.
- Look: long coat indoors, a lighthouse-shaped desk lamp, an umbrella for forecasts of paperwork. Colour: slate.
- Catchphrase: "As of today's date."
- Flaw: cannot say "probably".
- Loves: an official source link. Dreads: "I'm sure it's fine".
- Carries: compliance register, dated statements, draft checks. Never says "we guarantee you comply" or "we know the law".

### Sol, Stock and supply manager (the pigeonhole person)
- Job: stock, suppliers, supply chain (store add-on at £25).
- Comic trait: lives among shelves, speaks in quantities, cannot pass a half-empty box. Small, practical, slightly sulky about "just in time".
- Voice: grounded, brisk. Count-offs.
- Look: hi-vis waistcoat, clipboard on a string, a pencil behind each ear. Colour: orange.
- Catchphrase: "Reorder point reached."
- Appears only in add-on arcs (grow-your-team pillar).

### Dara, Data mining agent (the detective)
- Job: gathers public market data for the rest of the team (add-on at £25).
- Comic trait: speaks like a noir detective about completely ordinary facts ("The price was £4.20. But it had a past.").
- Voice: low, smoky, dramatic, then switches to cheerful when handing over.
- Look: trench coat, magnifying glass, a notebook of dates. Colour: plum.
- Catchphrase: "I found something. It's public."
- Appears only in add-on arcs. Do not show real data-source results as proof (see positioning section 7).

## 4. The non-employees (running gags)

All original and mute or minimal, so they can be reused without voice casting.

- **The Shoebox:** a shoebox of receipts, the series antagonist. Felix refers to it with dread. It "arrives" at the start of arcs, is tamed by the receipts inbox, and returns as a gag. Never speaks; rattles.
- **Gerald the plant:** office plant, always fine. Used as a stoic reaction shot and, once, as a joke "new hire" in a Hana episode.
- **The printer:** unreliable machine, no product link. A reliable gag when the boss asks for "a quick print".
- **The Sticky Note:** the Boss's handwritten notes appear as sticky notes on screen (comedy: all say the same three things).
- **The Clock:** a wall clock that is always 9:00 on Monday and 3:00 in the "3am shift" episodes. It is a prop, not a character.

## 5. The set (one set, always the same)

- A small, cosy open-plan office in warm cream paper tones (matches the site: cream paper canvas, white cards, ink text, grass-green accent).
- Fixed layout, left to right: Maya's desk (centre, big clipboard), Felix (left, calculators), Poppy (right, posters), Basil (back, bay window, tea), Hana (front, mug wall), Cato (corner, lighthouse lamp). A visible door to "boss's office" off-screen right where the Boss voice comes from.
- Four wall features for continuity: a wall clock, a corkboard of sticky notes, a window with a recurring weather type that matches the episode mood, a shelf with Gerald.
- Lighting: always warm daylight. The only "night" set is the "3am shift" variant (same set, dark windows, desk lamps, wall clock at 3:00).
- No stock images. All art is original paper-cut, flat shapes, no gradients or shadows (matches the site direction).

## 6. Character interaction rules

- Maya hands off. Felix, Poppy, Basil, Hana, Cato do. The Boss approves.
- Handoff chain is the series' signature: "Basil says costs are up" then "Felix, can you check?" then "Poppy, don't announce it yet" then "Cato, is that allowed?" then "Hana, who needs telling?" Keep to one link of the chain per video unless it is a hero episode.
- Felix and Poppy are the odd couple (precision and excitement). Basil and Cato are the slow pair. Hana and Maya are the glue.
- Passive-aggressive handoffs are sweet, never cruel. They always end with someone saying "Thanks".
- When an employee's trait fails, it fails in a comic way that still shows the product working (for example Poppy over-celebrates, then drafts the right post anyway).

## 7. Voices (AI voice direction)

- Cast distinct voices, no celebrity soundalikes and no real-person cloning. One voice per character, consistent across the series. Maya bright and quick, Felix dry and precise, Poppy bouncy, Basil low and slow, Hana gentle, Cato formal and slow, Sol brisk, Dara smoky, Boss tired and kind.
- Record guide-lines from the script with the human review gate (see [03-production-workflow.md](04-production-workflow.md)). Keep the same voice id for each character from episode one.
- Pace: no more than 160 words per minute; keep lines to 12 words or fewer where possible.

## 8. Comedy rules

- Each video has one joke and one product point, and they are the same moment.
- Comic trait first, product second, CTA last.
- Dry understatement beats shouting. No character shouts except Poppy, who is told off for it by Maya.
- Never joke about a real regulator, a real business, a real person, a protected group or real hardship.
- No sarcasm directed at the viewer. The viewer is the Boss.
- The Boss always keeps the last word on the video, except the CTA.

## 9. Things the cast never says

- "We guarantee", "100% accurate", "replaces your accountant/lawyer/HR", "legal advice", "certified", "audited", "trusted by".
- Any customer count, testimonial or review.
- Any claim about how the AI "thinks".
- Anything about a real outside company's product.
- A discount that does not exist.

## 10. Image prompts (for consistent look in AI video tools)

Keep one shared style prefix in every shot prompt, then add the character line:

- Style prefix: "flat paper-cut illustration, warm cream paper background, soft cut-out shapes, no gradients, no shadows, simple geometric characters with round heads, warm daylight office, 9:16, gentle camera moves only".
- Character lines: use each manager's Look line above plus the avatar reference image from `web/src/styles.css`.
- Keep characters the same size ratio and desk positions as in section 5.
