// Thin client for the MAIZ Agents API. Every call fails soft: when the API is not running,
// the pages keep working as a demo.
const TOKEN_KEY = "maiz.token";

/** One-time move of browser keys saved under the old "vn." prefix, so people stay signed in after the rename. */
(function migrateOldKeys(): void {
  try {
    for (const name of ["token", "profile", "setup", "obStep"]) {
      const old = localStorage.getItem("vn." + name);
      if (old === null) continue;
      if (localStorage.getItem("maiz." + name) === null) localStorage.setItem("maiz." + name, old);
      localStorage.removeItem("vn." + name);
    }
  } catch { /* storage blocked: nothing to move */ }
})();
export const getToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string): void => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } };

/** Forget this device's login. The business profile typed during onboarding stays, so a returning visitor is not asked twice. */
export function clearSession(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export interface ApiResult<T> { ok: boolean; status: number; data?: T }

/**
 * `auth: "required"` pages call this with an expired or missing login and are sent to the log-in page.
 * A failed network call returns status 0, which pages treat as "demo mode".
 */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const token = getToken();
    const res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    // The server renews an active login (sliding 7 days, up to 30 days after the last email link).
    const fresh = res.headers.get("x-session-token");
    if (fresh && token) setToken(fresh);
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : undefined;
    // A 401 on a call that carried a login means the session ended.
    if (res.status === 401 && token) onSessionEnded();
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0 };
  }
}

let ended = false;
function onSessionEnded(): void {
  if (ended) return;
  ended = true;
  clearSession();
  if (location.pathname.startsWith("/app")) location.replace("/signin.html");
}

export interface Org {
  id: string;
  name: string;
  trialEndsAt?: string;
  dailyQuotaPerEmployee: number;
  /** The team's shared energy pool; null on older plans that still have a per-employee daily amount. */
  teamEnergy: { pool: number; used: number; left: number; percentUsed: number; topUpLeft: number; leftToday: number; dailyCeiling: number | null; refillsAt: string | null } | null;
  team: { id: string; templateKey: string; name: string; energyLeft: number }[];
}
