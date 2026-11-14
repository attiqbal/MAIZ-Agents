// The unsubscribe page behind every promotion email. The secret in the link (in the URL fragment, so it never
// reaches server logs) is the only thing needed. It asks first, so a mail scanner opening the link cannot unsubscribe anyone.
import "./styles.css";
import { api } from "./api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";

$("un-go").addEventListener("click", async () => {
  const msg = $("un-msg");
  if (!token) { msg.textContent = "This link is not complete. Open the link from the email again."; return; }
  const r = await api("/promoter/unsubscribe", { body: { token } });
  if (r.ok) {
    $("un-p").textContent = "Done. You will not get any more emails from us at this address.";
    $("un-go").hidden = true;
    msg.textContent = "";
  } else {
    msg.textContent = r.status === 404 ? "This link is not valid any more. You may already be unsubscribed." : "Something went wrong. Please try again in a minute.";
  }
});
