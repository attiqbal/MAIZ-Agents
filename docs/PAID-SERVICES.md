# Paid services and the double-energy rule

Some things cost MAIZ money every time they run, on top of the AI itself. The first of these is video rendering from templates. This page says how they are charged and what is built.

## The rule

- One energy is one tenth of a US cent of real cost (see the energy section of `docs/ARCHITECTURE.md`).
- A paid service uses **its plain cost in energy, times one multiplier**. The multiplier is a single setting, `paidServiceMultiplier`, on the Prices page (`web/owner-prices.html`). It starts at **2** (double) and can be set from 1 to 10. It is dated and logged like every other price change.
- The cost is **shown before anything runs**. A request without the confirmed figure is refused with HTTP 409 and the quote. The caller sends the same figure back as `confirmEnergy`. If the owner changed the multiplier in between, the old figure is refused and the new one is shown.
- A client's agent pays from the **team's weekly pool** like any other work. There is still no per-task limit. The usual safety checks apply (trial ended, daily ceiling, an agent's own cap, the hidden monthly cost cap), and the pool plus bought top-ups must cover the whole amount, because a render cannot be half done. What the pool has is used first and the rest comes from top-ups.
- The owner's own agents (the promotion agent) have no pool. Their paid requests go through the same quote and confirm step and are logged with the energy figure, so the owner sees what a client would pay, but nothing is deducted.
- The hidden monthly cost cap counts the **real** cost, not the multiplied figure.
- Energy is taken only after the service accepts the job. A refusal, a wrong key or a network failure costs nothing.
- At most 25 paid requests per client (or per owner agent) a day, as a runaway guard.

## Practice mode

Until a key is saved on the Connections page, a render is a practice render: nothing is sent to any service and no energy is used. The screens and the confirm step work the same, so the flow can be tried safely.

## What is built

| Service | State |
|---|---|
| Creatomate | Built. Fills a template by id (`POST /v1/renders`). Key on the Connections page. |
| Shotstack | Built. Fills a template by id (`POST /edit/v1/templates/render`). Key on the Connections page. |
| Canva | Listed, not built. As far as we know template filling is for Canva Enterprise accounts. |
| Adobe Express | Listed, not built. No server-side template rendering found. |
| VEED | Listed, not built. Its API is for subtitles and AI video, not template filling. |
| Kapwing, InVideo | Listed, not built. No public render API confirmed. |
| Envato Elements, Motion Array | Guide only. A person downloads and licenses each item; the agent never downloads or re-shares files. |

Both built connectors were tested against fake servers only. Nothing has been rendered at Creatomate or Shotstack from this code yet, and the cost per video (about 10 and 20 US cents) is an estimate: the vendor's invoice is the real figure. After the first real renders, compare the invoice with the estimate in `src/modules/paid-services/catalogue.ts`.

## Who can use it today

- **The promotion agent (owner).** On an approved draft, open "Make a video from this draft", choose the service, paste the template id, see the cost, confirm. The draft's words fill the template's text slot. Nothing is published: the video link sits on the draft. Routes: `POST /api/owner/promoter/drafts/:id/video`, `.../video-status`, `GET /api/owner/promoter/video-services`.
- **Clients' agents (API only, no screen yet).** `GET /api/paid-services`, `POST /api/paid-services/:service/render` with `employeeId`, `templateId`, `fields` and `confirmEnergy`, `GET /api/paid-services/uses/:id`. These use the platform's key, which is why the multiplier applies.

## Safety notes

- Keys are typed on the Connections page (or set as `CREATOMATE_API_KEY` / `SHOTSTACK_API_KEY` on the server), stored like the other connection secrets and never sent back to the browser.
- Template ids and slot names are checked against a fixed pattern. A picture or clip must be an `https` address; the rendering service fetches it, our server never does.
- Calls go only to the two fixed vendor addresses, with redirects refused and a 20 second limit.
- Known limit: the record of a started render is kept in memory. After a server restart a render that was still in progress cannot be checked from the draft; the video is still in the vendor's dashboard.

## Add another paid service

Add it to `PAID_SERVICES` with its estimated cost, write its call in `render.ts` (or a sibling file for a different kind of service), and add its key to `videoKeys()` in the connections service. The quote, confirm step, energy charge and daily guard need no change.
