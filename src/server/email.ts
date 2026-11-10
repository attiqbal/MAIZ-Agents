/** Sends one email. Real delivery is Resend over HTTPS; development just prints the message. */
export interface EmailSender {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    console.log(`\n--- email to ${mail.to} ---\n${mail.subject}\n${mail.text}\n---`);
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
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`email provider ${res.status}`);
  }
}

/** Collects emails for tests. */
export class MemoryEmailSender implements EmailSender {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(mail);
  }
}
