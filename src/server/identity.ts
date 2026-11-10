import { createHash } from "node:crypto";

/** Stable user id for a sign-in email. Sessions carry it, and platform owners are matched by it. */
export const userIdFor = (email: string): string => `u_${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
