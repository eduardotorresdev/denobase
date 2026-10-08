import { z } from "zod";

/** A delivery medium a provider serves. */
export type Channel = "whatsapp" | "email";

/** A media attachment: exactly one of a base64 payload (data) or a url the provider fetches itself. */
export interface Media {
  kind: "image" | "video" | "audio" | "document";
  data?: string;
  url?: string;
  mimetype?: string;
  filename?: string;
}

export const mediaSchema: z.ZodType<Media> = z.object({
  kind: z.enum(["image", "video", "audio", "document"]),
  /** Base64 payload; url is the alternative for media the provider can fetch itself. */
  data: z.string().optional(),
  url: z.string().url().optional(),
  mimetype: z.string().optional(),
  filename: z.string().optional(),
}).refine((m) => !!m.data !== !!m.url, { message: "media needs exactly one of data or url" });

/** A message to send: text, media or both, optionally quoting an earlier one and mentioning jids. */
export interface NotificationMessage {
  provider: string;
  /** Provider address: a phone number ("5511999999999"), a WhatsApp jid (user or group) or an e-mail address. */
  to: string;
  text?: string;
  /** E-mail only: the subject (required there), the HTML body and the Reply-To address. */
  subject?: string;
  html?: string;
  replyTo?: string;
  media?: Media;
  /** Quotes an earlier message (a reply); id is the provider's id of the quoted message. */
  reply?: { id: string; author?: string; text?: string };
  /** Jids the text mentions; the text itself already carries each "@<user>". */
  mentions?: string[];
}

export const messageSchema: z.ZodType<NotificationMessage> = z.object({
  provider: z.string().min(1),
  /** Provider address: a phone number ("5511999999999"), a WhatsApp jid (user or group) or an e-mail address. */
  to: z.string().min(1),
  text: z.string().optional(),
  /** E-mail only: the subject (required there), the HTML body and the Reply-To address. */
  subject: z.string().optional(),
  html: z.string().optional(),
  replyTo: z.string().optional(),
  media: mediaSchema.optional(),
  /** Quotes an earlier message (a reply); id is the provider's id of the quoted message. */
  reply: z.object({
    id: z.string().min(1),
    /** Author jid of the quoted message, as it arrived (a LID in a LID group). */
    author: z.string().optional(),
    /** Preview of the quoted text. */
    text: z.string().optional(),
  }).optional(),
  /** Jids the text mentions; the text itself already carries each "@<user>". */
  mentions: z.array(z.string().min(1)).optional(),
}).refine((m) => !!m.text || !!m.media || !!m.html, { message: "message needs text or media (or html, by e-mail)" });

export interface SendResult {
  /** The provider's id of the sent message; receipts refer back to it. */
  externalId?: string;
}

/** Connection state a provider reports; qr is set while pairing. */
export interface ProviderStatus {
  state: "disconnected" | "connecting" | "pairing" | "connected" | "logged_out";
  qr?: string;
  /** The paired account (e.g. the WhatsApp jid). */
  account?: string;
  /** The paired account's display name (WhatsApp pushName), when the provider knows it. */
  accountName?: string;
  error?: string;
}

export type ReceiptStatus = "delivered" | "read" | "failed";

/** Something a provider received: an inbound message the consuming app may react to. */
export interface InboundMessage {
  provider: string;
  from: string;
  /** Set when the message came in a group. */
  group?: string;
  externalId: string;
  text?: string;
  mediaKind?: Media["kind"];
  timestamp: number;
  /** The provider's raw payload, for download or anything this shape leaves out. */
  raw: unknown;
}

/** What the registry hands a provider so it can report back without knowing the store. */
export interface ProviderEvents {
  receipt(provider: string, externalId: string, status: ReceiptStatus): void | Promise<void>;
  inbound(msg: InboundMessage): void | Promise<void>;
  status(provider: string, status: ProviderStatus): void;
}

export interface Provider {
  readonly id: string;
  readonly channels: readonly Channel[];
  send(msg: NotificationMessage): Promise<SendResult>;
  status(): ProviderStatus;
  /** Called once by the registry before any send. */
  start?(events: ProviderEvents): Promise<void> | void;
  /** Closes sockets; the app's onTerminate calls it. */
  stop?(): Promise<void> | void;
}
