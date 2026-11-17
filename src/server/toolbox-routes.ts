import { ToolboxError } from "../modules/toolbox/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown): Res => ({ status, body });
const FILE = /^\/api\/tools\/files\/(tf-[\w-]{1,64})(?:\/(remove))?$/;

/**
 * The platform's outside services for a client's employees: voice-over, web search, reading a page, free stock
 * pictures (docs/NEW-SERVICES.md). A request that costs energy is refused with 409 and the quote until the caller
 * sends the figure back as `confirmEnergy`. Permissions are checked in the service, inside the signed-in person's own workspace.
 */
export async function toolboxRoute(req: Req, userId: string, p: Platform, workspaceId: string | undefined, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (path !== "/api/tools" && !path.startsWith("/api/tools/")) return undefined;
  if (!workspaceId) return json(404, { error: "no organisation yet" });
  const t = p.toolbox;
  try {
    if (method === "GET" && path === "/api/tools") return json(200, t.overview(userId, workspaceId));
    if (method === "GET" && path === "/api/tools/voices") return json(200, { voices: await t.voices(userId, workspaceId) });
    if (method === "POST" && path === "/api/tools/voice/quote") return json(200, { quote: t.voiceQuote(userId, workspaceId, body().text) });
    if (method === "POST" && path === "/api/tools/voice") return json(201, { ...(await t.speak(userId, workspaceId, body())), team: p.energy.teamEnergyOf(workspaceId) ?? null });
    if (method === "POST" && path === "/api/tools/search") return json(200, { ...(await t.search(userId, workspaceId, body())), team: p.energy.teamEnergyOf(workspaceId) ?? null });
    if (method === "POST" && path === "/api/tools/read") return json(200, { ...(await t.read(userId, workspaceId, body())), team: p.energy.teamEnergyOf(workspaceId) ?? null });
    if (method === "POST" && path === "/api/tools/stock") return json(200, await t.stock(userId, workspaceId, body()));
    if (method === "POST" && path === "/api/tools/stock/keep") return json(201, { file: await t.keepStock(userId, workspaceId, body()) });
    const one = FILE.exec(path);
    if (one && method === "GET" && !one[2]) {
      const f = t.file(userId, workspaceId, one[1]!);
      // The recording travels as text inside the answer; the page plays it from a data address.
      return json(200, { file: { ...f, audio: undefined }, ...(f.audio ? { mime: "audio/mpeg", base64: f.audio } : {}) });
    }
    if (one && method === "POST" && one[2]) { t.removeFile(userId, workspaceId, one[1]!); return json(200, { removed: true, files: t.overview(userId, workspaceId).files }); }
  } catch (e) {
    if (e instanceof ToolboxError) return json(e.quote ? 409 : 400, { error: e.message, ...(e.quote ? { quote: e.quote } : {}) });
    throw e;
  }
  return json(404, { error: "not found" });
}
