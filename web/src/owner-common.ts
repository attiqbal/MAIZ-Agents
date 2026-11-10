// Shared by the platform owner's pages (quality review, new specialists, clients, prices): the owner
// menu and loading data with the same answers for "not logged in", "not the owner" and "no API".
import { api, getToken, type ApiResult } from "./api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const gbp = (n: number): string => `£${n.toLocaleString("en-GB", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Marks the current page in the owner menu. */
export function initOwnerNav(): void {
  document.querySelectorAll<HTMLAnchorElement>(".owner-nav a").forEach((a) => {
    if (new URL(a.href).pathname === location.pathname) a.setAttribute("aria-current", "page");
  });
}

/** Replaces the page body with a message (log in, wrong account, failed load). */
export function gate(h: string, p: string, link?: [string, string]): void {
  $("ow-body").hidden = true;
  $("ow-gate").hidden = false;
  $("ow-gate-h").textContent = h;
  $("ow-gate-p").textContent = p;
  const a = $<HTMLAnchorElement>("ow-gate-a");
  if (link) { a.href = link[0]; a.textContent = link[1]; } else a.hidden = true;
}

/**
 * Loads owner data. Returns the data, "demo" when no API is reachable (the page then shows
 * labelled examples), or undefined after showing the right message for every other answer.
 */
export async function ownerLoad<T>(path: string): Promise<T | "demo" | undefined> {
  if (!getToken()) {
    const health = await api("/health");
    if (health.status === 0) return "demo";
    gate("Log in as the platform owner", "This page is for the MAIZ platform owner. Log in with your owner email.", ["/signin.html", "Log in"]);
    return undefined;
  }
  const r: ApiResult<T> = await api<T>(path);
  if (r.ok && r.data) return r.data;
  if (r.status === 0) return "demo";
  if (r.status === 401) gate("Log in as the platform owner", "Your login has ended. Log in again with your owner email.", ["/signin.html", "Log in"]);
  else if (r.status === 403) gate("This page is for the MAIZ platform owner", "Your own team, tasks and specialists are in your control center.", ["/app.html", "Open your control center"]);
  else gate("This page did not load", "Nothing was changed. Reload the page to try again.", [location.pathname, "Reload"]);
  return undefined;
}

/** Shows the "Example data" badge used when no API is reachable. */
export const markDemo = (): void => { $("ow-eg").hidden = false; };
