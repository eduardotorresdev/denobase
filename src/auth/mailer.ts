import { traced } from "../telemetry/instrument/child.ts";
import { tracedFetch } from "../telemetry/instrument/fetch.ts";
import { SpanKind } from "../telemetry/span.ts";

/** A file sent with the mail; text content is sent as UTF-8. */
export interface MailAttachment {
  filename: string;
  content: Uint8Array | string;
  /** MIME type; the provider guesses from the filename when unset. */
  contentType?: string;
}

/** One message. Addresses are "a@b.c" or "Name <a@b.c>"; at least one of to/cc/bcc must hold one. */
export interface Mail {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
  /** Extra headers (e.g. In-Reply-To, List-Unsubscribe). */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** to/cc/bcc as lists, blanks dropped. */
export function recipients(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v == null ? [] : [v]).map((a) => a.trim()).filter(Boolean);
}

/** Refuses a mail no provider could deliver, so callers fail before the network does. */
export function assertDeliverable(mail: Mail): void {
  if (![mail.to, mail.cc, mail.bcc].some((v) => recipients(v).length)) throw new Error("mailer: no recipients");
  for (const [k, v] of Object.entries(mail.headers ?? {})) {
    // A newline in a header is header injection, whichever provider builds the MIME.
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new Error(`mailer: invalid header ${JSON.stringify(k)}`);
  }
}

/** Keeps sent mail for tests to read (the OTP code, attachments...). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  send(mail: Mail): Promise<void> {
    try {
      assertDeliverable(mail);
    } catch (e) {
      return Promise.reject(e);
    }
    this.sent.push(mail);
    return Promise.resolve();
  }
}

const utf8 = new TextEncoder();

/** Base64 in chunks: spreading a whole attachment into fromCharCode overflows the call stack. */
function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Resend-style HTTP API; key from RESEND_API_KEY. */
export class HttpMailer implements Mailer {
  constructor(
    readonly apiKey: string,
    readonly from: string,
    readonly endpoint = "https://api.resend.com/emails",
    readonly fetchFn: typeof fetch = fetch,
  ) {}
  /** A `mail.send` span (no recipients: they are PII) whose HTTP call carries the traceparent. */
  send(mail: Mail): Promise<void> {
    return traced("mail.send", {
      kind: SpanKind.client,
      attributes: { "mail.provider": "http", "mail.attachments": mail.attachments?.length ?? 0 },
    }, () => this.#send(mail));
  }

  async #send(mail: Mail): Promise<void> {
    assertDeliverable(mail);
    const list = (v: string | string[] | undefined) => recipients(v).length ? recipients(v) : undefined;
    const body = {
      from: this.from,
      to: list(mail.to),
      cc: list(mail.cc),
      bcc: list(mail.bcc),
      reply_to: list(mail.replyTo),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: mail.headers && Object.keys(mail.headers).length ? mail.headers : undefined,
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: encodeBase64(typeof a.content === "string" ? utf8.encode(a.content) : a.content),
        content_type: a.contentType,
      })),
    };
    const res = await tracedFetch(this.endpoint, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, this.fetchFn);
    // Body must be consumed either way or Deno reports a leaked resource.
    const text = await res.text();
    if (!res.ok) throw new Error(`mailer: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** HttpMailer when RESEND_API_KEY set, else MemoryMailer. */
export function mailerFromEnv(): Mailer {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return new MemoryMailer();
  return new HttpMailer(key, Deno.env.get("MAIL_FROM") ?? "pbS <no-reply@localhost>", Deno.env.get("RESEND_ENDPOINT"));
}

/**
 * Starts a send without awaiting it: a request never waits for the mail provider (PB's routine.FireAndForget), and a
 * failure, thrown or rejected, goes to onError.
 */
export function sendInBackground(send: () => Promise<void>, onError: (err: unknown) => void): void {
  let sending: Promise<void>;
  try {
    sending = send();
  } catch (err) {
    sending = Promise.reject(err);
  }
  sending.catch((err) => {
    try {
      onError(err);
    } catch (e) {
      console.error("mail failure handler failed", e);
    }
  });
}
