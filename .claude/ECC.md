# ECC in this repo

We use [ECC](https://github.com/affaan-m/ECC) (MIT, by Affaan Mustafa) as our agent harness: skills, agents, rules and a research-first, verify-before-ship workflow.

## Two layers

1. **A pinned copy of what the website needs.** The skills, agents and rules below are copied into `.claude/` so they work in every Claude Code session on this repo (local, cloud, Codespace) without installing anything, and so a change upstream cannot silently change how we build.
2. **Everything else, via the plugin (opt-in).** To get all 314 ECC skills, 71 agents, commands and hooks, add this to `.claude/settings.json` (shared with the team) or `~/.claude/settings.json` (just you):

   ```json
   {
     "extraKnownMarketplaces": { "ecc": { "source": { "source": "github", "repo": "affaan-m/ECC" } } },
     "enabledPlugins": { "ecc@ecc": true }
   }
   ```

   or run `/plugin marketplace add https://github.com/affaan-m/ECC` then `/plugin install ecc@ecc` inside Claude Code. The plugin runs ECC hooks by default; set `hooks_enabled` to false in its settings if you only want the skills. It is opt-in because hooks run code on whoever's machine opens the repo.

Pinned source: `affaan-m/ECC` at `b38be6a7f6350964d59328b52f0624e1d1d552d1` (v2.2.3, 2026-10-29). Licence: [ECC-LICENSE](ECC-LICENSE). Files are unmodified copies, plus one shim: `skills/frontend-design-direction/scripts/package.json` marks the evidence checker as CommonJS, because this repo's root `package.json` is an ES module.

| Folder | Contents |
| --- | --- |
| `skills/` | frontend-design-direction, make-interfaces-feel-better, accessibility, frontend-a11y, seo, browser-qa, design-system, frontend-patterns, vite-patterns, typescript-patterns, security-review, verification-loop, search-first, e2e-testing, tdd-workflow, brand-voice, coding-standards, api-design |
| `agents/` | planner, code-reviewer, typescript-reviewer, security-reviewer, a11y-architect, seo-specialist, performance-optimizer, e2e-runner, silent-failure-hunter |
| `rules/ecc/` | common, typescript, web (loaded as project rules; plugins cannot ship rules) |

## Updating

```
git clone https://github.com/affaan-m/ECC.git /tmp/ecc && git -C /tmp/ecc rev-parse HEAD
# copy the same folders over the ones in .claude/, review the diff, update the pinned commit above
```

Only take ECC from the official sources listed in its README, and review an update's diff like any other dependency.
