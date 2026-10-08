import type { Mailer } from "../../auth/mailer.ts";
import type { NotificationMessage, Provider, ProviderStatus, SendResult } from "../types.ts";

/** Default id of the e-mail provider. */
export const EMAIL = "email";

/**
 * E-mail as a notification provider: the app's Mailer behind the registry, so an e-mail a domain module sends lands
 * in the same send log (_notifications) as a WhatsApp one, with its attempts and outcome. The mailer is read on every
 * send (a getter), so a swapped app.mailer (tests, a settings change) is the one used. No session: always connected.
 */
export class EmailProvider implements Provider {
  readonly channels = ["email"] as const;

  constructor(private readonly mailer: () => Mailer, readonly id: string = EMAIL) {}

  async send(msg: NotificationMessage): Promise<SendResult> {
    // The registry already refused a message without subject or body; this guards a direct call.
    if (!msg.subject || !(msg.html || msg.text)) throw new Error("e-mail needs a subject and html or text");
    await this.mailer().send({
      to: msg.to,
      subject: msg.subject,
      html: msg.html || `<pre>${escapeHtml(msg.text ?? "")}</pre>`,
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    return {};
  }

  status(): ProviderStatus {
    return { state: "connected" };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
