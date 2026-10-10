import { assert, assertEquals } from "@std/assert";
import { createApp } from "../../app.ts";
import { MemoryMailer } from "../../auth/mailer.ts";
import { registerCollections } from "../../core/registry.ts";
import { superusers } from "../../core/superusers.ts";
import { dbWith } from "../../testing/mod.ts";
import { notificationCollections } from "../collections.ts";
import type { ProviderEvents, ProviderStatus } from "../types.ts";
import { WhatsAppWebProvider } from "./provider.ts";

registerCollections(...notificationCollections);

// Baileys keeps keep-alive and query timers of its own past end(); the socket itself is closed and checked below.
Deno.test({
  name: "baileys: the real socket loads under Deno and opens the noise handshake (no pairing)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A local stand-in for web.whatsapp.com: Baileys' first frame is the "WA" header + ClientHello.
    let firstFrame: Uint8Array | undefined;
    const got = Promise.withResolvers<void>();
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (e) => {
        firstFrame ??= new Uint8Array(e.data as ArrayBuffer);
        got.resolve();
      };
      return response;
    });
    const cs = [superusers, ...notificationCollections];
    const app = createApp({ db: await dbWith(cs), mailer: new MemoryMailer(), collections: cs, adminUiDir: false });
    const states: ProviderStatus["state"][] = [];
    const events: ProviderEvents = {
      receipt: () => {},
      inbound: () => {},
      status: (_, s) => void states.push(s.state),
    };
    const wa = new WhatsAppWebProvider(app.store, {
      reconnectMs: 60_000,
      socket: { waWebSocketUrl: `ws://127.0.0.1:${server.addr.port}/ws/chat`, connectTimeoutMs: 5_000 },
    });
    try {
      await wa.start(events);
      await Promise.race([got.promise, new Promise((_, no) => setTimeout(() => no(new Error("no frame")), 10_000))]);
      assert(firstFrame && firstFrame.length > 4);
      assertEquals(new TextDecoder().decode(firstFrame.slice(0, 2)), "WA");
      assertEquals(states[0], "connecting");
      // Nothing was paired: the fresh creds were written to _whatsapp_auth on creds.update or stay in memory.
      assertEquals(wa.status().state, "connecting");
    } finally {
      await wa.stop();
      await server.shutdown();
    }
    assertEquals(wa.status().state, "disconnected");
  },
});
