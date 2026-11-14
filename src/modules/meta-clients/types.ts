export type MetaKind = "facebook" | "instagram" | "whatsapp";
export type MetaMode = "sandbox" | "live";
export type ConnectionStatus = "connected" | "needs_reconnect" | "disconnected";

/** One thing a client connected: a Page, an Instagram account or a WhatsApp number. Holds no secret. */
export interface MetaConnection {
  id: string;
  workspaceId: string;
  kind: MetaKind;
  externalId: string;
  name: string;
  handle?: string;
  scopes: string[];
  status: ConnectionStatus;
  /** sandbox = simulated end to end, nothing reaches Meta. */
  mode: MetaMode;
  /** The person's app-scoped Meta user id, which is how Meta's deauthorize and deletion calls find them. */
  metaUserId?: string;
  connectedBy: string;
  connectedAt: string;
  expiresAt?: string;
  lastCheckedAt?: string;
  lastError?: string;
  /** Instagram only: the Page it hangs off. */
  pageId?: string;
  /** WhatsApp only. */
  wabaId?: string;
  phoneNumberId?: string;
  displayNumber?: string;
  /** WhatsApp only: the owner's own number that may approve posts, and whether they have proved it is theirs. */
  approverNumber?: string;
  approverConfirmed?: boolean;
  /** Last time the approver wrote to us (WhatsApp lets free text only within 24 hours of that). */
  lastInboundAt?: string;
  /** Do not call Meta for this connection before this time (it told us to slow down). */
  pausedUntil?: string;
}

export interface MetaSecret { accessToken: string; expiresAt?: string }

/** An account found during login that the client can choose. Carries the token only inside the server. */
export interface FoundAsset {
  kind: MetaKind;
  externalId: string;
  name: string;
  handle?: string;
  accessToken: string;
  expiresAt?: string;
  pageId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayNumber?: string;
}

export interface ExchangeResult { metaUserId: string; scopes: string[]; assets: FoundAsset[] }

export interface PostInput { text: string; imageUrl?: string; linkUrl?: string }
export interface Published { id: string; url: string; simulated: boolean }
export interface PostResults { likes: number; comments: number; shares?: number; fetchedAt: string }
export interface AccountInsights { followers: number; reach?: number; fetchedAt: string }

export type MetaPostStatus = "awaiting_approval" | "approved" | "publishing" | "retry_wait" | "posted" | "rejected" | "failed" | "cancelled";

/** A client's post. The approval gate: nothing leaves "awaiting_approval" except by a person's decision. */
export interface MetaPost {
  id: string;
  workspaceId: string;
  connectionId: string;
  kind: "facebook" | "instagram";
  text: string;
  imageUrl?: string;
  linkUrl?: string;
  /** Short code the approver types in WhatsApp (Yes K7P2). */
  code: string;
  status: MetaPostStatus;
  createdAt: string;
  createdBy: string;
  /** Who decided and how: a dashboard user or the confirmed WhatsApp approver. */
  decidedBy?: string;
  decidedVia?: "dashboard" | "whatsapp";
  decidedAt?: string;
  /** When to publish. Empty = as soon as approved. */
  scheduledFor?: string;
  attempts: number;
  retryAt?: string;
  externalId?: string;
  url?: string;
  simulated?: boolean;
  postedAt?: string;
  error?: string;
  results?: PostResults;
}

/** Per-client limits. Defaults are deliberately gentle; the platform owner can change them per client. */
export interface ClientLimits { postsPerDay: number; postsPerMonth: number; maxWaiting: number }
export const DEFAULT_LIMITS: ClientLimits = { postsPerDay: 3, postsPerMonth: 60, maxWaiting: 20 };
/** Hard ceilings the owner cannot raise past, from Meta's own publishing limits (Instagram 100 per 24 hours via API, we keep far below). */
export const LIMIT_CEILING: ClientLimits = { postsPerDay: 25, postsPerMonth: 600, maxWaiting: 100 };

export type ReviewState = "not_submitted" | "in_review" | "approved" | "rejected";
export interface PermissionStatus { key: string; state: ReviewState; note?: string; updatedAt: string }

export interface DeletionRecord { code: string; at: string; via: "meta_callback" | "client"; removed: { connections: number; posts: number }; metaUserId?: string; workspaceId?: string }

export class MetaClientError extends Error {}
