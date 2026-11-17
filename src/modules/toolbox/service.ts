import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { EnergyMeter } from "../energy/index.js";
import type { IdentityService } from "../identity/index.js";
import { DEFAULT_PAID_MULTIPLIER } from "../paid-services/catalogue.js";
import { mayUse } from "./access.js";
import { TOOLS, VOICE_MAX_CHARS, VOICE_MIN_CHARS, tool, toolQuote, type ToolDef, type ToolKey, type ToolQuote } from "./catalogue.js";
import { readPage, type PageText } from "./page-reader.js";
import { ToolError, braveSearch, elevenSpeak, elevenVoices, pexelsSearch, unsplashSearch, unsplashUsed, type SearchResult, type StockItem, type StockKind, type Voice } from "./providers.js";

/** Anything the client did wrong or cannot do yet, in words they can act on. With `quote` set the request was fine but not yet confirmed. */
export class ToolboxError extends Error {
  constructor(message: string, readonly quote?: ToolQuote & { charge: number }) { super(message); }
}

export interface ToolKeys { elevenlabs?: string; braveSearch?: string; pexels?: string; unsplash?: string }

export interface ToolboxOptions {
  identity: Pick<IdentityService, "require">;
  meter: Pick<EnergyMeter, "canAfford" | "holdPaid" | "settlePaid" | "releasePaid">;
  /** The client's employees. Must throw when the person is not a member. */
  team: (userId: string, workspaceId: string) => readonly { id: string; templateKey: string }[];
  multiplier: () => number;
  /** The platform's keys, read each time so a key typed on the Connections page works at once. */
  keys: () => ToolKeys;
  audit?: Pick<AuditLog, "record">;
  http?: typeof fetch;
  now?: () => Date;
}

/** A kept file: a recording, or a picture or clip the employee chose, with its credit line. Recordings hold their audio. */
export interface ToolFile {
  id: string;
  workspaceId: string;
  kind: "voice" | "stock";
  name: string;
  createdAt: string;
  employeeId: string;
  /** voice: the audio as base64 (mp3). */
  audio?: string;
  /** voice: the size of the audio in bytes. */
  bytes?: number;
  /** stock: where it is, who to credit, and the licence. */
  stock?: Pick<StockItem, "id" | "provider" | "kind" | "pageUrl" | "fileUrl" | "credit" | "creditUrl" | "licence" | "description">;
}
export type ToolFileHeader = Omit<ToolFile, "audio">;

export const MAX_VOICE_FILES = 20;
export const MAX_STOCK_FILES = 100;
const VOICES_TTL_MS = 3_600_000;
const QUERY_MAX = 200;

const REASONS: Record<string, string> = {
  weekly_pool_used: "there is not enough energy left this week. Top up, or wait for Monday's refill",
  daily_ceiling_reached: "the team has reached today's safety limit. Try again tomorrow",
  daily_quota_used: "this employee has used its energy for today",
  overtime_cap_reached: "this month's extra energy is used up",
  monthly_cost_cap_reached: "this month's limit has been reached. Please contact MAIZ",
  trial_ended: "the free trial has ended",
  plan_ended: "the plan has ended",
};

/** What a search or recording needs: a short plain sentence, no control characters. */
export function cleanQuery(raw: unknown, what: string): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (s.length < 2) throw new ToolboxError(`say what to look for: ${what}`);
  if (s.length > QUERY_MAX) throw new ToolboxError(`that is too long: keep ${what} under ${QUERY_MAX} characters`);
  return s;
}

/**
 * The platform's outside services for clients' employees (voice, web search, page reading, free stock pictures).
 * Free ones run at once. Paid ones follow the same rule as video rendering: the cost is shown first, the caller must send
 * back the exact figure, the energy is set aside before the provider is called and kept only when it answered.
 * Each tool has a daily ceiling for the whole platform and one per client, counted when a request starts.
 */
export class ToolboxService {
  private files = new Map<string, ToolFile[]>();
  private sink?: Sink;
  private counts = new Map<string, { day: string; n: number }>();
  private busy = new Set<string>();
  private voiceList?: { at: number; voices: Voice[] };

  constructor(private readonly opts: ToolboxOptions) {}

  useSink(sink: Sink): void { this.sink = sink; }
  private get http(): typeof fetch { return this.opts.http ?? fetch; }
  private now(): Date { return this.opts.now?.() ?? new Date(); }
  private mine(ws: string): readonly ToolFile[] { return this.files.get(ws) ?? []; }

  restore(data: unknown): void {
    const d = data as (Partial<ToolFile> & { removed?: boolean }) | undefined;
    if (!d || d.removed || typeof d.id !== "string" || typeof d.workspaceId !== "string" || (d.kind !== "voice" && d.kind !== "stock")) return;
    const f = d as ToolFile;
    this.files.set(f.workspaceId, [...this.mine(f.workspaceId).filter((x) => x.id !== f.id), f].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  private connected(t: ToolDef): boolean {
    const k = this.opts.keys();
    switch (t.connection) {
      case "elevenlabs": return !!k.elevenlabs;
      case "brave-search": return !!k.braveSearch;
      case "pexels": return !!k.pexels;
      case "unsplash": return !!k.unsplash;
      default: return true;
    }
  }

  quote(key: ToolKey, units = 1): ToolQuote & { charge: number } {
    const t = tool(key);
    if (!t) throw new ToolboxError("that tool does not exist");
    const q = toolQuote(t, this.opts.multiplier(), DEFAULT_PAID_MULTIPLIER, units);
    return { ...q, charge: q.energy };
  }

  /** What is on offer and what each costs now. Safe for any member to see: no keys. */
  overview(userId: string, workspaceId: string) {
    this.opts.identity.require(userId, workspaceId, "task.read");
    return {
      tools: TOOLS.map((t) => ({ key: t.key, name: t.name, goodFor: t.goodFor, cost: t.cost, costNote: t.costNote, preferCheaper: t.preferCheaper, terms: t.terms, employees: t.employees, available: this.connected(t), quote: t.key === "voice" ? undefined : this.quote(t.key) })),
      files: this.headers(workspaceId),
      limits: { voiceMaxChars: VOICE_MAX_CHARS, voiceFiles: MAX_VOICE_FILES, stockFiles: MAX_STOCK_FILES },
    };
  }

  private headers(ws: string): ToolFileHeader[] {
    return [...this.mine(ws)].reverse().map(({ audio: _audio, ...h }) => h);
  }

  /** Checks who is asking and that this employee may use the tool. Returns the employee's id. */
  private asker(userId: string, ws: string, employeeId: unknown, key: ToolKey, permission: "task.read" | "task.create"): string {
    this.opts.identity.require(userId, ws, permission);
    const emp = this.opts.team(userId, ws).find((e) => e.id === employeeId);
    if (!emp) throw new ToolboxError("pick one of your employees");
    if (!mayUse(key, emp.templateKey)) throw new ToolboxError("that employee does not use this tool. Pick someone whose job needs it");
    return emp.id;
  }

  private count(key: ToolKey, ws: string): void {
    const t = tool(key)!;
    const day = this.now().toISOString().slice(0, 10);
    const bump = (k: string, max: number, what: string): void => {
      const c = this.counts.get(k);
      if (c && c.day === day && c.n >= max) throw new ToolboxError(what);
      this.counts.set(k, c && c.day === day ? { day, n: c.n + 1 } : { day, n: 1 });
    };
    const total = this.counts.get(`all:${key}`);
    if (total && total.day === day && total.n >= t.dailyBudget) throw new ToolboxError(`${t.name} has reached its limit for today across MAIZ. Try again tomorrow`);
    bump(`${key}:${ws}`, t.clientDaily, `your team has used ${t.name} ${t.clientDaily} times today, which is today's limit. Try again tomorrow`);
    bump(`all:${key}`, t.dailyBudget, "");
  }

  /**
   * Runs one use. `confirm` must equal the quote's charge. Energy is set aside first and kept only when `work` returned.
   */
  private async run<T>(userId: string, ws: string, employeeId: string, key: ToolKey, units: number, confirm: unknown, work: () => Promise<T>): Promise<{ result: T; energy: number }> {
    const t = tool(key)!;
    if (!this.connected(t)) throw new ToolboxError(`${t.name} is not switched on yet. MAIZ has to add its key first`);
    const quote = this.quote(key, units);
    if (quote.charge > 0 && confirm !== quote.charge) throw new ToolboxError(`This uses ${quote.energy} energy from the team's pool${t.cost === "double" ? ` (${quote.multiplier} times its plain cost of ${quote.baseEnergy}), because ${t.name} is a paid service` : ""}. Confirm to continue.`, quote);
    const pk = `${key}:${ws}`;
    if (this.busy.has(pk)) throw new ToolboxError("another request to this tool is still running. Wait for it to finish");
    // Nothing is awaited between the check and the hold, so two requests cannot pass the same check.
    if (quote.charge > 0) {
      const v = this.opts.meter.canAfford(ws, employeeId, quote.charge, t.estCostMicro * units);
      if (!v.allowed) throw new ToolboxError(`Not started: ${REASONS[v.reason] ?? "energy is not available"}.`, quote);
    }
    this.count(key, ws);
    const hold = quote.charge > 0 ? this.opts.meter.holdPaid(ws, quote.charge) : undefined;
    this.busy.add(pk);
    try {
      const result = await work();
      if (hold) this.opts.meter.settlePaid(hold, employeeId, `tool:${key}`, t.estCostMicro * units);
      this.opts.audit?.record({ workspaceId: ws, actor: `employee:${employeeId}`, action: "tool.used", data: { tool: key, energy: quote.charge } });
      return { result, energy: quote.charge };
    } catch (e) {
      if (hold) this.opts.meter.releasePaid(hold);
      throw e instanceof ToolError ? new ToolboxError(e.message) : e;
    } finally {
      this.busy.delete(pk);
    }
  }

  // ---------- web search and page reading ----------

  async search(userId: string, ws: string, body: Record<string, unknown>): Promise<{ results: SearchResult[]; energy: number; searchedAt: string }> {
    const emp = this.asker(userId, ws, body.employeeId, "web-search", "task.create");
    const query = cleanQuery(body.query, "your question");
    const key = this.opts.keys().braveSearch;
    const { result, energy } = await this.run(userId, ws, emp, "web-search", 1, body.confirmEnergy, () => braveSearch(this.http, key!, { query }));
    return { results: result, energy, searchedAt: this.now().toISOString() };
  }

  async read(userId: string, ws: string, body: Record<string, unknown>): Promise<{ page: PageText; energy: number }> {
    const emp = this.asker(userId, ws, body.employeeId, "page-reader", "task.create");
    const url = typeof body.url === "string" ? body.url : "";
    const { result, energy } = await this.run(userId, ws, emp, "page-reader", 1, body.confirmEnergy, () => readPage(url, this.http));
    return { page: result, energy };
  }

  // ---------- free stock pictures and video ----------

  async stock(userId: string, ws: string, body: Record<string, unknown>): Promise<{ items: StockItem[] }> {
    const provider = body.provider === "unsplash" ? "unsplash" : "pexels";
    const kind: StockKind = body.kind === "video" ? "video" : "photo";
    if (provider === "unsplash" && kind === "video") throw new ToolboxError("Unsplash has pictures only. Use Pexels for video");
    const key: ToolKey = provider === "unsplash" ? "stock-unsplash" : "stock-pexels";
    const emp = this.asker(userId, ws, body.employeeId, key, "task.read");
    const query = cleanQuery(body.query, "the picture you need");
    const keys = this.opts.keys();
    const { result } = await this.run(userId, ws, emp, key, 1, 0, () => (provider === "unsplash" ? unsplashSearch(this.http, keys.unsplash!, query) : pexelsSearch(this.http, keys.pexels!, kind, query)));
    return { items: result };
  }

  /**
   * Keeps one picture or clip the employee chose, with its credit line, so it can be attached later. Only the link is
   * kept, never a copy of the file. The item is looked up again at the provider, so a made-up one is refused.
   */
  async keepStock(userId: string, ws: string, body: Record<string, unknown>): Promise<ToolFileHeader> {
    const provider = body.provider === "unsplash" ? "unsplash" : "pexels";
    const kind: StockKind = body.kind === "video" ? "video" : "photo";
    const key: ToolKey = provider === "unsplash" ? "stock-unsplash" : "stock-pexels";
    const emp = this.asker(userId, ws, body.employeeId, key, "task.create");
    const query = cleanQuery(body.query, "the search that found it");
    const id = typeof body.itemId === "string" ? body.itemId : "";
    const keys = this.opts.keys();
    const { result } = await this.run(userId, ws, emp, key, 1, 0, () => (provider === "unsplash" ? unsplashSearch(this.http, keys.unsplash!, query) : pexelsSearch(this.http, keys.pexels!, kind, query)));
    const item = result.find((i) => i.id === id);
    if (!item) throw new ToolboxError("that picture was not in the results. Search again and pick one from the list");
    if (provider === "unsplash") void unsplashUsed(this.http, keys.unsplash!, item.id);
    const { id: itemId, provider: p, kind: k, pageUrl, fileUrl, credit, creditUrl, licence, description } = item;
    return this.keep(ws, emp, { kind: "stock", name: description.slice(0, 80) || "Stock picture", stock: { id: itemId, provider: p, kind: k, pageUrl, fileUrl, credit, creditUrl, licence, description } });
  }

  // ---------- voice ----------

  async voices(userId: string, ws: string): Promise<Voice[]> {
    this.opts.identity.require(userId, ws, "task.read");
    const key = this.opts.keys().elevenlabs;
    if (!key) throw new ToolboxError("Voice-over is not switched on yet. MAIZ has to add its key first");
    if (this.voiceList && this.now().getTime() - this.voiceList.at < VOICES_TTL_MS) return this.voiceList.voices;
    const voices = await elevenVoices(this.http, key).catch((e) => { if (e instanceof ToolError) throw new ToolboxError(e.message); throw e; });
    this.voiceList = { at: this.now().getTime(), voices };
    return voices;
  }

  /** What a script of this length costs, shown before anything is made. */
  voiceQuote(userId: string, ws: string, text: unknown): ToolQuote & { charge: number; characters: number } {
    this.opts.identity.require(userId, ws, "task.read");
    const characters = this.cleanScript(text).length;
    return { ...this.quote("voice", characters), characters };
  }

  private cleanScript(raw: unknown): string {
    const s = typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim() : "";
    if (s.length < VOICE_MIN_CHARS) throw new ToolboxError("write the words to be spoken");
    if (s.length > VOICE_MAX_CHARS) throw new ToolboxError(`a recording can hold up to ${VOICE_MAX_CHARS} characters. Split the script into parts`);
    return s;
  }

  async speak(userId: string, ws: string, body: Record<string, unknown>): Promise<{ file: ToolFileHeader; energy: number }> {
    const emp = this.asker(userId, ws, body.employeeId, "voice", "task.create");
    const text = this.cleanScript(body.text);
    const voiceId = typeof body.voiceId === "string" ? body.voiceId : "";
    // Only the ready-made voices we list can be used: nobody's own voice is copied.
    const voices = await this.voices(userId, ws);
    const voice = voices.find((v) => v.id === voiceId);
    if (!voice) throw new ToolboxError("pick one of the voices in the list");
    const key = this.opts.keys().elevenlabs!;
    const { result, energy } = await this.run(userId, ws, emp, "voice", text.length, body.confirmEnergy, () => elevenSpeak(this.http, key, { voiceId, text }));
    const name = `Recording, voice ${voice.name}`.slice(0, 80);
    return { file: this.keep(ws, emp, { kind: "voice", name, audio: result.toString("base64"), bytes: result.length }), energy };
  }

  // ---------- kept files ----------

  private keep(ws: string, employeeId: string, part: Pick<ToolFile, "kind" | "name" | "audio" | "bytes" | "stock">): ToolFileHeader {
    const file: ToolFile = { id: newId("tf"), workspaceId: ws, employeeId, createdAt: this.now().toISOString(), ...part };
    const max = file.kind === "voice" ? MAX_VOICE_FILES : MAX_STOCK_FILES;
    const all = [...this.mine(ws), file];
    const same = all.filter((f) => f.kind === file.kind);
    const dropped = same.length > max ? same.slice(0, same.length - max) : [];
    this.files.set(ws, all.filter((f) => !dropped.includes(f)));
    this.sink?.record(ws, "tool_file", file.id, file);
    for (const d of dropped) this.sink?.record(ws, "tool_file", d.id, { removed: true });
    const { audio: _audio, ...header } = file;
    return header;
  }

  /** One kept file with its audio, for playing or attaching. Another client's file looks like one that does not exist. */
  file(userId: string, ws: string, id: string): ToolFile {
    this.opts.identity.require(userId, ws, "task.read");
    const f = this.mine(ws).find((x) => x.id === id);
    if (!f) throw new ToolboxError("that file was not found");
    return f;
  }

  removeFile(userId: string, ws: string, id: string): void {
    this.opts.identity.require(userId, ws, "task.create");
    this.file(userId, ws, id);
    this.files.set(ws, this.mine(ws).filter((f) => f.id !== id));
    this.sink?.record(ws, "tool_file", id, { removed: true });
  }

  /** What an employee is told about files kept for the team: names, credit lines and licences, never the audio. */
  contextFor(ws: string, templateKey: string): string | undefined {
    const stock = this.mine(ws).filter((f) => f.kind === "stock" && f.stock && (mayUse("stock-pexels", templateKey) || mayUse("stock-unsplash", templateKey))).slice(-8);
    const voice = this.mine(ws).filter((f) => f.kind === "voice" && mayUse("voice", templateKey)).slice(-5);
    if (!stock.length && !voice.length) return undefined;
    const lines = ["Files kept for the team (attach them by name; always keep the credit line with a stock picture):"];
    for (const f of stock) lines.push(`- Picture or clip "${f.name}": ${f.stock!.credit}. ${f.stock!.licence} Source: ${f.stock!.pageUrl}`);
    for (const f of voice) lines.push(`- Recording "${f.name}" made ${f.createdAt.slice(0, 10)} (a computer voice).`);
    return lines.join("\n");
  }
}
