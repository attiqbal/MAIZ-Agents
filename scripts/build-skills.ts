/**
 * Writes each employee's job description as an Agent Skills folder:
 *   skills/<key>/SKILL.md      what the employee is hired to do, for people and models
 *   skills/<key>/manifest.json lane, tools, authority and energy, for the capability registry
 * Source of truth: src/modules/workforce/job-descriptions.ts. Run `npm run skills` after editing it;
 * a test fails if these files are out of date.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { skillFiles } from "../src/modules/workforce/skill-files.js";

const root = resolve(import.meta.dirname, "..");
const files = skillFiles();
// Remove folders of roles that no longer exist, so skills/ always matches the source.
const wanted = new Set(files.map((f) => f.path.split("/")[1]));
if (existsSync(resolve(root, "skills"))) {
  for (const d of readdirSync(resolve(root, "skills"))) if (!wanted.has(d)) { rmSync(resolve(root, "skills", d), { recursive: true }); console.log(`removed skills/${d}`); }
}
for (const f of files) {
  const path = resolve(root, f.path);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, f.content);
  console.log(`wrote ${f.path}`);
}
