/**
 * Video template renderers. Each takes a template id and the words and pictures to put in it, and returns where the
 * finished video is. Without a key the practice renderer answers instead, so everything above this file works the same.
 */
export interface RenderInput {
  templateId: string;
  /** Template slot -> text, or https address of a picture or clip. */
  fields: Record<string, string>;
}
export interface RenderResult {
  id: string;
  status: "done" | "pending";
  url?: string;
  /** True when no real service ran, so nothing was spent. */
  simulated: boolean;
}

export class RenderError extends Error {}

const TIMEOUT_MS = 20_000;
export const MAX_FIELDS = 30;
const SLOT = /^[\w .:-]{1,64}$/;
const TEMPLATE_ID = /^[\w-]{6,64}$/;
/** A render id as the services give it. One that does not fit is refused before anything is charged, so it can always be looked up later. */
const RENDER_ID = /^[\w-]{4,80}$/;

/** Cleans what an agent or client typed before it goes to a paid service. Throws a plain message. */
export function cleanRender(raw: unknown): RenderInput {
  if (!raw || typeof raw !== "object") throw new RenderError("the video request is empty");
  const r = raw as Record<string, unknown>;
  const templateId = typeof r.templateId === "string" ? r.templateId.trim() : "";
  if (!TEMPLATE_ID.test(templateId)) throw new RenderError("the template id is a code of letters, numbers and dashes, copied from the service");
  const fields: Record<string, string> = {};
  const src = r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? (r.fields as Record<string, unknown>) : {};
  const entries = Object.entries(src);
  if (entries.length > MAX_FIELDS) throw new RenderError(`a video can fill at most ${MAX_FIELDS} slots`);
  for (const [slot, value] of entries) {
    if (!SLOT.test(slot)) throw new RenderError(`"${slot.slice(0, 30)}" is not a usable slot name`);
    const v = String(value ?? "").trim().slice(0, 1000);
    // A picture or clip must be an https address; the rendering service fetches it, never us.
    // One unbroken word with a scheme is an address, not a sentence ("Sale: today only" is a sentence).
    if (!/\s/.test(v) && /^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https:\/\/[^\s/]+\//i.test(v)) throw new RenderError(`slot "${slot}" must be text or a public https address`);
    fields[slot] = v;
  }
  return { templateId, fields };
}

async function call(http: typeof fetch, name: string, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new RenderError(`${name} could not be reached. No energy was used. Try again in a minute.`);
  }
  if (res.status === 401 || res.status === 403) throw new RenderError(`${name} did not accept the key. Check it on the Connections page.`);
  if (res.status === 402) throw new RenderError(`${name} says the account is out of credit.`);
  if (res.status === 429) throw new RenderError(`${name} is busy. Try again in a minute.`);
  if (!res.ok) throw new RenderError(`${name} refused the request (error ${res.status}). Check the template id.`);
  try { return await res.json(); } catch { throw new RenderError(`${name} sent an answer we could not read.`); }
}

const https = (v: unknown): string | undefined => (typeof v === "string" && /^https:\/\/[^\s]+$/.test(v) ? v : undefined);

/** Creatomate: POST /v1/renders with a template and modifications. */
export async function renderCreatomate(http: typeof fetch, apiKey: string, input: RenderInput): Promise<RenderResult> {
  const body = await call(http, "Creatomate", "https://api.creatomate.com/v1/renders", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ template_id: input.templateId, modifications: input.fields }),
  });
  const r = Array.isArray(body) ? body[0] : body;
  if (!r || typeof r.id !== "string" || !RENDER_ID.test(r.id)) throw new RenderError("Creatomate did not start the render.");
  return { id: r.id, status: r.status === "succeeded" ? "done" : "pending", url: https(r.url), simulated: false };
}

/** Shotstack: POST /edit/v1/templates/render with the template id and merge fields. */
export async function renderShotstack(http: typeof fetch, apiKey: string, input: RenderInput): Promise<RenderResult> {
  const body = await call(http, "Shotstack", "https://api.shotstack.io/edit/v1/templates/render", {
    method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ id: input.templateId, merge: Object.entries(input.fields).map(([find, replace]) => ({ find, replace })) }),
  });
  const id = body?.response?.id;
  if (typeof id !== "string" || !RENDER_ID.test(id)) throw new RenderError("Shotstack did not start the render.");
  return { id, status: "pending", simulated: false };
}

/** Looks up a started render. Creatomate and Shotstack both finish a few seconds to minutes later. */
export async function checkRender(http: typeof fetch, service: "creatomate" | "shotstack", apiKey: string, id: string): Promise<RenderResult> {
  if (!RENDER_ID.test(id)) throw new RenderError("that render id is not valid");
  if (service === "creatomate") {
    const r = await call(http, "Creatomate", `https://api.creatomate.com/v1/renders/${id}`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (r?.status === "failed") throw new RenderError("Creatomate could not finish this video.");
    return { id, status: r?.status === "succeeded" ? "done" : "pending", url: https(r?.url), simulated: false };
  }
  const r = await call(http, "Shotstack", `https://api.shotstack.io/edit/v1/render/${id}`, { headers: { "x-api-key": apiKey } });
  const s = r?.response?.status;
  if (s === "failed") throw new RenderError("Shotstack could not finish this video.");
  return { id, status: s === "done" ? "done" : "pending", url: https(r?.response?.url), simulated: false };
}

/** A key that opens the service: one cheap read that does not render anything. */
export async function keyWorks(http: typeof fetch, service: "creatomate" | "shotstack", apiKey: string): Promise<void> {
  if (service === "creatomate") await call(http, "Creatomate", "https://api.creatomate.com/v1/templates?limit=1", { headers: { authorization: `Bearer ${apiKey}` } });
  else await call(http, "Shotstack", "https://api.shotstack.io/edit/v1/templates", { headers: { "x-api-key": apiKey } });
}

/** The practice renderer: nothing is sent anywhere and nothing is spent. */
export function renderPractice(input: RenderInput, nextId: () => string): RenderResult {
  void input;
  return { id: `practice-${nextId()}`, status: "done", simulated: true };
}
