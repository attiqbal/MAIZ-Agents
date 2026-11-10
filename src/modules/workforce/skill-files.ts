import { JOB_DESCRIPTIONS, renderManifest, renderSkillMd } from "./job-descriptions.js";
import { getTemplate } from "./templates.js";

/** The skills/ folder contents generated from the job descriptions. */
export function skillFiles(): { path: string; content: string }[] {
  return JOB_DESCRIPTIONS.flatMap((jd) => [
    { path: `skills/${jd.key}/SKILL.md`, content: renderSkillMd(jd) },
    { path: `skills/${jd.key}/manifest.json`, content: renderManifest(jd, getTemplate(jd.key)?.tier ?? "standard") },
  ]);
}
