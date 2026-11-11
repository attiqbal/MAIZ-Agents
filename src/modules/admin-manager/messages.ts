/**
 * What the Admin manager says. Pure functions (no Node imports) so the website
 * shows exactly the same words as the chat apps and the dashboard inbox.
 * Written from templates, not by a model: no energy used, always accurate.
 */
import { getTemplate, type EmployeeTemplate } from "../workforce/templates.js";
import { formFor } from "./form.js";

/** Setup steps in the order they run. The titles are shown to the owner as progress. */
export const SETUP_STEPS = [
  { key: "profile", title: "Saving your business details" },
  { key: "storage", title: "Creating your storage" },
  { key: "models", title: "Preparing your AI models" },
  { key: "training", title: "Training your team on your answers" },
  { key: "finish", title: "Final checks" },
] as const;

export type SetupStepKey = (typeof SETUP_STEPS)[number]["key"];

export function stepTitle(key: SetupStepKey): string {
  return SETUP_STEPS.find((s) => s.key === key)!.title;
}

function teamOf(employeeKeys: readonly string[]): EmployeeTemplate[] {
  return employeeKeys.map((k) => getTemplate(k)).filter((t): t is EmployeeTemplate => !!t);
}

export function welcomeText(businessName: string, employeeKeys: readonly string[], trialDays: number): string {
  const team = teamOf(employeeKeys);
  return [
    `Hi, I'm your Admin manager at MAIZ agents. I'll set up ${businessName}'s AI team and keep it running for you.`,
    `Your package includes ${team.length} employees, free for your ${trialDays}-day trial:`,
    ...team.map((t) => `• ${t.title}: ${t.summary}\n  Can: ${t.capabilities.join("; ")}.`),
    "Nothing leaves your company without your approval, and your team shares one weekly energy allowance you can see in the control center.",
  ].join("\n");
}

export function formInviteText(employeeKeys: readonly string[], driveKind: "shared" | "standalone"): string {
  const fields = formFor(employeeKeys);
  const required = fields.filter((f) => f.required).length;
  return `To get started, please fill in a short setup form (${fields.length} questions, about 3 minutes; only ${required} are required). Once it's in, I'll train the team, create your ${driveKind} storage and prepare your AI models. I'll message you when everything is ready.`;
}

export function readyText(employeeKeys: readonly string[]): string {
  return [
    "Your team is set up and trained on your answers. First jobs lined up:",
    ...teamOf(employeeKeys).map((t) => `• ${t.title}: ${t.firstJob}`),
    "You can undo the setup from the control center at any time.",
  ].join("\n");
}
