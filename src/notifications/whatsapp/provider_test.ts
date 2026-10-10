import { assertEquals } from "@std/assert";
import { toReply } from "./provider.ts";

Deno.test("toReply quotes the message with its author and mentions it", () => {
  const { content, quoted } = toReply({
    to: "120363000000000000@g.us",
    text: "@5511999998888 Tem *3* peças.",
    quotedId: "ABC",
    quotedAuthor: "123456@lid",
    quotedText: "quantas peças?",
    mentions: ["123456@lid"],
  });
  assertEquals(content, { text: "@5511999998888 Tem *3* peças.", mentions: ["123456@lid"], linkPreview: null });
  assertEquals(quoted.key, {
    remoteJid: "120363000000000000@g.us",
    id: "ABC",
    fromMe: false,
    participant: "123456@lid",
  });
  assertEquals(quoted.message?.conversation, "quantas peças?");
});
