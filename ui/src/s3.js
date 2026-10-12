/**
 * S3 connection logic for the storage editor (src/s3connect.js): providers, reading a pasted bucket URL, and the URL an
 * object ends up at. No DOM, so it is tested on its own.
 */

/**
 * Providers the editor offers. `endpoint(p)` builds the endpoint from the provider's own inputs (region, account), so
 * a user picks names they know instead of typing hosts. `regions` feeds the region picker; absent = free text.
 */
export const PROVIDERS = [
  {
    id: "aws",
    label: "Amazon S3",
    endpoint: (p) => `https://s3.${p.region || "us-east-1"}.amazonaws.com`,
    pathStyle: false,
    regions: [
      "us-east-1",
      "us-east-2",
      "us-west-1",
      "us-west-2",
      "ca-central-1",
      "sa-east-1",
      "eu-west-1",
      "eu-west-2",
      "eu-west-3",
      "eu-central-1",
      "eu-north-1",
      "eu-south-1",
      "ap-south-1",
      "ap-northeast-1",
      "ap-northeast-2",
      "ap-southeast-1",
      "ap-southeast-2",
      "af-south-1",
      "me-south-1",
    ],
    keyHint: "IAM user with s3:ListBucket, GetObject, PutObject and DeleteObject on the bucket.",
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    // No endpoint until the account id is known: a placeholder host would only fail the check.
    endpoint: (p) => p.account ? `https://${p.account}.r2.cloudflarestorage.com` : "",
    fixedRegion: "auto",
    pathStyle: true,
    account: true,
    keyHint: "R2 > Manage API tokens: an Object Read & Write token scoped to the bucket.",
  },
  {
    id: "b2",
    label: "Backblaze B2",
    endpoint: (p) => `https://s3.${p.region || "us-west-004"}.backblazeb2.com`,
    pathStyle: false,
    regions: ["us-west-000", "us-west-001", "us-west-002", "us-west-004", "us-east-005", "eu-central-003"],
    keyHint: "Application Keys: the keyID is the access key, the applicationKey the secret.",
  },
  {
    id: "spaces",
    label: "DigitalOcean Spaces",
    endpoint: (p) => `https://${p.region || "nyc3"}.digitaloceanspaces.com`,
    pathStyle: false,
    regions: ["nyc3", "sfo2", "sfo3", "ams3", "fra1", "lon1", "sgp1", "syd1", "blr1", "tor1", "atl1"],
    keyHint: "API > Spaces Keys.",
  },
  {
    id: "selfhosted",
    label: "MinIO · self-hosted",
    pathStyle: true,
    keyHint: "The access key and secret of a user with read and write on the bucket.",
  },
  {
    id: "other",
    label: "Other S3-compatible",
    keyHint: "The access key and secret of the provider.",
  },
];

export const provider = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS.at(-1);

const hostOf = (endpoint) => {
  if (!endpoint) return "";
  try {
    return new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Hosts a bucket subdomain can't resolve on (the server's check suggests the same). */
export const needsPathStyle = (endpoint) => {
  const h = hostOf(endpoint);
  return h === "localhost" || /^[\d.]+$/.test(h) || h.startsWith("[") || (!!h && !h.includes("."));
};

/** Which provider an endpoint belongs to, with the inputs the provider builds it from. */
export function detectProvider(endpoint) {
  const h = hostOf(endpoint);
  let m;
  if (!h) return { id: "aws" };
  if ((m = h.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/))) return { id: "aws", region: m[1] };
  if (h === "s3.amazonaws.com") return { id: "aws", region: "us-east-1" };
  if ((m = h.match(/^([a-f0-9]{32})\.(?:[a-z]+\.)?r2\.cloudflarestorage\.com$/))) return { id: "r2", account: m[1] };
  if ((m = h.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/))) return { id: "b2", region: m[1] };
  if ((m = h.match(/^([a-z0-9]+)\.digitaloceanspaces\.com$/))) return { id: "spaces", region: m[1] };
  if (needsPathStyle(endpoint) || /minio|rustfs|garage|seaweed/.test(h)) return { id: "selfhosted" };
  return { id: "other" };
}

/**
 * Reads whatever a user copies from a provider console: an s3:// URI, a virtual-host or path-style bucket URL, an
 * object URL, or a bare endpoint. Returns the settings it pins down plus the provider; null when it is not a URL.
 */
export function parseS3Url(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let m;
  if ((m = raw.match(/^s3:\/\/([^/\s]+)/i))) return { bucket: m[1] };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") && h !== "localhost") return null;
  const firstSeg = decodeURIComponent(u.pathname.split("/").filter(Boolean)[0] || "");
  const origin = `${u.protocol}//${u.host}`;

  // AWS: <bucket>.s3.<region>.amazonaws.com, <bucket>.s3.amazonaws.com, s3.<region>.amazonaws.com/<bucket>.
  if ((m = h.match(/^(.+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/))) {
    return out("aws", `https://s3.${m[2]}.amazonaws.com`, m[1], m[2], false);
  }
  if ((m = h.match(/^(.+)\.s3\.amazonaws\.com$/))) {
    return out("aws", "https://s3.us-east-1.amazonaws.com", m[1], "us-east-1", false);
  }
  if ((m = h.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/))) {
    return out("aws", `https://s3.${m[1]}.amazonaws.com`, firstSeg, m[1], !!firstSeg);
  }
  // R2: <account>.r2.cloudflarestorage.com/<bucket> (also the eu/fedramp jurisdictions).
  if ((m = h.match(/^([a-f0-9]{32})\.((?:[a-z]+\.)?r2\.cloudflarestorage\.com)$/))) {
    return out("r2", `https://${m[1]}.${m[2]}`, firstSeg, "auto", true);
  }
  // B2: <bucket>.s3.<region>.backblazeb2.com or s3.<region>.backblazeb2.com/<bucket>.
  if ((m = h.match(/^(.+)\.s3\.([a-z0-9-]+)\.backblazeb2\.com$/))) {
    return out("b2", `https://s3.${m[2]}.backblazeb2.com`, m[1], m[2], false);
  }
  if ((m = h.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/))) {
    return out("b2", `https://s3.${m[1]}.backblazeb2.com`, firstSeg, m[1], false);
  }
  // Spaces: <bucket>.<region>.digitaloceanspaces.com or <region>.digitaloceanspaces.com/<bucket>.
  if ((m = h.match(/^(.+)\.([a-z]+\d)\.digitaloceanspaces\.com$/))) {
    return out("spaces", `https://${m[2]}.digitaloceanspaces.com`, m[1], m[2], false);
  }
  if ((m = h.match(/^([a-z]+\d)\.digitaloceanspaces\.com$/))) {
    return out("spaces", `https://${m[1]}.digitaloceanspaces.com`, firstSeg, m[1], false);
  }
  // Anything else: the first path segment is the bucket (path style), as MinIO and most self-hosted servers show it.
  const id = detectProvider(origin).id;
  return out(id, origin, firstSeg, undefined, true);

  function out(id, endpoint, bucket, region, pathStyle) {
    const r = { provider: id, endpoint };
    if (bucket) r.bucket = bucket;
    if (region) r.region = region;
    r.forcePathStyle = pathStyle || needsPathStyle(endpoint);
    return r;
  }
}

/** The URL `key` lives at with this config: what path style vs virtual host changes, shown before saving. */
export function objectUrl(cfg, key) {
  const endpoint = (cfg.endpoint || "").trim() || `https://s3.${cfg.region || "us-east-1"}.amazonaws.com`;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
  } catch {
    return "";
  }
  const bucket = cfg.bucket || "<bucket>";
  const base = u.pathname.replace(/\/$/, "");
  return cfg.forcePathStyle
    ? `${u.protocol}//${u.host}${base}/${bucket}/${key}`
    : `${u.protocol}//${bucket}.${u.host}${base}/${key}`;
}

/** Every field the server needs to try a draft (an empty secret may be the saved one: the server decides). */
export const checkable = (cfg) => !!(cfg.endpoint && cfg.bucket && cfg.region && cfg.accessKey);

export const STEPS = [
  ["connect", "Reach"],
  ["auth", "Sign in"],
  ["bucket", "Bucket"],
  ["write", "Write"],
  ["read", "Read back"],
  ["cleanup", "Clean up"],
];

/** What a failed step means for the person fixing it, from the step and the S3 error code. */
export function stepAdvice(step, cfg) {
  const code = step.code || "";
  if (step.id === "connect") {
    if (code === "Timeout") return "The endpoint did not answer. Check the host, the port and any firewall.";
    if (!cfg.forcePathStyle && needsPathStyle(cfg.endpoint)) {
      return "This host has no DNS for bucket subdomains: turn on path-style addressing.";
    }
    return "Could not reach the endpoint. Check the URL and that the server is up.";
  }
  if (code === "InvalidAccessKeyId") return "The provider does not know this access key.";
  if (code === "SignatureDoesNotMatch") return "The secret does not match the access key.";
  if (code === "AuthorizationHeaderMalformed" || code === "PermanentRedirect") {
    return "The bucket lives in another region.";
  }
  if (code === "NoSuchBucket") {
    return `There is no bucket "${cfg.bucket}" at this endpoint. Create it, or fix the name.`;
  }
  if (code === "AccessDenied") {
    return step.id === "bucket"
      ? "Signed in, but these keys may not list the bucket."
      : "These keys may not do this. Grant read, write and delete on the bucket.";
  }
  if (step.id === "read" && code === "Mismatch") return "The object read back was not the one written.";
  return "";
}
