# Legal entity and legal pages

**MAIZ AI Ltd**, company number **17579512**, a private company limited by shares, registered in England and Wales, incorporated 13 November 2026 (Companies House certificate). The product brand stays **MAIZ Agents**; the contracting party in the Terms and the data controller in the Privacy policy is MAIZ AI Ltd.

Registered office: 20 Wenlock Road, London, N1 7GU, England. This is the formation agent's address (Companies Made Simple), so the registered-office service there needs the director's ID check completed to stay active.

## Where it lives

| What | Where |
|---|---|
| Company name, number, registered office (one source) | `src/company.ts` |
| Terms, Privacy policy, Cookies | `web/terms.html`, `web/privacy.html`, `web/cookies.html` (use `%COMPANY_NAME%`, `%COMPANY_NUMBER%`, `%REGISTERED_OFFICE%`, `%CONTACT_EMAIL%`) |
| Footer line, JSON-LD `legalName` and company number, `llms.txt` | `COMPANY` in `web/vite.config.ts` and `web/partials/footer.html` |
| Email footers | `COMPANY_LEGAL_LINE` in `src/server/email-templates.ts` |
| Consent line at signup | `web/onboarding.html` (`#agree`) |

Only the company name, number, registered office and incorporation date are used. Director, shareholder and PSC details are not published anywhere on the site.

## Still needed from the owner

- `CONTACT_EMAIL`: an inbox someone reads; privacy requests go there. Set it in `deploy/.env` (it is a build argument) and rebuild. Until set, the Terms and Privacy pages show `[contact email to be added]`.

## Not claimed anywhere (add only when true)

ICO registration or fee, VAT number, professional indemnity or cyber insurance, a data protection officer.

## Needs a solicitor

These are standard drafted terms, not legal advice. Have them checked, especially the liability cap, the processor terms (UK GDPR Art. 28), international transfers, retention periods, the AI-output disclaimer, and the refund and cancellation wording.
