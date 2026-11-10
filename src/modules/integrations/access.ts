import type { Capability } from "./types.js";

/**
 * Least privilege: which employees get which kind of app data when the owner connects an app.
 * The owner can widen or narrow this per connection. Unknown employees get nothing.
 * Payroll is personal data, so only the employees whose job needs it see it by default.
 */
export const DEFAULT_ACCESS: Record<Capability, readonly string[]> = {
  "sales.read": ["finance-manager", "business-consultant", "marketing-manager", "compliance-manager"],
  "payroll.read": ["finance-manager", "hr-manager", "compliance-manager"],
  "accounts.read": ["finance-manager", "business-consultant", "compliance-manager"],
};

/** Employees that may never be given app data (the Admin manager runs setup, not the business). */
const NEVER = new Set(["admin-manager"]);

export function defaultAccessFor(capabilities: readonly Capability[]): string[] {
  return [...new Set(capabilities.flatMap((c) => DEFAULT_ACCESS[c]))];
}

export function allowedTemplate(templateKey: string): boolean {
  return !NEVER.has(templateKey) && /^[a-z0-9-]{2,40}$/.test(templateKey);
}
