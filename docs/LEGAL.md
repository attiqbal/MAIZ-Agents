# Legal entity and legal pages

**MAIZ AI Ltd**, company number **17579512**, a private company limited by shares, registered in England and Wales, incorporated 13 November 2026 (Companies House certificate). The product brand stays **MAIZ Agents**; the contracting party in the Terms and the data controller in the Privacy policy is MAIZ AI Ltd.

## Where it lives

| What | Where |
|---|---|
| Terms, Privacy policy, Cookies | `web/terms.html`, `web/privacy.html`, `web/cookies.html` |
| Entity facts for the website (one place) | `COMPANY` in `web/vite.config.ts`; pages use `%COMPANY_NAME%`, `%COMPANY_NUMBER%`, `%REGISTERED_OFFICE%`, `%CONTACT_EMAIL%` |
| Footer line, JSON-LD `legalName` and company number, `llms.txt` | same file and `web/partials/footer.html` |
| Email footers | `COMPANY_LEGAL_LINE` in `src/server/email-templates.ts` |
| Consent line at signup | `web/onboarding.html` (`#agree`) |

## Values you must supply (the certificate does not give them)

- `REGISTERED_OFFICE`: the address on Companies House. Set it as a build argument (website pages) and as a runtime variable (email footers). Until set, the pages show `[registered office address to be added]`.
- `CONTACT_EMAIL`: an inbox someone reads; privacy requests go there. Until set, the pages show `[contact email to be added]`.

## Not claimed anywhere (add only when true)

ICO registration or fee, VAT number, professional indemnity or cyber insurance, a data protection officer.

## Needs a solicitor

These are standard drafted terms, not legal advice. Have them checked, especially the liability cap, the processor terms (UK GDPR Art. 28), international transfers, retention periods, the AI-output disclaimer, and the refund and cancellation wording.
