import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { isPrivateIp, safeFetch, SsrfError } from "./ssrf.ts";
import { cimdIdProblem } from "./cimd.ts";

const PUBLIC = () => Promise.resolve(["93.184.216.34"]);

Deno.test("ssrf: private, loopback, link-local, metadata and v6 forms are private", () => {
  for (
    const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
      "garbage",
    ]
  ) assert(isPrivateIp(ip), ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assertFalse(isPrivateIp(ip), ip);
});

Deno.test("ssrf: refuses http, other ports, credentials, private DNS answers and literal private hosts", async () => {
  const f = () => Promise.resolve(new Response("{}"));
  await assertRejects(() => safeFetch("http://a.example/x", { fetch: f, resolve: PUBLIC }), SsrfError);
  await assertRejects(() => safeFetch("https://a.example:8443/x", { fetch: f, resolve: PUBLIC }), SsrfError);
  await assertRejects(() => safeFetch("https://u:p@a.example/x", { fetch: f, resolve: PUBLIC }), SsrfError);
  await assertRejects(
    () => safeFetch("https://a.example/x", { fetch: f, resolve: () => Promise.resolve(["10.0.0.1"]) }),
    SsrfError,
  );
  await assertRejects(() => safeFetch("https://[::1]/x", { fetch: f }), SsrfError);
});

Deno.test("ssrf: a redirect is not followed, a large body and a slow server are cut", async () => {
  const redirect = () =>
    Promise.resolve(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }));
  await assertRejects(() => safeFetch("https://a.example/x", { fetch: redirect, resolve: PUBLIC }), SsrfError);
  const big = () => Promise.resolve(new Response("x".repeat(6000)));
  await assertRejects(() => safeFetch("https://a.example/x", { fetch: big, resolve: PUBLIC }), SsrfError, "large");
  const slow: typeof fetch = (_u, init) =>
    new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  await assertRejects(
    () => safeFetch("https://a.example/x", { fetch: slow, resolve: PUBLIC, timeoutMs: 20 }),
    SsrfError,
    "timeout",
  );
  const ok = await safeFetch("https://a.example/x", {
    fetch: () => Promise.resolve(new Response("{}")),
    resolve: PUBLIC,
  });
  assertEquals(ok.bodyText, "{}");
});

Deno.test("cimd: a client_id needs https, a path, no fragment, credentials or other port", () => {
  assertEquals(cimdIdProblem("https://a.example/client.json"), null);
  for (
    const id of [
      "http://a.example/c",
      "https://a.example/",
      "https://a.example/c#x",
      "https://u@a.example/c",
      "https://a.example:444/c",
      "https://a.example/a/../c",
    ]
  ) assert(cimdIdProblem(id), id);
});
