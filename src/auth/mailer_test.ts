import { assertEquals, assertRejects } from "@std/assert";
import { HttpMailer, MemoryMailer } from "./mailer.ts";

function fakeFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls, fn };
}

Deno.test("HttpMailer sends every recipient list, reply-to, headers and base64 attachments", async () => {
  const f = fakeFetch();
  const m = new HttpMailer("k", "pbS <no-reply@x.io>", "https://mail.test/emails", f.fn);
  await m.send({
    to: ["a@x.io", " b@x.io "],
    cc: "c@x.io",
    bcc: ["d@x.io"],
    replyTo: "r@x.io",
    subject: "Pedido 12",
    html: "<p>oi</p>",
    headers: { "In-Reply-To": "<m1@x.io>" },
    attachments: [
      { filename: "a.txt", content: "olá", contentType: "text/plain" },
      { filename: "b.bin", content: new Uint8Array([0, 255]) },
    ],
  });
  const b = f.calls[0].body;
  assertEquals([b.to, b.cc, b.bcc, b.reply_to], [["a@x.io", "b@x.io"], ["c@x.io"], ["d@x.io"], ["r@x.io"]]);
  assertEquals(b.headers, { "In-Reply-To": "<m1@x.io>" });
  assertEquals(b.attachments, [
    { filename: "a.txt", content: btoa("ol\xc3\xa1"), content_type: "text/plain" },
    { filename: "b.bin", content: "AP8=" },
  ]);
});

Deno.test("HttpMailer keeps the single-recipient payload of the auth flows", async () => {
  const f = fakeFetch();
  await new HttpMailer("k", "f@x.io", "https://mail.test/emails", f.fn).send({ to: "a@x.io", subject: "s", html: "h" });
  assertEquals(f.calls[0].body, { from: "f@x.io", to: ["a@x.io"], subject: "s", html: "h" });
});

Deno.test("a mail with no recipient or a header with a newline is refused before sending", async () => {
  const m = new MemoryMailer();
  await assertRejects(() => m.send({ to: [], subject: "s", html: "h" }), Error, "no recipients");
  await m.send({ to: [], bcc: "x@x.io", subject: "s", html: "h" });
  await assertRejects(
    () => m.send({ to: "a@x.io", subject: "s", html: "h", headers: { "X-A": "1\r\nBcc: evil@x.io" } }),
    Error,
    "invalid header",
  );
  assertEquals(m.sent.length, 1);
});
