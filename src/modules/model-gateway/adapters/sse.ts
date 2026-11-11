/**
 * Reads a server-sent-events body (what OpenAI-style servers and Anthropic send when asked to stream) and hands
 * each `data:` payload to `onData`. Handles chunks that split a line, CRLF line ends and comment lines.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const line = (raw: string) => {
    if (raw.startsWith("data:")) onData(raw.slice(5).trimStart());
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      line(pending.slice(0, nl).replace(/\r$/, ""));
      pending = pending.slice(nl + 1);
    }
  }
  pending += decoder.decode();
  if (pending) line(pending.replace(/\r$/, ""));
}
