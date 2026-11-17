import { tool, type ToolKey } from "./catalogue.js";

/**
 * Least privilege for the platform's outside services: only the employees whose job needs a tool may be the one
 * using it, and the Admin manager (who runs setup, not the business) never is. A client's own custom specialist may
 * use the research tools, since research is what specialists are hired for, but not the paid voice.
 */
const NEVER = new Set(["admin-manager"]);
const CUSTOM_MAY: readonly ToolKey[] = ["web-search", "page-reader", "stock-pexels", "stock-unsplash"];

export function mayUse(key: ToolKey, templateKey: string): boolean {
  if (NEVER.has(templateKey)) return false;
  if (/^custom-[\w-]{1,60}$/.test(templateKey)) return CUSTOM_MAY.includes(key);
  return !!tool(key)?.employees.includes(templateKey);
}
