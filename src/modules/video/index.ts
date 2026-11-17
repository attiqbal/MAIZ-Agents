import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { IdentityService } from "../identity/index.js";
import type { PaidQuote, PaidUse, Payer } from "../paid-services/index.js";

/**
 * The client side of video: a business makes a short video from a template it designed at Creatomate or Shotstack, with
 * its own brand details filled in. This is a thin layer over the paid-services module, which still does the quote, the
 * confirm step, the double-energy rule and the energy charge. Nothing here talks to a video service directly.
 *
 * Nothing is published for the client. A finished video waits as "ready" until someone who may approve work (owner or
 * admin) approves or rejects it. Approval only marks it good to use; the client downloads or posts it themselves.
 */
export class VideoError extends Error {}

export type VideoStatus = "rendering" | "ready" | "failed" | "approved" | "rejected";
export type BrandSlot = "name" | "colour" | "logo" | "tagline";

export interface Brand { name?: string; colour?: string; logoUrl?: string; tagline?: string }
export interface VideoDraft {
  id: string;
  workspaceId: string;
  employeeId: string;
  title: string;
  service: string;
  templateId: string;
  /** The slots as sent to the service, after brand details were filled in. Never holds a key. */
  fields: Record<string, string>;
  useId: string;
  status: VideoStatus;
  url?: string;
  /** Energy charged (0 for a practice render). */
  energy: number;
  /** A practice render: no service ran, nothing was spent, and the link is a placeholder. */
  simulated: boolean;
  createdAt: string;
  decidedAt?: string;
  note?: string;
}
interface Stored { workspaceId: string; brand: Brand; drafts: VideoDraft[] }

export interface VideoDeps {
  paid: {
    quote(service: string): PaidQuote & { simulated: boolean; charge: number };
    render(payer: Payer, service: string, input: unknown, confirm: unknown): Promise<PaidUse>;
    status(payer: Payer, useId: string): Promise<PaidUse>;
  };
  /** Told when a finished video is approved or rejected, so the team learns what the client likes. */
  onDecision?: (ws: string, draft: VideoDraft, approved: boolean, userId: string) => void;
  /** The employee must belong to this business. */
  employeeOk: (userId: string, ws: string, employeeId: string) => boolean;
}

const MAX_DRAFTS = 60;
const HEX = /^#[0-9a-f]{6}$/i;
const SLOT_FROM: Record<BrandSlot, (b: Brand) => string | undefined> = { name: (b) => b.name, colour: (b) => b.colour, logo: (b) => b.logoUrl, tagline: (b) => b.tagline };
const BRAND_LABEL: Record<BrandSlot, string> = { name: "business name", colour: "brand colour", logo: "logo", tagline: "tagline" };
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function cleanBrand(raw: unknown): Brand {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Brand = {};
  const name = text(r.name, 80); if (name) out.name = name;
  const tagline = text(r.tagline, 120); if (tagline) out.tagline = tagline;
  const colour = text(r.colour, 7);
  if (colour) { if (!HEX.test(colour)) throw new VideoError("the brand colour is a code like #1f7a3d"); out.colour = colour.toLowerCase(); }
  const logo = text(r.logoUrl, 300);
  if (logo) {
    // The rendering service fetches the logo, never our server, so it must be a public https address.
    if (!/^https:\/\/[^\s/]+\/\S*$/i.test(logo)) throw new VideoError("the logo must be a public https address that ends in a file name");
    out.logoUrl = logo;
  }
  return out;
}

export class VideoStudio {
  private byWorkspace = new Map<string, Stored>();
  private sink?: Sink;

  constructor(private identity: IdentityService, private deps: VideoDeps, private now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(s: Stored): void { this.byWorkspace.set(s.workspaceId, s); }

  private get(ws: string): Stored { return this.byWorkspace.get(ws) ?? { workspaceId: ws, brand: {}, drafts: [] }; }
  private save(s: Stored): void { this.byWorkspace.set(s.workspaceId, s); this.sink?.record(s.workspaceId, "video", s.workspaceId, s); }
  private patch(ws: string, id: string, change: Partial<VideoDraft>): VideoDraft {
    const cur = this.get(ws);
    const next = cur.drafts.map((d) => (d.id === id ? { ...d, ...change } : d));
    this.save({ ...cur, drafts: next });
    return next.find((d) => d.id === id)!;
  }

  view(userId: string, ws: string) {
    this.identity.require(userId, ws, "task.read");
    const s = this.get(ws);
    return { brand: s.brand, videos: [...s.drafts].reverse() };
  }

  setBrand(userId: string, ws: string, raw: unknown): Brand {
    this.identity.require(userId, ws, "task.create");
    const brand = cleanBrand(raw);
    this.save({ ...this.get(ws), brand });
    return brand;
  }

  /** What one video would cost right now: shown before anything is made. */
  quote(userId: string, ws: string, service: string) {
    this.identity.require(userId, ws, "task.read");
    return this.deps.paid.quote(service);
  }

  /**
   * Makes a video. `brandSlots` maps a slot name in the template to a brand detail ("Title": "name"), so the client's own
   * business name, colour, logo and tagline are filled in without retyping. `confirmEnergy` must equal the quote's charge.
   */
  async create(userId: string, ws: string, input: Record<string, unknown>): Promise<VideoDraft> {
    this.identity.require(userId, ws, "task.create");
    const employeeId = text(input.employeeId, 80);
    if (!this.deps.employeeOk(userId, ws, employeeId)) throw new VideoError("pick one of your employees");
    const title = text(input.title, 80) || "Untitled video";
    const service = text(input.service, 40);
    const stored = this.get(ws);
    const fields: Record<string, string> = {};
    const own = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? (input.fields as Record<string, unknown>) : {};
    for (const [slot, value] of Object.entries(own)) fields[slot] = String(value ?? "");
    const mapped = input.brandSlots && typeof input.brandSlots === "object" && !Array.isArray(input.brandSlots) ? (input.brandSlots as Record<string, unknown>) : {};
    for (const [slot, what] of Object.entries(mapped)) {
      const pick = SLOT_FROM[what as BrandSlot];
      if (!pick) throw new VideoError(`"${String(what).slice(0, 20)}" is not a brand detail you can use`);
      const v = pick(stored.brand);
      if (!v) throw new VideoError(`you have not saved a ${BRAND_LABEL[what as BrandSlot]} yet. Add it under Your brand first`);
      fields[slot] = v;
    }
    const use = await this.deps.paid.render({ kind: "client", workspaceId: ws, employeeId }, service, { templateId: input.templateId, fields }, input.confirmEnergy);
    const draft: VideoDraft = {
      id: newId("video"), workspaceId: ws, employeeId, title, service, templateId: String(input.templateId).trim(), fields, useId: use.id,
      status: use.render.status === "done" ? "ready" : "rendering", ...(use.render.url ? { url: use.render.url } : {}),
      energy: use.energy, simulated: use.simulated, createdAt: this.now().toISOString(),
    };
    const cur = this.get(ws);
    this.save({ ...cur, drafts: [...cur.drafts, draft].slice(-MAX_DRAFTS) });
    return draft;
  }

  private find(ws: string, id: string): VideoDraft {
    const d = this.get(ws).drafts.find((x) => x.id === id);
    if (!d) throw new VideoError("that video was not found");
    return d;
  }

  /** Asks the service whether a video still rendering is done. Free: it reads, it does not render. */
  async refresh(userId: string, ws: string, id: string): Promise<VideoDraft> {
    this.identity.require(userId, ws, "task.read");
    const d = this.find(ws, id);
    if (d.status !== "rendering") return d;
    try {
      const use = await this.deps.paid.status({ kind: "client", workspaceId: ws, employeeId: d.employeeId }, d.useId);
      return use.render.status === "done" ? this.patch(ws, id, { status: "ready", ...(use.render.url ? { url: use.render.url } : {}) }) : d;
    } catch {
      // The record of a started render is kept in memory only, so after a restart it cannot be checked from here.
      return d;
    }
  }

  /** Approving needs the right to decide (owner or admin). A video must be ready first. Nothing is posted anywhere. */
  decide(userId: string, ws: string, id: string, approve: boolean, note?: unknown): VideoDraft {
    this.identity.require(userId, ws, "approval.decide");
    const d = this.find(ws, id);
    if (d.status !== "ready") throw new VideoError(d.status === "rendering" ? "the video is still being made" : "this video has already been decided");
    const done = this.patch(ws, id, { status: approve ? "approved" : "rejected", decidedAt: this.now().toISOString(), ...(text(note, 200) ? { note: text(note, 200) } : {}) });
    this.deps.onDecision?.(ws, done, approve, userId);
    return done;
  }

  /** Removes the video from the list. The file stays at the video service until you delete it there. */
  remove(userId: string, ws: string, id: string): void {
    this.identity.require(userId, ws, "task.create");
    this.find(ws, id);
    const cur = this.get(ws);
    this.save({ ...cur, drafts: cur.drafts.filter((d) => d.id !== id) });
  }
}
