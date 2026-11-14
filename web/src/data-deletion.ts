// Data deletion page (data-deletion.html): the address Meta shows a person after they ask for their data to be deleted.
// ?code=... shows whether that request finished and how much was removed. Never shows names or other personal data.
import "./styles.css";
import { api } from "./api";
import { initNav } from "./common";

initNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function check(code: string): Promise<void> {
  const box = $("dd-status");
  box.hidden = false;
  const r = await api<{ found: boolean; completedAt?: string; removed?: { connections: number; posts: number } }>(`/meta/deletion-status?code=${encodeURIComponent(code)}`);
  if (r.status === 0) { $("dd-h").textContent = "We could not check just now"; $("dd-p").textContent = "Please try again in a few minutes."; return; }
  if (!r.data?.found) { $("dd-h").textContent = "We could not find that code"; $("dd-p").textContent = "Check that you typed it exactly as it was shown. If you are sure it is right, contact us using the address in our privacy policy."; return; }
  const n = r.data.removed;
  $("dd-h").textContent = "Your data has been deleted";
  $("dd-p").textContent = `Deleted on ${new Date(r.data.completedAt!).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}: ${n?.connections ?? 0} connected account${n?.connections === 1 ? "" : "s"} and ${n?.posts ?? 0} post${n?.posts === 1 ? "" : "s"}.`;
}

$("dd-form").addEventListener("submit", (e) => { e.preventDefault(); const c = $<HTMLInputElement>("dd-code").value.trim(); if (c) void check(c); });
const fromUrl = new URLSearchParams(location.search).get("code");
if (fromUrl) { $<HTMLInputElement>("dd-code").value = fromUrl; void check(fromUrl); }
