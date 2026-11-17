# Teammates: inviting people into a business with limited rights

Built 16 November 2026. Before this, one login was one business. Now the owner can invite other people into the same business and choose what each one can do.

Code: `src/modules/teammates` (invites and the people list), `src/server/team-routes.ts` (routes), `src/server/route-policy.ts` (who may call what), `web/src/access.ts` (Settings panel and a teammate's view), `web/join.html` and `web/src/join.ts` (the page an invite link opens). Tests: `test/teammates.test.ts` and `test/role-routes.test.ts`.

## The roles, in plain words

The words on screen are the left column. The names in code are in brackets.

| What they can do | Owner (`owner`) | Manager (`admin`) | Team member (`member`) | View only (`viewer`) |
| --- | --- | --- | --- | --- |
| See the team's work, results, conversations, energy and connected apps | Yes | Yes | Yes | Yes |
| Turn alerts on for their own device, mark their own notifications as seen | Yes | Yes | Yes | Yes |
| Ask the team for work, follow up, run or cancel queued work, answer a review, use the Data mining agent | Yes | Yes | Yes | No |
| Refresh an app that is already connected, or upload a newer file for it | Yes | Yes | Yes | No |
| Approve, reject or cancel a social post that is waiting; put entries into the books | Yes | Yes | No | No |
| See and change staff records (personal data), and change the rota | Yes | Yes | No | No |
| See pay on the rota (hourly rates and what the week costs) | Yes | Yes | No | No |
| Ask MAIZ to design a new specialist | Yes | Yes | No | No |
| Hire or buy from the store, take on a specialist at a monthly price | Yes | No | No | No |
| The plan, checkout, the billing page, cancelling, orders, gift and discount codes, energy top-ups and auto-reload | Yes | No | No | No |
| Connect or remove apps, Slack, social accounts and outside AI tools; choose which employees see an app | Yes | No | No | No |
| How the business is set up (setup form, first day, batch times) | Yes | No | No | No |
| Delete a staff record for good | Yes | No | No | No |
| Invite people, change what they can do, remove them | Yes | No | No | No |

There is one owner: the person who made the business. Nobody can be invited as an owner, and the owner cannot be changed or removed. Moving a business to a new owner is not built.

## Inviting

The owner opens Settings, "People with access", types an email address and picks Manager, Team member or View only. MAIZ emails a link.

- The link holds a random secret (32 random bytes). Only its SHA-256 is stored, and the answer to the owner never carries it. It rides after the `#` in the address, so it does not reach server logs or other sites.
- It works once and lasts 7 days (`INVITE_DAYS`).
- The owner sees invites that are waiting or have run out, and can send one again (a new link; the old one stops at once; the 7 days start again) or cancel it.
- A business can have up to 10 people, counting the owner and invites still waiting (`MAX_PEOPLE_PER_WORKSPACE`, one constant in `src/modules/teammates/index.ts`).
- Limits: 10 invites an hour for one business, 3 a day to one address (`INVITES_PER_WORKSPACE_PER_HOUR`, `INVITES_PER_ADDRESS_PER_DAY`), plus the request limits in `src/server/rate-limit.ts`.
- The owner is never told whether an address already has a MAIZ Agents account. The answer and the email are the same either way.
- In development only (`ALLOW_DEV_AUTH=1`) the answer also carries the link, so a tester can join without email.

## Joining

The link opens `/join.html`, which shows the business, the role and what that role can do. An invite can only be used by someone who proves they own the address it was sent to.

| Who opens the link | What happens |
| --- | --- |
| A new address, not logged in | The link itself was emailed to the address, so its holder chooses a password and joins. |
| An address that already has an account, not logged in | They must log in with that address first (password, emailed link, Google or Microsoft). The link can never set or change a password. |
| Logged in with the invited address | One button: Join. Google and Microsoft count because MAIZ only accepts an address the provider says is verified. |
| Logged in with another address | Refused, with the two addresses shown and a button to log out. |

The join page keeps the link in the browser tab while the person logs in, so Google, Microsoft and "Email me a log-in link" all come back to it. A person who logs in without the link is also taken to the join page if an invite is waiting for their address, before they are asked to set up a business of their own.

A person who joins is not asked the business setup questions and does not get a trial of their own. Joining is free for them.

### One address, one business

An address belongs to one business. If the invited address already has its own business (or is already in another one), the invite is refused with a plain message: ask to be invited at another email address. Their own business is not touched.

Why: every screen and every route works out "your business" from the login alone. Letting one login hold two businesses needs a way to switch between them on every page and every request. That is a larger change with real risk of showing one client another client's data, so it is left for later. MAIZ's own platform owner accounts cannot join a client's business at all.

## Changing and removing

The owner can change a person's role or remove them in the same panel. Both take effect on the person's next request: the session only says who they are, and what they may do is looked up each time. Removing also switches off that person's device alerts for the business.

Removal is stored as its own record (`member_gone`) that wins over the stored membership row when the server starts, so no database change was needed. People and invites are stored as `team_member` and `team_invite` records.

The audit log records `team.invited`, `team.invite_resent`, `team.invite_cancelled`, `team.invite_accepted`, `member.added`, `member.role_changed` and `member.removed`.

## How every route is checked

`src/server/route-policy.ts` holds one table, `CLIENT_RULES`: a line per route with the permission it needs and the words a person sees when refused. `roleGate` runs in `src/server/app.ts` after the login is read and before any route.

- A route that changes something (anything but `GET`) and has no line is **the owner's alone**. A new route is safe by default.
- A `GET` with no line is open to everyone in the business. The services still check `task.read`.
- A refusal is `403` with `reason: "role"` and a short reason: "Only the owner can change the plan, billing, top-ups or codes.", "Only the owner or a manager can approve this.", or for view only "You have view-only access, so you can look but not change anything."
- The services keep their own checks as a second wall.
- MAIZ's own owner pages (`/api/owner/*`) and the public and key-signed routes are outside this table. They have their own checks.

### Adding a route

`test/role-routes.test.ts` reads the server's route files and fails if a client route has no decision. For a new route:

1. If it changes something, or not everyone may read it, add a line to `CLIENT_RULES` with the permission it needs.
2. Add it to `CHANGES` in the test with the lowest role that may call it. The test then calls it as each of the four roles.
3. If it is a read for everyone in the business, add it to `READS`. If it needs no business (public, signed, the person's own account), add it to `OUTSIDE`.

## On screen

- Settings, "People with access": the owner sees everyone, pending invites and the invite form. Anyone else sees who the owner is and their own role.
- A teammate sees the business name and "Your access: Team member" in the sidebar.
- Where a role cannot do something, the control is hidden or dimmed and a short line says why ("Only the owner can change the plan or see billing."). A view-only person has a bar at the top of every screen and the ask bar is switched off.
- If a control is missed on screen, the server still refuses and its reason is shown.

## Not built

- One login in two businesses, and switching between them.
- Passing a business to a new owner.
- A removed person's open browser tab keeps what is already on screen until its next request.
- A teammate cannot leave by themselves: the owner removes them.
