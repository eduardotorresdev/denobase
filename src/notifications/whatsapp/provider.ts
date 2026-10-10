import { Buffer } from "node:buffer";
import {
  type AnyMessageContent,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAPresence,
  type WASocket,
} from "baileys";
import type { Store } from "../../store/mod.ts";
import { badRequest } from "../../core/errors.ts";
import type {
  Channel,
  InboundMessage,
  Media,
  NotificationMessage,
  Provider,
  ProviderEvents,
  ProviderStatus,
  ReceiptStatus,
  SendResult,
} from "../types.ts";
import { type StoreAuthState, useStoreAuthState } from "./auth_state.ts";
import { silentLogger } from "./logger.ts";
import { whatsappAuthCollection as whatsappAuth } from "../schema.ts";

/** Row key of the address book inside the session's _whatsapp_auth rows: logout drops it with the session. */
const CONTACTS_KEY = "pbs-contacts";

export const WHATSAPP_WEB = "whatsapp-web";

export interface WhatsAppWebOptions {
  /** Row key in _whatsapp_auth; one per paired number. */
  session?: string;
  /** Socket overrides (tests point waWebSocketUrl at a local server). */
  socket?: Partial<UserFacingSocketConfig>;
  /** Delay before reconnecting after a drop that was not a logout. */
  reconnectMs?: number;
}

/** A reply that quotes an inbound message and mentions its author (the group answer of a bot). */
export interface WhatsAppReply {
  to: string;
  /** Carries "@<user>" for each mention. */
  text: string;
  quotedId: string;
  /** Raw jid of the quoted message's author, as it arrived (a LID in a LID group). */
  quotedAuthor?: string;
  /** Preview of the quoted message. */
  quotedText?: string;
  mentions?: string[];
}

/** The paired account: its phone jid and, when WhatsApp gave one, its LID. */
export interface WhatsAppMe {
  id: string;
  lid?: string;
}

/** Baileys content and options of a quoted reply with mentions. */
export function toReply(r: WhatsAppReply): { content: AnyMessageContent; quoted: WAMessage } {
  const remoteJid = toJid(r.to);
  return {
    content: { text: r.text, mentions: r.mentions ?? [], linkPreview: null },
    quoted: {
      key: { remoteJid, id: r.quotedId, fromMe: false, participant: r.quotedAuthor || undefined },
      message: { conversation: r.quotedText ?? "" },
    },
  };
}

/** An address-book entry: what the paired phone knows of a contact (saved name, own push name). */
export interface WhatsAppContact {
  /** Contact jid, phone (@s.whatsapp.net) when known, else LID. */
  id: string;
  lid?: string;
  /** Phone jid (@s.whatsapp.net). */
  phone?: string;
  /** Name saved on the paired phone. */
  name?: string;
  /** Name the contact set on WhatsApp. */
  notify?: string;
}

/** Folds Baileys contact events into the book; a later partial update keeps what it does not repeat. */
export function mergeContacts(
  book: Record<string, WhatsAppContact>,
  updates: readonly {
    id?: string | null;
    lid?: string | null;
    phoneNumber?: string | null;
    name?: string | null;
    notify?: string | null;
  }[],
): boolean {
  let changed = false;
  for (const u of updates) {
    const id = u.id?.trim();
    if (!id) continue;
    const prev = book[id] ?? { id };
    const next: WhatsAppContact = { ...prev };
    if (u.lid) next.lid = u.lid;
    if (u.phoneNumber) next.phone = u.phoneNumber;
    else if (id.endsWith("@s.whatsapp.net")) next.phone = id;
    else if (id.endsWith("@lid")) next.lid ??= id;
    if (u.name) next.name = u.name;
    if (u.notify) next.notify = u.notify;
    if (JSON.stringify(next) !== JSON.stringify(book[id])) {
      book[id] = next;
      changed = true;
    }
  }
  return changed;
}

/** Baileys send options of a reply: the quoted message rebuilt from its id, author and text preview. */
export function quotedOf(to: string, reply: NotificationMessage["reply"]): { quoted: WAMessage } | undefined {
  if (!reply) return undefined;
  return {
    quoted: {
      key: { remoteJid: to, id: reply.id, fromMe: false, participant: reply.author || undefined },
      message: { conversation: reply.text ?? "" },
    },
  };
}

export interface WhatsAppGroup {
  id: string;
  subject: string;
  participants: number;
}

/** "5511999999999", "+55 (11) 99999-9999" or a jid -> a jid Baileys accepts. */
export function toJid(to: string): string {
  if (to.includes("@")) return to;
  const digits = to.replace(/\D/g, "");
  if (!digits) throw new Error(`invalid WhatsApp address "${to}"`);
  return `${digits}@s.whatsapp.net`;
}

/** proto.WebMessageInfo.Status -> what the send log tracks; PENDING/SERVER_ACK are still "sent". */
export function receiptOf(status: number | null | undefined): ReceiptStatus | undefined {
  const S = proto.WebMessageInfo.Status;
  if (status === S.ERROR) return "failed";
  if (status === S.DELIVERY_ACK) return "delivered";
  if (status === S.READ || status === S.PLAYED) return "read";
  return undefined;
}

/** Message body of a WAMessage: plain text, extended text or a media caption. */
function textOf(m: WAMessage): string | undefined {
  const c = m.message;
  return c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ??
    c?.documentMessage?.caption ?? undefined;
}

function mediaKindOf(m: WAMessage): Media["kind"] | undefined {
  const c = m.message;
  if (c?.imageMessage) return "image";
  if (c?.videoMessage) return "video";
  if (c?.audioMessage) return "audio";
  if (c?.documentMessage) return "document";
  return undefined;
}

/**
 * Builds Baileys content without optional native deps: text skips link previews (link-preview-js), image and video
 * carry an empty thumbnail (sharp/jimp/ffmpeg) and audio a zero duration.
 */
export function toContent(msg: Pick<NotificationMessage, "text" | "media" | "mentions">): AnyMessageContent {
  const m = msg.media;
  const mentioned = msg.mentions?.length ? { mentions: msg.mentions } : {};
  if (!m) return { text: msg.text ?? "", linkPreview: null, ...mentioned };
  const src = m.url ? { url: m.url } : Buffer.from(m.data!, "base64");
  const caption = msg.text;
  switch (m.kind) {
    case "image":
      return { image: src, caption, mimetype: m.mimetype, jpegThumbnail: "", ...mentioned };
    case "video":
      return { video: src, caption, mimetype: m.mimetype, jpegThumbnail: "", ...mentioned };
    case "audio":
      return { audio: src, mimetype: m.mimetype ?? "audio/ogg; codecs=opus", seconds: 0 };
    case "document":
      return {
        document: src,
        caption,
        mimetype: m.mimetype ?? "application/octet-stream",
        fileName: m.filename ?? "file",
        ...mentioned,
      };
  }
}

/** WhatsApp Web through Baileys: QR pairing, session in the app's db, reconnect, receipts and inbound. */
export class WhatsAppWebProvider implements Provider {
  readonly id = WHATSAPP_WEB;
  readonly channels: readonly Channel[] = ["whatsapp"];
  #sock: WASocket | null = null;
  #auth: StoreAuthState | null = null;
  #events: ProviderEvents | null = null;
  #status: ProviderStatus = { state: "disconnected" };
  #stopped = true;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  readonly #session: string;

  constructor(private readonly store: Store, private readonly opts: WhatsAppWebOptions = {}) {
    this.#session = opts.session ?? "default";
  }

  status(): ProviderStatus {
    return { ...this.#status };
  }

  async start(events: ProviderEvents): Promise<void> {
    this.#events = events;
    this.#stopped = false;
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnect);
    const s = this.#sock;
    this.#sock = null;
    s?.ev.removeAllListeners(undefined as never);
    s?.end(undefined);
    this.#set({ state: "disconnected" });
    await Promise.resolve();
  }

  /** Unpairs on WhatsApp's side, drops the stored session and starts again in pairing mode. */
  async logout(): Promise<void> {
    try {
      await this.#sock?.logout();
    } catch {
      // Already closed: dropping the stored session is what matters.
    }
    await this.stop();
    await (this.#auth ?? await useStoreAuthState(this.store, this.#session)).clear();
    this.#auth = null;
    this.#contacts = null;
    this.#set({ state: "logged_out" });
    if (this.#events) await this.start(this.#events);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    const to = toJid(msg.to);
    const sent = await this.#ready().sendMessage(to, toContent(msg), quotedOf(to, msg.reply));
    return { externalId: sent?.key.id ?? undefined };
  }

  /** Sends text quoting a received message and mentioning jids (the reply a group expects). */
  async reply(r: WhatsAppReply): Promise<SendResult> {
    const { content, quoted } = toReply(r);
    const sent = await this.#ready().sendMessage(toJid(r.to), content, { quoted });
    return { externalId: sent?.key.id ?? undefined };
  }

  /** The paired account; undefined while not connected. */
  me(): WhatsAppMe | undefined {
    const u = this.#sock?.user;
    if (!u?.id || this.#status.state !== "connected") return undefined;
    return { id: jidNormalizedUser(u.id), lid: u.lid ? jidNormalizedUser(u.lid) : undefined };
  }

  async groups(): Promise<WhatsAppGroup[]> {
    const all = await this.#ready().groupFetchAllParticipating();
    return Object.values(all).map((g) => ({ id: g.id, subject: g.subject, participants: g.participants.length }));
  }

  /** Which numbers have WhatsApp, with the jid to send to. */
  async isOnWhatsApp(numbers: string[]): Promise<{ number: string; exists: boolean; jid?: string }[]> {
    const found = (await this.#ready().onWhatsApp(...numbers.map(toJid))) ?? [];
    return numbers.map((number) => {
      const jid = toJid(number);
      const hit = found.find((f) => f.jid === jid || jidNormalizedUser(f.jid) === jid);
      return { number, exists: !!hit?.exists, jid: hit?.jid };
    });
  }

  /** The address book the paired phone synced (contacts events), kept with the session in _whatsapp_auth. */
  async contacts(): Promise<WhatsAppContact[]> {
    return Object.values(await this.#book());
  }

  /** The phone jid behind a LID, from Baileys' LID mapping; undefined when unknown or not connected. */
  async resolveLid(lid: string): Promise<string | undefined> {
    if (!this.#sock || this.#status.state !== "connected") return undefined;
    return (await this.#sock.signalRepository.lidMapping.getPNForLID(lid)) ?? undefined;
  }

  async presence(to: string, type: WAPresence): Promise<void> {
    await this.#ready().sendPresenceUpdate(type, toJid(to));
  }

  /** Bytes of an inbound media message (InboundMessage.raw). */
  async download(raw: unknown): Promise<Uint8Array> {
    const sock = this.#ready();
    return await downloadMediaMessage(raw as WAMessage, "buffer", {}, {
      logger: silentLogger,
      reuploadRequest: sock.updateMediaMessage,
    });
  }

  #contacts: Record<string, WhatsAppContact> | null = null;

  async #book(): Promise<Record<string, WhatsAppContact>> {
    if (this.#contacts) return this.#contacts;
    const row = await this.#contactsRow();
    this.#contacts = (row?.value as Record<string, WhatsAppContact> | undefined) ?? {};
    return this.#contacts;
  }

  #contactsRow() {
    return this.store.collection(whatsappAuth).query()
      .where("session", "equals", this.#session).where("key", "equals", CONTACTS_KEY).first();
  }

  // Serialized: history sync fires contact batches back to back.
  #saving: Promise<void> = Promise.resolve();

  #learn(updates: Parameters<typeof mergeContacts>[1]): void {
    this.#saving = this.#saving.then(async () => {
      const book = await this.#book();
      if (!mergeContacts(book, updates)) return;
      const rows = this.store.collection(whatsappAuth);
      const row = await this.#contactsRow();
      if (row) await rows.update(row.id, { value: book });
      else await rows.create({ session: this.#session, key: CONTACTS_KEY, value: book });
    }).catch(() => {});
  }

  #ready(): WASocket {
    if (!this.#sock || this.#status.state !== "connected") throw badRequest("WhatsApp is not connected.");
    return this.#sock;
  }

  #set(s: ProviderStatus): void {
    this.#status = s;
    this.#events?.status(this.id, this.status());
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    this.#auth ??= await useStoreAuthState(this.store, this.#session);
    const auth = this.#auth;
    this.#set({ state: "connecting" });
    const sock = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger) },
      logger: silentLogger,
      browser: Browsers.ubuntu("Denobase"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      ...this.opts.socket,
    });
    this.#sock = sock;
    sock.ev.on("creds.update", () => void auth.saveCreds());
    sock.ev.on("contacts.upsert", (cs) => this.#learn(cs));
    sock.ev.on("contacts.update", (cs) => this.#learn(cs));
    sock.ev.on("messaging-history.set", ({ contacts }) => this.#learn(contacts));
    sock.ev.on("connection.update", (u) => {
      if (sock !== this.#sock) return;
      if (u.qr) this.#set({ state: "pairing", qr: u.qr });
      if (u.connection === "open") {
        this.#set({
          state: "connected",
          account: sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined,
          accountName: sock.user?.name || sock.user?.verifiedName || undefined,
        });
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.#sock = null;
        if (code === DisconnectReason.loggedOut) {
          void auth.clear().then(() => {
            this.#auth = null;
            this.#contacts = null;
            this.#set({ state: "logged_out", error: "logged out from the phone" });
            this.#schedule(0);
          });
          return;
        }
        this.#set({ state: "disconnected", error: u.lastDisconnect?.error?.message });
        // restartRequired comes right after pairing: reconnect at once.
        this.#schedule(code === DisconnectReason.restartRequired ? 0 : this.opts.reconnectMs ?? 5000);
      }
    });
    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const r = key.fromMe ? receiptOf(update.status) : undefined;
        if (r && key.id) void this.#events?.receipt(this.id, key.id, r);
      }
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (m.key.fromMe || !m.message || !m.key.id || !m.key.remoteJid) continue;
        const group = isJidGroup(m.key.remoteJid) ? m.key.remoteJid : undefined;
        const msg: InboundMessage = {
          provider: this.id,
          from: group ? (m.key.participant ?? "") : m.key.remoteJid,
          group,
          externalId: m.key.id,
          text: textOf(m),
          mediaKind: mediaKindOf(m),
          timestamp: Number(m.messageTimestamp ?? 0),
          raw: m,
        };
        void this.#events?.inbound(msg);
      }
    });
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    clearTimeout(this.#reconnect);
    this.#reconnect = setTimeout(() => void this.#connect(), ms);
  }
}
