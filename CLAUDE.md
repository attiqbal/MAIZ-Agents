# MAIZ Agents: working notes for Claude Code

A store of AI employees for people who know nothing about AI. Backend: TypeScript modular monolith in `src/` (see `docs/ARCHITECTURE.md`). Website: `web/` (Vite + TypeScript, no framework).

This repo follows the ECC harness. Skills, agents and rules are pinned in `.claude/` (see `.claude/ECC.md`).

## Workflow (ECC `rules/ecc/common/development-workflow.md`)

1. Research and reuse first (`search-first`): check the existing code, tokens and components before adding anything new.
2. Plan non-trivial work with the `planner` agent.
3. Tests first for backend logic (`tdd-workflow`); `npm run check` must pass.
4. Review with `code-reviewer` / `typescript-reviewer`, and `security-reviewer` for anything touching auth, input or secrets.
5. Conventional commits.

## Website rules

- Direction: "warm storybook on cream paper" (MindMarket style reference, chosen by the owner on 2026-11-12, replacing the light editorial Ember style of 2026-11-11). Tokens live at the top of `web/src/styles.css`: Cream Paper canvas, white pill nav and cards, Ink text, Fresh Grass as the one decorative accent, Coral for service-level buttons, Sunshine for the footer, Inter only (huge sizes, tight tracking), 50px pills and 32 to 64px radii, no shadows or gradients. Old token names are kept and remapped. Fresh Grass (and Coral, Sky, Sunshine) are never body text; use `--accent-text` (dark grass) for readable accent text. Avatars are original flat paper-cut characters (inline SVG data URIs in `styles.css`, scene in `web/index.html`); do not add stock or copied art.
- Before UI work, read `frontend-design-direction` and `rules/ecc/web/design-quality.md`. Polish with `make-interfaces-feel-better` (no `transition: all`, tabular numbers for figures, 40px+ hit areas).
- Accessibility: WCAG 2.2 AA (`accessibility`, `frontend-a11y`). One `main` landmark per page, all content inside landmarks, visible focus, 4.5:1 text contrast.
- SEO (`seo`): one H1, titles about 50 to 60 characters, honest meta descriptions, JSON-LD that matches visible content. App and onboarding pages are `noindex`.
- Security (`rules/ecc/web/security.md`): never put unescaped data into `innerHTML` (use `esc()`), production headers and CSP in `web/public/_headers`.
- Performance budget (`rules/ecc/web/performance.md`): landing JS < 150 kB gz, CSS < 30 kB gz, at most two web font families.

## Finish gate for website changes

```
cd web
npm run build
npm run qa          # Playwright + axe at 375/768/1440, writes qa/out/report.json and screenshots
node ../.claude/skills/frontend-design-direction/scripts/check-evidence.js qa/evidence/evidence.json
```

Update `web/qa/evidence/evidence.json` with what you actually checked. A passing checker does not replace looking at the screenshots.

## Secrets

Never commit keys. `.env` is ignored; `.env.example` lists the variables.
