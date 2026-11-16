// Alerts on this device: a real push notification when work is done, even when MAIZ is closed.
// The browser asks the person first; nothing is sent until they say yes, and one tap turns it off again.
import { api, getToken } from "./api";

export type PushState = "unsupported" | "blocked" | "off" | "on";

const SW_PATH = "/sw.js";
const supported = (): boolean => "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
/** iPhone and iPad only allow alerts for a site that was added to the Home Screen. */
const needsHomeScreen = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

let known: PushState | undefined;
/** True once this device is known to be getting real pushes, so the page does not also pop up its own notice. */
export const pushIsOn = (): boolean => known === "on";

export async function pushState(): Promise<PushState> {
  try {
    if (!supported()) known = "unsupported";
    else if (Notification.permission === "denied") known = "blocked";
    else known = Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
  } catch { known = "unsupported"; }
  return known;
}

async function subscribe(): Promise<boolean> {
  const k = await api<{ publicKey?: string }>("/push");
  if (!k.ok || !k.data?.publicKey) return false;
  const key = keyBytes(k.data.publicKey);
  const reg = await navigator.serviceWorker.register(SW_PATH);
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for an older server key can no longer be sent to: replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const saved = await api("/push/subscribe", { body: { subscription: sub.toJSON() } });
  if (!saved.ok) { await sub.unsubscribe(); return false; }
  return true;
}

export async function turnOnPush(): Promise<{ ok: boolean; message: string }> {
  if (!supported()) return { ok: false, message: needsHomeScreen() ? "On iPhone or iPad, add MAIZ to your Home Screen first (Share, then Add to Home Screen), then open it from there." : "This browser cannot show alerts." };
  try {
    if ((await Notification.requestPermission()) !== "granted") { await pushState(); return { ok: false, message: "Alerts stay off. You can allow them in your browser settings." }; }
    const ok = await subscribe();
    await pushState();
    return ok ? { ok: true, message: "Alerts are on for this device" } : { ok: false, message: "Could not turn alerts on just now. Please try again." };
  } catch {
    await pushState();
    return { ok: false, message: "Could not turn alerts on just now. Please try again." };
  }
}

export async function turnOffPush(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api("/push/unsubscribe", { body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
  } catch { /* already gone */ }
  await pushState();
}

/** Keeps the server's copy in step when alerts are already on (a browser can renew its address at any time). */
export async function syncPush(): Promise<void> {
  if (!getToken() || (await pushState()) !== "on") return;
  try { await subscribe(); } catch { /* tried again on the next visit */ }
}

function controlsHtml(state: PushState): string {
  if (state === "on") return '<p class="small muted push-line">Alerts are on for this device, even when MAIZ is closed.</p><p class="push-acts"><button type="button" class="btn btn-sm btn-ghost" data-push="test">Send a test alert</button><button type="button" class="btn btn-sm btn-ghost" data-push="off">Turn off</button></p>';
  if (state === "blocked") return '<p class="small muted push-line">Alerts are blocked for this site. You can allow them in your browser settings.</p>';
  if (state === "unsupported") return needsHomeScreen() ? '<p class="small muted push-line">To get alerts on iPhone or iPad, add MAIZ to your Home Screen (Share, then Add to Home Screen) and open it from there.</p>' : "";
  return '<p class="push-acts"><button type="button" class="btn btn-sm btn-ghost" data-push="on">Alert me on this device</button></p>';
}

/**
 * Puts the alert controls into `el` and keeps them current. `say` shows a short result (a toast or a status line).
 * Safe to mount in more than one place: each copy repaints after its own action.
 */
export function mountPushControls(el: HTMLElement, say: (message: string) => void): void {
  const paint = async (): Promise<void> => { el.innerHTML = controlsHtml(await pushState()); };
  el.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-push]");
    if (!b || b.disabled) return;
    b.disabled = true;
    if (b.dataset.push === "on") say((await turnOnPush()).message);
    else if (b.dataset.push === "off") { await turnOffPush(); say("Alerts are off for this device"); }
    else {
      const r = await api<{ sent?: number }>("/push/test", { body: {} });
      say(r.ok && r.data?.sent ? "Test alert sent. It should arrive in a few seconds." : "The test could not be sent. Turn alerts off and on again.");
    }
    await paint();
  });
  void paint();
}
