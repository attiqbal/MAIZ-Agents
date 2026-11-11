/** Sends one email. Real delivery is Resend over HTTPS; development just prints the message. */
export interface EmailSender {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    console.log(`\n--- email to ${mail.to} ---\n${mail.subject}\n${mail.text}\n---`);
  }
}

const SEND_TIMEOUT_MS = 10_000;

/** The email provider refused a message. 429 and 5xx are worth another try; anything else is not. */
export class EmailProviderError extends Error {
  constructor(readonly status: number) {
    super(`email provider ${status}`);
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private apiKey: string,
    private from: string,
    private http: typeof fetch = fetch,
  ) {}
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    const res = await this.http("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new EmailProviderError(res.status);
  }
}

/** Collects emails for tests. */
export class MemoryEmailSender implements EmailSender {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(mail);
  }
}

export interface QueueOptions {
  /** Gap between two sends. Resend allows about 2 requests a second per account by default. */
  minIntervalMs?: number;
  maxAttempts?: number;
  /** First retry wait; doubles each time. */
  backoffMs?: number;
  /** Most messages waiting at once; beyond this the oldest waiting message is dropped and logged. */
  maxQueued?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sends email one at a time at the provider's pace and retries when it says "slow down" or fails for a moment.
 * `send` returns at once: a sign-in reply never waits on, or fails because of, the email provider. A burst of
 * 50 sign-ins used to lose 48 emails to Resend's rate limit with nobody told.
 */
export class QueuedEmailSender implements EmailSender {
  private queue: { to: string; subject: string; text: string }[] = [];
  private draining?: Promise<void>;
  /** True while the drain loop runs. Cleared in the same step the loop sees an empty queue, so no message is stranded. */
  private active = false;
  private readonly o: Required<Omit<QueueOptions, "sleep">>;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly stats = { sent: 0, retried: 0, failed: 0, dropped: 0 };

  constructor(private inner: EmailSender, opts: QueueOptions = {}) {
    this.o = { minIntervalMs: opts.minIntervalMs ?? 550, maxAttempts: opts.maxAttempts ?? 5, backoffMs: opts.backoffMs ?? 1_000, maxQueued: opts.maxQueued ?? 10_000 };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    if (this.queue.length >= this.o.maxQueued) {
      const old = this.queue.shift();
      this.stats.dropped++;
      console.error(`email queue full: dropped a message to ${old?.to.replace(/^(.).*@/, "$1***@")}`);
    }
    this.queue.push(mail);
    if (!this.active) {
      this.active = true;
      this.draining = this.drain();
    }
  }

  /** Resolves when every queued message was sent or given up on. */
  async idle(): Promise<void> {
    while (this.active) await this.draining;
  }

  get waiting(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const mail = this.queue.shift()!;
      for (let attempt = 1; ; attempt++) {
        try {
          await this.inner.send(mail);
          this.stats.sent++;
          break;
        } catch (err) {
          const transient = err instanceof EmailProviderError ? err.transient : true; // network errors and timeouts
          if (!transient || attempt >= this.o.maxAttempts) {
            this.stats.failed++;
            console.error(`email to ${mail.to.replace(/^(.).*@/, "$1***@")} failed: ${err instanceof Error ? err.message : err}`);
            break;
          }
          this.stats.retried++;
          await this.sleep(this.o.backoffMs * 2 ** (attempt - 1));
        }
      }
      if (this.queue.length) await this.sleep(this.o.minIntervalMs);
    }
    this.active = false;
  }
}
