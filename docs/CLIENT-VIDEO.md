# Videos for clients

Clients can make a short video from a template they designed at Creatomate or Shotstack, with their own brand details filled in. Screen: `/app.html#video` ("Videos"). It is a thin layer over paid services (`docs/PAID-SERVICES.md`), which still does the pricing, the confirm step and the energy charge.

## The flow

1. **Your brand**: business name, brand colour (`#rrggbb`), logo (a public https address) and tagline, saved once.
2. **Make a video**: pick who makes it, the service, paste the template id, and fill each slot of the template with typed text, a picture address, or a brand detail ("Title" is *My business name*). The first press shows the cost; the second press confirms it. The figure sent back must equal the quote, otherwise the server answers 409 with the new figure.
3. **Cost**: the plain cost times the owner's one multiplier (double by default), taken from the team's weekly pool. With no key saved on the owner's Connections page it is a **practice video**: nothing is sent to any service and no energy is used.
4. **Approve before use**: a finished video waits as *Ready to check*. Only an owner or admin (the `approval.decide` right) can approve or say it is not right. A "not right" note becomes a preference the team learns (`docs/LEARNING.md`).
5. **Nothing is published.** Approval only marks the video good to use. The client downloads it or uses the link and posts it where they want. No post, email or ad is sent from this screen.

Routes: `GET /api/video`, `POST /api/video/brand`, `POST /api/video` (make; 409 until the cost is confirmed), `POST /api/video/:id/refresh`, `POST /api/video/:id/decide`, `DELETE /api/video/:id`.

## Specialised services

The screen lists the services that are not built (Canva, Adobe Express, VEED, Kapwing, InVideo) so nobody expects them, and points to the **Brand and content creator** in the store and its **Video scriptwriter** role. That specialist writes the idea and the script; the video is still rendered from a template. Specialists and consultants are unchanged.

## What is real and what is mocked

| | State |
|---|---|
| Screen, brand details, slot mapping, cost step, approval, learning from approval | Built and tested (`test/client-video.test.ts`). |
| Charging double energy from the team pool, daily guards, refund on failure | Built and tested against the paid-services module. |
| Creatomate and Shotstack calls | **Tested against fake servers only.** No video has been rendered at either service from this code. The cost per video (about 10 and 20 US cents) is an estimate: compare it with the vendor's invoice after the first real renders. |
| Templates | The client designs them at the vendor. MAIZ does not ship, generate or host templates. It does not make videos from nothing ("generate video from a prompt"): it fills a template. |
| Brand "from the site" | Not automatic. The client types or pastes their brand details. The site reading does not fetch a logo or colours. |
| Video storage | The video stays at the vendor. We keep the title, slots and link. A started render's status is held in memory, so after a server restart a render that was still in progress cannot be refreshed here (the video is still in the vendor's dashboard). |

Say on the website: "make short videos from your own templates, with your brand filled in", not "in-house video generation".
