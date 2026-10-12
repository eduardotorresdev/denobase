/**
 * A staged S3 connection check for the admin UI: where PB's test answers pass/fail, this says which step broke
 * (network, credentials, bucket, write, read, clean up) and, when the server's answer tells, what to change.
 */
import type { S3Config } from "../../settings/model.ts";
import { S3Client, xmlOne } from "./client.ts";

export type CheckStepId = "connect" | "auth" | "bucket" | "write" | "read" | "cleanup";

export interface CheckStep {
  id: CheckStepId;
  status: "ok" | "fail" | "skip";
  ms: number;
  /** S3 error code or a network error name, on fail. */
  code?: string;
  message?: string;
}

export interface CheckResult {
  ok: boolean;
  steps: CheckStep[];
  /** Settings the server's answer points to (the bucket's real region, path style for a host without DNS). */
  suggest?: Partial<Pick<S3Config, "region" | "forcePathStyle">>;
}

const ORDER: CheckStepId[] = ["connect", "auth", "bucket", "write", "read", "cleanup"];

const TIMEOUT_MS = 8000;

/** Hosts a bucket subdomain can't resolve on: virtual-host style never works there. */
function needsPathStyle(endpoint: string): boolean {
  try {
    const host = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`).hostname;
    return host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[") || !host.includes(".");
  } catch {
    return false;
  }
}

export async function checkS3(cfg: S3Config, fetcher: typeof fetch = fetch): Promise<CheckResult> {
  const timed: typeof fetch = (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const steps: CheckStep[] = [];
  const out: CheckResult = { ok: false, steps };
  let t0 = performance.now();
  const lap = () => {
    const now = performance.now();
    const ms = Math.round(now - t0);
    t0 = now;
    return ms;
  };
  const done = (id: CheckStepId, ms = 0) => steps.push({ id, status: "ok", ms });
  const fail = (id: CheckStepId, code: string, message: string, ms = 0) => {
    steps.push({ id, status: "fail", ms, code, message });
    for (const rest of ORDER.slice(ORDER.indexOf(id) + 1)) steps.push({ id: rest, status: "skip", ms: 0 });
    return out;
  };

  let client: S3Client;
  try {
    client = new S3Client(cfg, timed);
  } catch {
    return fail("connect", "InvalidEndpoint", `"${cfg.endpoint}" is not a URL.`);
  }

  // One signed ListObjectsV2 tells network, credentials and bucket apart before anything is written.
  let res: Response;
  try {
    res = await client.send({ method: "GET", query: [["list-type", "2"], ["max-keys", "1"]] }, [
      301,
      400,
      403,
      404,
    ]);
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "TimeoutError";
    if (!cfg.forcePathStyle && needsPathStyle(cfg.endpoint)) out.suggest = { forcePathStyle: true };
    return fail(
      "connect",
      timeout ? "Timeout" : err.name,
      timeout ? `No answer in ${TIMEOUT_MS / 1000}s.` : err.message,
      lap(),
    );
  }
  done("connect", lap());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = xmlOne(text, "Code") ?? (res.status === 404 ? "NoSuchBucket" : `HTTP${res.status}`);
    const message = xmlOne(text, "Message") ?? res.statusText;
    // AWS names the bucket's region in a wrong-region answer: header on 301, <Region> on AuthorizationHeaderMalformed.
    const region = res.headers.get("x-amz-bucket-region") ?? xmlOne(text, "Region");
    if (region && region !== cfg.region) out.suggest = { region };
    // Signed in but the bucket is missing or closed to these keys: credentials themselves are fine.
    const bucketProblem = !out.suggest && (res.status === 404 || code === "AccessDenied");
    if (!bucketProblem) return fail("auth", code, message);
    done("auth");
    return fail("bucket", code, message);
  }
  await res.body?.cancel();
  done("auth");
  done("bucket");

  const key = `pb_settings_test/${crypto.randomUUID().slice(0, 8)}.txt`;
  const probe = new TextEncoder().encode(`denobase ${new Date().toISOString()}`);
  const step = async (id: CheckStepId, run: () => Promise<void>) => {
    try {
      await run();
      done(id, lap());
      return true;
    } catch (e) {
      const err = e as Error & { code?: string };
      fail(id, err.code ?? err.name, err.message, lap());
      return false;
    }
  };
  if (
    !await step("write", async () => {
      (await client.send({ method: "PUT", key, headers: { "content-type": "text/plain" }, body: probe })).body
        ?.cancel();
    })
  ) return out;
  const read = await step("read", async () => {
    const got = new Uint8Array(await (await client.send({ method: "GET", key })).arrayBuffer());
    if (got.byteLength !== probe.byteLength || got.some((b, i) => b !== probe[i])) {
      throw Object.assign(new Error("The object read back differs from the one written."), { code: "Mismatch" });
    }
  });
  // Clean up even after a failed read: the probe must never stay in the bucket.
  if (!read) {
    await client.send({ method: "DELETE", key }).then((r) => r.body?.cancel(), () => {});
    return out;
  }
  if (!await step("cleanup", async () => (await client.send({ method: "DELETE", key })).body?.cancel())) return out;
  out.ok = true;
  return out;
}
