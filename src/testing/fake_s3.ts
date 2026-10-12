/**
 * An in-process S3 for tests: Deno.serve on a free port, SigV4 checked against the configured keys, objects in memory.
 * It speaks the calls S3Storage makes (PUT/GET with Range/HEAD/DELETE object, ListObjectsV2, DeleteObjects, multipart),
 * with S3's status codes and XML, so the client is exercised over real HTTP without Docker.
 */
import type { S3Config } from "../settings/model.ts";
import { signature } from "../files/s3/sigv4.ts";
import { xmlAll, xmlEscape } from "../files/s3/client.ts";

export interface FakeS3Object {
  data: Uint8Array;
  type: string;
  modified: Date;
}

export interface FakeS3Request {
  method: string;
  key: string;
  query: Record<string, string>;
}

export interface FakeS3Options {
  bucket?: string;
  region?: string;
  accessKey?: string;
  secret?: string;
  /** ListObjectsV2 page size cap, small to exercise pagination. */
  maxKeys?: number;
  /** S3's 5MB minimum for every part but the last; lowered for tests that drive multipart with small bodies. */
  minPartSize?: number;
}

export interface FakeS3 {
  /** http://127.0.0.1:<port> */
  readonly endpoint: string;
  /** A ready settings.s3 (enabled, path style) pointing here. */
  readonly config: S3Config;
  readonly objects: Map<string, FakeS3Object>;
  /** Multipart uploads begun and neither completed nor aborted. */
  readonly uploads: Map<string, { key: string; parts: Map<number, Uint8Array> }>;
  /** Every request that passed authentication, in order. */
  readonly requests: FakeS3Request[];
  /** Return a status to fail a matching request with (S3 "InternalError"), or nothing to serve it. */
  failWhen?: (r: FakeS3Request) => number | undefined;
  close(): Promise<void>;
}

function xmlError(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${
      xmlEscape(message)
    }</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

function xml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

function etag(): string {
  return `"${crypto.randomUUID().replaceAll("-", "")}"`;
}

export function startFakeS3(opts: FakeS3Options = {}): FakeS3 {
  const bucket = opts.bucket ?? "test-bucket";
  const region = opts.region ?? "us-east-1";
  const accessKey = opts.accessKey ?? "AKIAFAKE";
  const secret = opts.secret ?? "fake-secret";
  const maxKeys = opts.maxKeys ?? 1000;
  const minPart = opts.minPartSize ?? 5 * 1024 * 1024;
  const objects = new Map<string, FakeS3Object>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const requests: FakeS3Request[] = [];

  async function authorized(req: Request, url: URL, body: Uint8Array): Promise<Response | null> {
    const auth = req.headers.get("authorization") ?? "";
    const m = auth.match(
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/,
    );
    if (!m) return xmlError(403, "AccessDenied", "missing or malformed SigV4 authorization");
    const [, key, , reg, signedHeaders, sig] = m;
    if (key !== accessKey) return xmlError(403, "InvalidAccessKeyId", "unknown access key");
    if (reg !== region) return xmlError(400, "AuthorizationHeaderMalformed", `region must be ${region}`);
    const date = req.headers.get("x-amz-date") ?? "";
    const payloadHash = req.headers.get("x-amz-content-sha256") ?? "";
    if (payloadHash !== "UNSIGNED-PAYLOAD") {
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      if (actual !== payloadHash) return xmlError(400, "XAmzContentSHA256Mismatch", "payload hash mismatch");
    }
    const headers: Record<string, string> = {};
    for (const h of signedHeaders.split(";")) headers[h] = req.headers.get(h) ?? "";
    const expected = await signature({
      method: req.method,
      path: url.pathname,
      query: [...url.searchParams],
      headers,
      payloadHash,
      amzDate: date,
      region,
      accessKey,
      secret,
    });
    if (expected.signature !== sig) {
      return xmlError(403, "SignatureDoesNotMatch", "The request signature we calculated does not match");
    }
    return null;
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    const denied = await authorized(req, url, body);
    if (denied) return denied;
    // Path style (/<bucket>/<key>), or virtual-host style when Host starts with the bucket.
    const host = (req.headers.get("host") ?? "").split(":")[0];
    let path = url.pathname;
    if (host.startsWith(`${bucket}.`)) path = `/${bucket}${path}`;
    const segs = path.slice(1).split("/");
    if (decodeURIComponent(segs[0]) !== bucket) {
      return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");
    }
    const key = segs.slice(1).map(decodeURIComponent).join("/");
    const q = Object.fromEntries(url.searchParams);
    const r: FakeS3Request = { method: req.method, key, query: q };
    requests.push(r);
    const fail = fakeS3.failWhen?.(r);
    if (fail) return xmlError(fail, "InternalError", "injected failure");

    if (!key) {
      if (req.method === "GET" && q["list-type"] === "2") return list(q);
      if (req.method === "POST" && "delete" in q) return deleteMany(req, body);
      return xmlError(405, "MethodNotAllowed", "bucket operation not implemented by the fake");
    }
    if (req.method === "POST" && "uploads" in q) {
      const id = crypto.randomUUID();
      uploads.set(id, { key, parts: new Map() });
      objectsType.set(id, req.headers.get("content-type") ?? "");
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${
          xmlEscape(key)
        }</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if ("uploadId" in q) {
      const up = uploads.get(q.uploadId);
      if (!up || up.key !== key) return xmlError(404, "NoSuchUpload", "The specified upload does not exist");
      if (req.method === "PUT") {
        up.parts.set(Number(q.partNumber), body);
        return new Response(null, { headers: { etag: `"part-${q.partNumber}"` } });
      }
      if (req.method === "DELETE") {
        uploads.delete(q.uploadId);
        objectsType.delete(q.uploadId);
        return new Response(null, { status: 204 });
      }
      if (req.method === "POST") {
        const nums = xmlAll(new TextDecoder().decode(body), "PartNumber").map(Number);
        const chunks: Uint8Array[] = [];
        for (const [i, n] of nums.entries()) {
          const p = up.parts.get(n);
          if (!p) return xmlError(400, "InvalidPart", `part ${n} was not uploaded`);
          if (i < nums.length - 1 && p.byteLength < minPart) {
            return xmlError(400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed size");
          }
          chunks.push(p);
        }
        const data = new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
        objects.set(key, { data, type: objectsType.get(q.uploadId) ?? "", modified: new Date() });
        uploads.delete(q.uploadId);
        objectsType.delete(q.uploadId);
        return xml(
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${
            xmlEscape(key)
          }</Key><ETag>${etag()}</ETag></CompleteMultipartUploadResult>`,
        );
      }
    }
    switch (req.method) {
      case "PUT":
        objects.set(key, { data: body, type: req.headers.get("content-type") ?? "", modified: new Date() });
        return new Response(null, { headers: { etag: etag() } });
      case "DELETE":
        objects.delete(key);
        return new Response(null, { status: 204 });
      case "HEAD":
      case "GET": {
        const o = objects.get(key);
        if (!o) {
          return req.method === "HEAD"
            ? new Response(null, { status: 404 })
            : xmlError(404, "NoSuchKey", "The specified key does not exist.");
        }
        const headers: Record<string, string> = {
          "last-modified": o.modified.toUTCString(),
          "accept-ranges": "bytes",
          ...(o.type ? { "content-type": o.type } : {}),
        };
        const size = o.data.byteLength;
        const range = req.method === "GET" ? req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/) : null;
        if (range) {
          const start = Number(range[1]);
          if (start >= size) {
            return xmlError(416, "InvalidRange", "The requested range is not satisfiable");
          }
          const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
          return new Response(o.data.slice(start, end + 1), {
            status: 206,
            headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
          });
        }
        if (req.method === "HEAD") {
          return new Response(null, { headers: { ...headers, "content-length": String(size) } });
        }
        return new Response(o.data.slice(), { headers });
      }
    }
    return xmlError(405, "MethodNotAllowed", "not implemented by the fake");
  }

  function list(q: Record<string, string>): Response {
    const prefix = q.prefix ?? "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const after = q["continuation-token"] ? atob(q["continuation-token"]) : "";
    const rest = keys.filter((k) => k > after);
    const page = rest.slice(0, Math.min(maxKeys, Number(q["max-keys"] ?? 1000)));
    const truncated = page.length < rest.length;
    const contents = page.map((k) => {
      const o = objects.get(k)!;
      return `<Contents><Key>${
        xmlEscape(k)
      }</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>"x"</ETag><Size>${o.data.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    }).join("");
    return xml(
      `<ListBucketResult><Name>${bucket}</Name><Prefix>${
        xmlEscape(prefix)
      }</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${
        truncated ? `<NextContinuationToken>${btoa(page.at(-1)!)}</NextContinuationToken>` : ""
      }${contents}</ListBucketResult>`,
    );
  }

  async function deleteMany(req: Request, body: Uint8Array): Promise<Response> {
    const md5 = req.headers.get("content-md5");
    if (!md5) return xmlError(400, "InvalidRequest", "Missing required header for this request: Content-MD5");
    const { createHash } = await import("node:crypto");
    if (createHash("md5").update(body).digest("base64") !== md5) {
      return xmlError(400, "BadDigest", "The Content-MD5 you specified did not match what we received.");
    }
    const keys = xmlAll(new TextDecoder().decode(body), "Key");
    if (keys.length > 1000) return xmlError(400, "MalformedXML", "more than 1000 keys");
    for (const k of keys) objects.delete(k);
    return xml(`<DeleteResult></DeleteResult>`);
  }

  const objectsType = new Map<string, string>();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handle);
  const endpoint = `http://127.0.0.1:${server.addr.port}`;
  const fakeS3: FakeS3 = {
    endpoint,
    config: { enabled: true, bucket, region, endpoint, accessKey, secret, forcePathStyle: true },
    objects,
    uploads,
    requests,
    close: () => server.shutdown(),
  };
  return fakeS3;
}
