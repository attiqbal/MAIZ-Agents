import type { MetaKind } from "./types.js";

/**
 * Every Meta permission MAIZ asks for, in one place. The connect screen shows the plain-English line,
 * the owner's status page tracks approval per permission, and docs/META-APP-REVIEW.md is generated from
 * this list (npm run docs:meta), so what clients are told, what we submit to Meta and what the code asks for cannot drift apart.
 */
export interface MetaPermission {
  key: string;
  /** What the client reads before approving, no jargon. */
  plain: string;
  /** Which connection needs it. */
  kinds: MetaKind[];
  /** Meta's review form: how this permission is used and why the product cannot work without it. */
  justification: string;
  /** Screencast steps for the review reviewer, in order. */
  screencast: string[];
  /** Needs App Review (advanced access). Basic list permissions are reviewed together with the others. */
  review: boolean;
}

const SIGNIN = "Open the MAIZ Agents sign-in page, sign in as the test user, and open Social accounts (Connect your accounts).";

export const META_PERMISSIONS: readonly MetaPermission[] = [
  {
    key: "pages_show_list", plain: "See which Facebook Pages you manage, so you can choose the right one.", kinds: ["facebook", "instagram"], review: true,
    justification: "After the business owner logs in with Facebook Login for Business, MAIZ calls /me/accounts to list the Pages they manage so they can choose which single Page their AI marketing employee may work on. Without it the owner cannot select a Page.",
    screencast: [SIGNIN, "Press Connect Facebook Page.", "Approve the Facebook dialog; the permission list is shown on screen.", "Back in MAIZ, the list of the Pages this person manages appears. Choose one and press Use this Page.", "The connected Page appears with its name and the plain-English list of what MAIZ can do."],
  },
  {
    key: "pages_manage_posts", plain: "Publish posts to your Facebook Page, only after you approve each one.", kinds: ["facebook"], review: true,
    justification: "The client's AI marketing employee drafts posts. Each draft waits for the business owner to approve it in MAIZ (or by WhatsApp). Only an approved post is published to the owner's own Page through /{page-id}/feed or /photos, immediately or at the time the owner chose. MAIZ never posts without that approval and never posts to a Page the owner did not select.",
    screencast: [SIGNIN, "Show the connected Facebook Page.", "Open Posts, write a post (or ask the marketing employee for a draft) and press Send for approval.", "Show that the post is Awaiting your approval and nothing has appeared on the Page yet.", "Press Approve and post now.", "Open the Page on Facebook in a second tab and show the published post, then return to MAIZ and show the link to it."],
  },
  {
    key: "pages_read_engagement", plain: "Read likes, comments and followers on your Page's posts, so we can show how they did.", kinds: ["facebook"], review: true,
    justification: "MAIZ reads reactions, comment counts and shares for the posts it published, and the Page's follower count, to show the owner how each post performed and to tell the marketing employee what worked. MAIZ does not read or store the content of comments or messages from the public.",
    screencast: [SIGNIN, "Open Posts and a post that has been published.", "Press Refresh results.", "Show the likes, comments, shares and followers figures, matching the numbers on the Facebook post."],
  },
  {
    key: "read_insights", plain: "Read your Page's performance figures (reach and followers).", kinds: ["facebook"], review: true,
    justification: "Shown to the business owner in the Results view of the MAIZ dashboard: reach and follower figures for their own Page, used to report on the marketing employee's work.",
    screencast: [SIGNIN, "Open Results.", "Show the Page reach and follower figures with the date range, and the matching Page Insights in Facebook."],
  },
  {
    key: "instagram_basic", plain: "See your Instagram professional account's name and picture.", kinds: ["instagram"], review: true,
    justification: "Identifies the Instagram professional account linked to the Page the owner selected, so the owner can confirm it is the right one before connecting.",
    screencast: [SIGNIN, "Press Connect Instagram.", "Approve the dialog.", "Show the Instagram account name that MAIZ found linked to the Page; choose it and press Use this account."],
  },
  {
    key: "instagram_content_publish", plain: "Publish photos to your Instagram account, only after you approve each one.", kinds: ["instagram"], review: true,
    justification: "Same approval gate as Facebook: the AI marketing employee drafts an Instagram post with a picture and caption, the owner approves it in MAIZ, and only then is it published with /{ig-user-id}/media and /media_publish to the owner's own account.",
    screencast: [SIGNIN, "Show the connected Instagram account.", "Open Posts, choose Instagram, add a picture link and caption, press Send for approval.", "Show it is waiting and nothing is on Instagram.", "Press Approve and post now.", "Open the Instagram account in a second tab and show the published post."],
  },
  {
    key: "instagram_manage_insights", plain: "Read likes, comments and followers on your Instagram posts.", kinds: ["instagram"], review: true,
    justification: "Shows the owner how each post MAIZ published performed and the account's follower count, in the Results view.",
    screencast: [SIGNIN, "Open Results and an Instagram post.", "Press Refresh results.", "Show likes, comments and followers matching Instagram."],
  },
  {
    key: "business_management", plain: "Find the Pages and WhatsApp accounts that belong to your Meta business.", kinds: ["facebook", "instagram", "whatsapp"], review: true,
    justification: "Many owners keep their Page and WhatsApp account inside a Meta Business portfolio. This permission lets MAIZ list the assets in the owner's own portfolio so they can choose which ones to connect. MAIZ does not create or change business assets.",
    screencast: [SIGNIN, "Press Connect Facebook Page for an account whose Page is inside a business portfolio.", "Show that the Page appears in the list and can be chosen."],
  },
  {
    key: "whatsapp_business_management", plain: "See your WhatsApp Business account and phone number.", kinds: ["whatsapp"], review: true,
    justification: "Used after WhatsApp Embedded Signup to read the owner's WhatsApp Business account and phone number, so MAIZ can show which number is connected and register message templates for approval reminders.",
    screencast: [SIGNIN, "Press Connect WhatsApp.", "Complete the Embedded Signup window with the test business number.", "Show the connected number and business name in MAIZ."],
  },
  {
    key: "whatsapp_business_messaging", plain: "Send you messages on WhatsApp and read your replies, so you can approve posts from your phone.", kinds: ["whatsapp"], review: true,
    justification: "MAIZ sends the business owner a WhatsApp message when a post is waiting for approval, and reads the owner's reply (Yes or No) to approve or skip it. It messages only the approver number the owner entered and confirmed, never customers or third parties, and only inside WhatsApp's rules (replies inside 24 hours, an approved template otherwise).",
    screencast: [SIGNIN, "Show the connected WhatsApp number and the confirmed approver number.", "Create a post and send it for approval.", "Show the WhatsApp message arriving on the approver's phone.", "Reply Yes on the phone.", "Show in MAIZ that the post was approved by WhatsApp and published."],
  },
];

export const META_PERMISSION_KEYS = META_PERMISSIONS.map((p) => p.key);

/** The permissions requested for one connection type. */
export const permissionsFor = (kind: MetaKind): MetaPermission[] => META_PERMISSIONS.filter((p) => p.kinds.includes(kind));
/** Comma-separated scope string for the OAuth dialog when no Facebook Login for Business configuration is used. */
export const scopeParam = (kind: MetaKind): string => permissionsFor(kind).map((p) => p.key).join(",");
