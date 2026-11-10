import { JOB_DESCRIPTIONS, getJobDescription, renderManifest, renderSkillMd } from "./job-descriptions.js";
import { allRoles } from "./blueprints.js";
import { TASK_ROLES } from "./task-roles.js";
import { getTemplate } from "./templates.js";

/** Every role the Admin manager can hire: ready-made employees, custom specialists and task hires. */
export function allHireableKeys(): string[] {
  const keys = [...JOB_DESCRIPTIONS.map((j) => j.key), ...allRoles().map((r) => r.key), ...TASK_ROLES.map((r) => r.key)];
  return [...new Set(keys)];
}

/** The skills/ folder contents: one job description (SKILL.md) and manifest per hireable role. */
export function skillFiles(): { path: string; content: string }[] {
  return allHireableKeys().flatMap((key) => {
    const jd = getJobDescription(key);
    if (!jd) return [];
    return [
      { path: `skills/${key}/SKILL.md`, content: renderSkillMd(jd) },
      { path: `skills/${key}/manifest.json`, content: renderManifest(jd, getTemplate(key)?.tier ?? "standard") },
    ];
  });
}
