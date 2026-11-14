/**
 * What the owner can connect, and the plain-English steps for each. Pure data: the service turns it into the
 * Connections page. Screens at Meta change often, so each step says what to look for, not just where to click.
 */
export type ConnKey = "facebook" | "instagram" | "whatsapp" | "resend" | "stripe" | "runpod" | "anthropic" | "slack";

export interface FieldDef {
  key: string;
  label: string;
  help: string;
  /** A secret is stored encrypted and never sent back to the browser. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  /** The page offers to make a random value for this field. */
  generate?: boolean;
}
export interface GuideStep { text: string; link?: { href: string; label: string } }
export interface ConnDef {
  key: ConnKey;
  title: string;
  summary: string;
  group: "social" | "messaging" | "platform";
  /** True when the owner can enter the details in the browser. False: set on the server, shown here as status + test. */
  editable: boolean;
  fields: FieldDef[];
  guide: GuideStep[];
  usedBy: string[];
}

const META_APPS = { href: "https://developers.facebook.com/apps/", label: "Meta for Developers: your apps" };
const BUSINESS_SETTINGS = { href: "https://business.facebook.com/settings/", label: "Meta Business settings" };
const SYSTEM_USERS = { href: "https://business.facebook.com/settings/system-users", label: "Business settings: System users" };

export const CATALOG: readonly ConnDef[] = [
  {
    key: "facebook", title: "Facebook Page", group: "social", editable: true,
    summary: "Lets the promotion agent publish approved posts to your Facebook Page and read their likes and comments.",
    usedBy: ["promotion-agent"],
    fields: [
      { key: "accessToken", label: "Access token", secret: true, required: true, placeholder: "Starts with EAA…", help: "The long code from step 4. Also used for Instagram (and WhatsApp unless you give WhatsApp its own)." },
      { key: "pageId", label: "Facebook Page ID", secret: false, required: true, placeholder: "e.g. 105839201234567", help: "A number, not the Page's name." },
      { key: "appSecret", label: "App secret (recommended)", secret: true, required: false, placeholder: "32 letters and numbers", help: "Adds a second lock to every call. WhatsApp needs it. From your app's Settings, Basic." },
    ],
    guide: [
      { text: "Open Meta for Developers and click Create app. Choose \"Other\", then the type \"Business\". Give it any name, for example \"MAIZ Agents\". The app can stay in Development mode: it works on your own Page without any review while you are its admin.", link: META_APPS },
      { text: "In Meta Business settings, make sure your Facebook Page is listed under Accounts, then Pages. If not, add it. If you have no business portfolio yet, Meta offers to create one: do that.", link: BUSINESS_SETTINGS },
      { text: "In Business settings, go to Users, then System users, and click Add. Name it \"MAIZ agent\" and give it the role Admin. Then click Add assets, choose Pages, pick your Page and switch on Full control. If the app is not yet attached to the business, Meta asks you to add it under Accounts, then Apps.", link: SYSTEM_USERS },
      { text: "With that system user selected, click Generate new token. Choose your app, set the expiry to Never, and tick: pages_show_list, pages_manage_posts, pages_read_engagement, business_management. (For Instagram also tick instagram_basic and instagram_content_publish; for WhatsApp also whatsapp_business_messaging and whatsapp_business_management.) Copy the token and paste it into the box below. Meta shows it only once." },
      { text: "Your Page ID: open your Page on Facebook, choose About, then scroll to Page transparency and copy the number called Page ID. It is also shown in Business settings when you click the Page under Accounts, then Pages." },
      { text: "Optional but recommended: in your app, open App settings, then Basic, click Show next to App secret, and paste it into the third box." },
      { text: "Click Save, then Test connection. A green message with your Page's name means it works." },
    ],
  },
  {
    key: "instagram", title: "Instagram", group: "social", editable: true,
    summary: "Lets the promotion agent publish approved picture posts to your Instagram professional account.",
    usedBy: ["promotion-agent"],
    fields: [{ key: "instagramId", label: "Instagram account ID", secret: false, required: true, placeholder: "e.g. 17841400000000000", help: "A long number, not the @username." }],
    guide: [
      { text: "Instagram must be a Professional account (Business or Creator). In the Instagram app: Settings, then Account type and tools, then Switch to professional account." },
      { text: "Link it to your Facebook Page: on Facebook open your Page, Settings, then Linked accounts, then Instagram, and connect it." },
      { text: "In Meta Business settings, open Accounts, then Instagram accounts, add yours if it is not there, and assign it to the same system user as the Page (Full control).", link: BUSINESS_SETTINGS },
      { text: "Click the Instagram account in that list. The Instagram account ID is the number shown at the top. Paste it below." },
      { text: "Instagram uses the access token from the Facebook Page card above, so connect that first, with the Instagram permissions ticked when you generate the token (step 4 there)." },
      { text: "Click Save, then Test connection. Pictures must be public https links; Instagram cannot post text alone." },
    ],
  },
  {
    key: "whatsapp", title: "WhatsApp (your line to the agent)", group: "messaging", editable: true,
    summary: "The agent messages your own WhatsApp when something waits for approval, and you can reply APPROVE, REJECT or POST. Only your number is obeyed.",
    usedBy: ["promotion-agent", "decisions"],
    fields: [
      { key: "phoneNumberId", label: "Phone number ID", secret: false, required: true, placeholder: "e.g. 109876543210987", help: "The business number's ID from Meta, not the phone number itself." },
      { key: "ownerNumber", label: "Your own WhatsApp number", secret: false, required: true, placeholder: "+447700900123", help: "With country code. Only messages from this number are obeyed." },
      { key: "verifyToken", label: "Webhook verify token", secret: false, required: true, generate: true, help: "Any private phrase of 16+ letters and numbers. Press Make one for me, save, then paste the same value into Meta (step 7)." },
      { key: "accessToken", label: "Access token (optional)", secret: true, required: false, help: "Leave empty to use the Facebook Page token. Fill only if you made a separate token for WhatsApp." },
      { key: "appSecret", label: "App secret (optional)", secret: true, required: false, help: "Leave empty to use the one from the Facebook card. It signs the messages Meta sends us, so it is required one way or the other." },
      { key: "alertTemplate", label: "Alert template name", secret: false, required: false, placeholder: "maiz_owner_alert", help: "Only change this if you named the template differently in step 6." },
      { key: "templateLanguage", label: "Template language", secret: false, required: false, placeholder: "en_GB", help: "Must match the language you chose for the template." },
    ],
    guide: [
      { text: "Do the Facebook Page card first. It gives you the app, the system user and the access token that WhatsApp also uses (tick the two whatsapp_ permissions when you generate the token).", link: META_APPS },
      { text: "In your Meta app, click Add product and add WhatsApp. Choose your business portfolio when asked." },
      { text: "Register the business phone number. It must NOT be active on the normal WhatsApp or WhatsApp Business app (remove it from there first, or use a new SIM or a number that can receive a text or call). In your app open WhatsApp, then API Setup, and add the number. Meta sends it a code." },
      { text: "On the same API Setup screen, copy the Phone number ID (a long number, not the phone number) and paste it below." },
      { text: "Type your own WhatsApp number below with the country code, press Make one for me next to the verify token, add the access token if WhatsApp has its own, then click Save." },
      { text: "Create the message template. In WhatsApp Manager open Message templates, Create template: category Utility, name maiz_owner_alert, language English (UK), body \"MAIZ Agents: {{1}}\" with the sample \"2 waiting for your approval. Reply HELLO to read them.\" Submit it. Approval usually takes minutes to a day. The agent can only start a conversation with this template.", link: { href: "https://business.facebook.com/wa/manage/message-templates/", label: "WhatsApp Manager: message templates" } },
      { text: "Tell Meta where to send your replies. In your app open WhatsApp, then Configuration, click Edit next to Webhook, paste the Callback URL and Verify token from the box below, click Verify and save, then next to Webhook fields click Manage and switch on Subscribe for \"messages\". Save the details here first: Meta checks them straight away." },
      { text: "From your own phone, send any message (for example \"hello\") to the business number. This opens the conversation. If your app is in Development mode, also add your number under API Setup, To, Manage phone number list." },
      { text: "Click Test connection (checks the number with Meta), then Send test WhatsApp message. If the second one fails because the template is not approved yet, wait for approval and try again." },
    ],
  },
  {
    key: "resend", title: "Email sending (Resend)", group: "platform", editable: false,
    summary: "Sends sign-in links, receipts, your decisions digest and the promotion agent's approved emails.",
    usedBy: ["decisions", "promotion-agent"],
    fields: [],
    guide: [
      { text: "Create a free account and an API key (Full access or Sending access).", link: { href: "https://resend.com/api-keys", label: "Resend: API keys" } },
      { text: "Add and verify your sending domain by adding the DNS records Resend shows you.", link: { href: "https://resend.com/domains", label: "Resend: domains" } },
      { text: "The key and the From address (RESEND_API_KEY and EMAIL_FROM) are server settings. Entering them in the browser is not built yet; Test connection checks what the server has." },
    ],
  },
  {
    key: "stripe", title: "Payments (Stripe)", group: "platform", editable: false,
    summary: "Takes card payments and subscriptions from clients.",
    usedBy: [],
    fields: [],
    guide: [
      { text: "Keys and the webhook secret (PAYMENTS_PROVIDER, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) are server settings. Test connection checks that the server's key is accepted by Stripe.", link: { href: "https://dashboard.stripe.com/apikeys", label: "Stripe: API keys" } },
      { text: "The webhook endpoint in Stripe should point to your site's /api/payments/webhook.", link: { href: "https://dashboard.stripe.com/webhooks", label: "Stripe: webhooks" } },
    ],
  },
  {
    key: "runpod", title: "AI engine (RunPod)", group: "platform", editable: false,
    summary: "Does the heavy AI work for every agent, cheaply.",
    usedBy: ["promotion-agent", "community-growth-manager"],
    fields: [],
    guide: [
      { text: "Create a restricted API key and a serverless endpoint.", link: { href: "https://www.runpod.io/console/serverless", label: "RunPod: serverless" } },
      { text: "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID are server settings. Test connection asks the endpoint for its health, which costs nothing." },
    ],
  },
  {
    key: "anthropic", title: "Claude (quality checking)", group: "platform", editable: false,
    summary: "Claude checks the AI engine's work and handles the light jobs.",
    usedBy: ["promotion-agent", "community-growth-manager"],
    fields: [],
    guide: [
      { text: "Create an API key and set a monthly spend limit.", link: { href: "https://console.anthropic.com/settings/keys", label: "Anthropic Console: API keys" } },
      { text: "ANTHROPIC_API_KEY is a server setting. Test connection lists one model, which is free." },
    ],
  },
  {
    key: "slack", title: "Slack (clients' teams)", group: "platform", editable: false,
    summary: "Lets each client chat with their AI employees in Slack. This is the platform's Slack app, not yours.",
    usedBy: [],
    fields: [],
    guide: [
      { text: "Create the Slack app once for the whole platform.", link: { href: "https://api.slack.com/apps", label: "Slack: your apps" } },
      { text: "SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET and SLACK_REDIRECT_URI are server settings. There is nothing safe to test without installing it into a workspace." },
    ],
  },
] as const;

export const CONN_KEYS = CATALOG.map((c) => c.key) as ConnKey[];
export const defOf = (key: string): ConnDef | undefined => CATALOG.find((c) => c.key === key);
