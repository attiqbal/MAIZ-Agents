import type { Capability } from "./types.js";

/**
 * Least privilege: which employees get which kind of app data when the owner connects an app.
 * The owner can widen or narrow this per connection. Unknown employees get nothing.
 * Payroll is personal data, so only the employees whose job needs it see it by default.
 */
export const DEFAULT_ACCESS: Record<Capability, readonly string[]> = {
  "sales.read": ["finance-manager", "business-consultant", "marketing-manager", "compliance-manager", "online-shop-manager", "marketplace-manager", "dropshipping-agent", "shop-care-agent"],
  "payroll.read": ["finance-manager", "hr-manager", "compliance-manager"],
  "accounts.read": ["finance-manager", "business-consultant", "compliance-manager"],
  "traffic.read": ["marketing-manager", "business-consultant", "online-shop-manager"],
  "search.read": ["marketing-manager", "business-consultant", "online-shop-manager"],
  // Customer-facing areas (see areas.ts): counts only, never the content of a message or a ticket.
  "crm.read": ["marketing-manager", "business-consultant"],
  "support.read": ["business-consultant", "marketing-manager", "shop-care-agent", "online-shop-manager"],
  "inbox.read": ["business-consultant"],
  "bookings.read": ["business-consultant", "marketing-manager"],
  "audience.read": ["marketing-manager", "business-consultant", "online-shop-manager"],
  "tasks.read": ["business-consultant", "supply-chain-manager"],
  "reviews.read": ["marketing-manager", "business-consultant", "online-shop-manager", "marketplace-manager", "shop-care-agent"],
  // Supplier orders and stock (Printful, Printify): counts only, for the online-shop team.
  "suppliers.read": ["dropshipping-agent", "online-shop-manager", "business-consultant"],
  "social.read": ["marketing-manager", "business-consultant"],
  "ads.read": ["marketing-manager", "business-consultant", "finance-manager"],
  "documents.read": ["business-consultant", "compliance-manager"],
};

/** Employees that may never be given app data (the Admin manager runs setup, not the business). */
const NEVER = new Set(["admin-manager"]);

export function defaultAccessFor(capabilities: readonly Capability[]): string[] {
  return [...new Set(capabilities.flatMap((c) => DEFAULT_ACCESS[c]))];
}

export function allowedTemplate(templateKey: string): boolean {
  return !NEVER.has(templateKey) && /^[a-z0-9-]{2,40}$/.test(templateKey);
}
