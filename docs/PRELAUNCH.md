# Pre-launch mode: register your interest

Until MAIZ Agents opens, the website collects a mailing list instead of signups. One switch, `SIGNUP_MODE`:

| Value | Website | Server |
| --- | --- | --- |
| `interest` (default) | Every "Start free trial / Sign up" button says **Register your interest** and goes to `/register-interest.html`. No 7-day-trial or "no card" promise. `/onboarding.html` redirects there. | `POST /api/signup` is refused (403) for everyone except the platform owner. Logging in, Stripe and the existing signup code are untouched. |
| `open` | The normal site (free trial, signup flow). | Normal signup. |

**Turn signup back on:** set `SIGNUP_MODE=open` in `deploy/.env` (or Render), then rebuild: `docker compose up -d --build`. The website copy is built in, so a restart alone is not enough.

**Test signup while pre-launch:** log in as a platform owner and open `/onboarding.html?preview=1`.

## What happens when someone registers

- `POST /api/interest` stores name, email, business, what they need and the page they came from (platform-level record, kind `interest`; survives restarts with Postgres).
- The person gets a short thank-you email; every `PLATFORM_OWNER_EMAILS` address gets a "New interest" email. The same address twice updates one entry and sends one thank-you.
- Anti-abuse: a hidden honeypot field, 3 tries per address per hour, 300 per hour across the site.
- The owner sees the list at `/owner-interest.html` (menu: Interest list), can download it as a spreadsheet and can remove a person who asks.

## Copy

Interest-mode wording lives in `web/signup-mode.ts` (one table of replacements applied at build time, so `open` mode is the original copy). The Privacy Policy lists the interest list under "What we collect" and "How long we keep it"; the Terms trial section says the trial is not confirmed until launch. Have a solicitor confirm the consent wording and the retention line.

## Not built

Bulk email to the list from inside MAIZ (export the spreadsheet and use your mail tool, with the consent given at registration), and a self-service "remove me" link (people reply to the email or write to the privacy address).
