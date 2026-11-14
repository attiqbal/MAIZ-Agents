// The pretend Meta login window used in test mode (see connect-social.ts). It lists what the real window would ask for,
// then sends the browser back to MAIZ with a fake code. The same code is used every time for the same device, so the same
// "person" comes back, like a real Facebook account would.
import "./styles.css";
import { initNav } from "./common";
import { esc } from "./owner-common";

initNav();
const q = new URLSearchParams(location.search);
const kind = ["facebook", "instagram"].includes(q.get("kind") ?? "") ? q.get("kind")! : "facebook";
const state = q.get("state") ?? "";
const PLAIN: Record<string, string> = {
  pages_show_list: "See which Facebook Pages you manage", pages_manage_posts: "Publish posts to your Page", pages_read_engagement: "Read likes, comments and followers",
  read_insights: "Read your Page's performance figures", instagram_basic: "See your Instagram account's name and picture", instagram_content_publish: "Publish photos to your Instagram account",
  instagram_manage_insights: "Read Instagram likes, comments and followers", business_management: "Find the Pages and accounts in your Meta business",
};
document.getElementById("sm-perms")!.innerHTML = (q.get("scope") ?? "").split(",").filter(Boolean).map((s) => `<li>${esc(PLAIN[s] ?? s)}</li>`).join("");
let seed = "device";
try { seed = localStorage.getItem("maiz.sandbox-seed") ?? Math.random().toString(36).slice(2, 10); localStorage.setItem("maiz.sandbox-seed", seed); } catch { /* private window: a new test user each time */ }
document.getElementById("sm-go")!.addEventListener("click", () => {
  location.assign(`/api/meta/callback?code=${encodeURIComponent(`sandbox-${kind}-${seed}`)}&state=${encodeURIComponent(state)}`);
});
