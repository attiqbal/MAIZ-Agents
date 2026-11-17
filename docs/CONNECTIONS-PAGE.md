# Owner Connections page

`/owner-connections.html` is for the platform owner only. It lists every service the site and the AI team connect to.

## Tiers

Each service has a tier and a one-line reason the owner can read.

- **Critical**: the site cannot do its basic job without it. Payments (Stripe), the AI engine (RunPod), quality checking (Claude) and email sending (Resend).
- **Must have**: a main advertised feature depends on it. Sign in with Google and Microsoft, Slack, Xero, QuickBooks, Google Analytics and Search Console.
- **Optional**: everything else. Square, the owner's own Facebook, Instagram and WhatsApp, the market research sources, the video services, and the other client apps.

The built-in tiers are in `src/modules/connections/tiers.ts`. A definition can set its own `tier` (the `tier?` field on `ConnDef`), which always wins. A service with no tier is Optional, and its reason is written from its kind. Tests: `test/connections-manage.test.ts`.

## How a service is connected (the mode)

- **editable**: the owner types the details on the page.
- **server**: set in the server's own settings (Stripe, RunPod, Claude, or any editable service whose server settings are complete). The page shows its status and a Test button.
- **approval**: the provider must approve MAIZ's app first. The page says what to send and where.
- **manual**: no way to connect. The page says what the team does instead.

## The page

A list on the left (on a phone, a list you tap into, with an "All services" link back) and the one selected service on the right. In the list, each tier is a group with a count ("3 of 5 working"), and inside a group what needs the owner comes first: failed, then not set up, then waiting for approval, then working, then used by hand. Search and the status filters (Needs you, Working, Waiting for approval, Cannot be connected) narrow the list.

The address is `#c-<key>`, so links from other pages keep working. Choosing a service changes the address and moves focus to its heading. The list is plain links, so it is one tab stop per service, and status changes are announced politely.

The page draws whatever the server lists. It has no list of service keys, so connectors and new services added elsewhere appear with no change to the page.

## Managing a saved service

- The saved details show as "Saved", never the secret, with when each was last changed. A non-secret detail (an id, an address) is shown as it is.
- **Change** replaces one detail without retyping the others. Leaving a secret box empty keeps the saved one.
- **Test connection** makes one harmless read and shows the result in words. The last result is kept across a reload and a restart.
- **Disconnect** asks first and says what stops working for clients and the team. It removes the saved details and the times and test result.

## What is stored

The details go through the existing encrypted connection-secret store. One more record, `conn:meta`, holds the last-changed time of each detail (a field name and a time, never a value) and the last test result of each service. Test messages have every known secret removed before they are stored. On start-up the record is read back and anything for a service or detail that no longer exists is dropped.

## Routes (owner only)

- `GET /api/owner/connections`: every service with `tier`, `tierWhy`, `mode`, `changedAt`, and per field `changedAt`. No secret is ever sent.
- `PUT /api/owner/connections/:key`: save or change details (`clear` removes named optional details).
- `POST /api/owner/connections/:key/test` and `.../disconnect`. Each is rate limited.
