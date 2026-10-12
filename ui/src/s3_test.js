import { assertEquals } from "@std/assert";
import { detectProvider, objectUrl, parseS3Url, stepAdvice } from "./s3.js";

Deno.test("parseS3Url reads what provider consoles show", () => {
  assertEquals(parseS3Url("https://media.s3.eu-west-1.amazonaws.com/a/b.png"), {
    provider: "aws",
    endpoint: "https://s3.eu-west-1.amazonaws.com",
    bucket: "media",
    region: "eu-west-1",
    forcePathStyle: false,
  });
  assertEquals(parseS3Url("https://s3.sa-east-1.amazonaws.com/media").forcePathStyle, true);
  assertEquals(parseS3Url("media.s3.amazonaws.com").region, "us-east-1");
  const r2 = parseS3Url("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/files");
  assertEquals([r2.provider, r2.bucket, r2.region, r2.forcePathStyle], ["r2", "files", "auto", true]);
  const b2 = parseS3Url("https://bk.s3.us-west-004.backblazeb2.com");
  assertEquals([b2.provider, b2.endpoint, b2.bucket], ["b2", "https://s3.us-west-004.backblazeb2.com", "bk"]);
  const sp = parseS3Url("https://assets.fra1.digitaloceanspaces.com/x.jpg");
  assertEquals([sp.provider, sp.endpoint, sp.bucket, sp.region], [
    "spaces",
    "https://fra1.digitaloceanspaces.com",
    "assets",
    "fra1",
  ]);
  assertEquals(parseS3Url("http://localhost:9000/files"), {
    provider: "selfhosted",
    endpoint: "http://localhost:9000",
    bucket: "files",
    forcePathStyle: true,
  });
  assertEquals(parseS3Url("s3://backups"), { bucket: "backups" });
  assertEquals(parseS3Url("not a url"), null);
  assertEquals(parseS3Url(""), null);
});

Deno.test("detectProvider and objectUrl follow the endpoint and the addressing style", () => {
  assertEquals(detectProvider("https://s3.us-east-2.amazonaws.com"), { id: "aws", region: "us-east-2" });
  assertEquals(detectProvider("http://127.0.0.1:9000").id, "selfhosted");
  assertEquals(detectProvider("https://storage.example.com").id, "other");
  const cfg = { endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "b", forcePathStyle: false };
  assertEquals(objectUrl(cfg, "k.txt"), "https://b.s3.us-east-1.amazonaws.com/k.txt");
  assertEquals(objectUrl({ ...cfg, forcePathStyle: true }, "k.txt"), "https://s3.us-east-1.amazonaws.com/b/k.txt");
});

Deno.test("stepAdvice turns S3 codes into what to change", () => {
  const cfg = { endpoint: "http://localhost:9000", bucket: "files", forcePathStyle: false };
  assertEquals(stepAdvice({ id: "connect", code: "TypeError" }, cfg).includes("path-style"), true);
  assertEquals(
    stepAdvice({ id: "auth", code: "SignatureDoesNotMatch" }, cfg),
    "The secret does not match the access key.",
  );
  assertEquals(stepAdvice({ id: "bucket", code: "NoSuchBucket" }, cfg).includes('"files"'), true);
});
