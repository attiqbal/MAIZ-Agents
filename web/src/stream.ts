// Asking with a live answer: the words appear as they are written. The server sends server-sent events over a POST,
// so this reads the response body itself (EventSource cannot send a body or a login header).
import { getToken, setToken } from "./api";

export interface AskDone {
  status: "ready_for_review" | "queued" | "failed" | "no_energy";
  reason?: string;
  answer?: string;
  /** A second check ran on this answer before it was finished. */
  checked?: boolean;
  runsAt?: string;
  message?: string;
}
export interface SseEvent { event: string; data: any }

/** Splits a buffer into whole events and what is left over (a half-received event waits for the next piece). */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try { events.push({ event, data: JSON.parse(data.join("\n")) }); } catch { /* a broken event is skipped, the rest still count */ }
  }
  return { events, rest };
}

/** What to show for a finished ask: plain words, never a blank. */
export function describeOutcome(who: string, d: AskDone): { kind: "answer" | "queued" | "note"; text: string } {
  if (d.status === "no_energy") return { kind: "note", text: d.message ?? (d.reason === "trial_ended" ? "Your free trial has ended" : "Your team is out of energy for now") };
  if (d.status === "queued") return { kind: "queued", text: d.runsAt ?? "" };
  if (d.status === "failed" || !d.answer) return { kind: "note", text: d.message ?? `${who} couldn't answer just now. Try again in a few minutes.` };
  return { kind: "answer", text: d.answer };
}

export interface StreamHandlers { onDelta(piece: string): void; onReset(): void }
export type StreamResult = { ok: true; done: AskDone } | { ok: false; status: number; message?: string };

export async function askStream(body: { text: string; employeeId: string; urgent?: boolean; when?: "now" | "tonight" }, h: StreamHandlers): Promise<StreamResult> {
  try {
    const token = getToken();
    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const fresh = res.headers.get("x-session-token");
    if (fresh && token) setToken(fresh);
    if (!res.ok || !res.body) {
      const j = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => undefined) : undefined;
      return { ok: false, status: res.status, message: j?.error };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let done: AskDone | undefined;
    let failed: string | undefined;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      pending += decoder.decode(value, { stream: true });
      const { events, rest } = parseSse(pending);
      pending = rest;
      for (const e of events) {
        if (e.event === "delta") h.onDelta(String(e.data.t ?? ""));
        else if (e.event === "reset") h.onReset();
        else if (e.event === "done") done = e.data as AskDone;
        else if (e.event === "error") failed = String(e.data.message ?? "");
      }
    }
    if (done) return { ok: true, done };
    return { ok: false, status: 200, message: failed || "The answer was cut off. Your question is still in the box, so you can send it again." };
  } catch {
    return { ok: false, status: 0 };
  }
}
