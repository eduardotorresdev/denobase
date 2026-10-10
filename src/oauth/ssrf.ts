/** Outbound fetch of untrusted URLs (CIMD documents) without reaching the server's own network. */

function v4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Expands an IPv6 literal into 8 groups; null when it is not one. */
function v6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(":")) return null;
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two groups.
  const quad = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (quad) {
    const q = v4(quad[1]);
    if (!q) return null;
    s = s.slice(0, -quad[1].length) + `${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Loopback, private, link-local, CGNAT, multicast, unspecified, metadata (169.254/16), ULA (fc00::/7), link-local
 * v6 (fe80::/10), and v4-mapped/compatible/NAT64 forms of any of them. Anything unparseable counts as private.
 */
export function isPrivateIp(ip: string): boolean {
  const a = v4(ip);
  if (a) return privateV4(a);
  const g = v6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(embedded); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return false;
}

export interface SafeFetchOptions {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

async function resolveAll(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      out.push(...await Deno.resolveDns(host, type));
    } catch { /* no record of this type */ }
  }
  return out;
}

export class SsrfError extends Error {}

export interface FetchedDoc {
  status: number;
  headers: Headers;
  bodyText: string;
}

/**
 * GET an https URL on 443 whose host resolves only to public addresses, without following redirects, within
 * timeoutMs and maxBytes. Residual risk: Deno's fetch resolves again, so a rebinding between the two lookups is not
 * pinned; the short TTL window and the https certificate (which must match the name) keep that to a public host.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<FetchedDoc> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (u.protocol !== "https:") throw new SsrfError("only https");
  if (u.port && u.port !== "443") throw new SsrfError("only port 443");
  if (u.username || u.password) throw new SsrfError("credentials in url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const literal = v4(host) || v6(host);
  const ips = literal ? [host] : await (opts.resolve ?? resolveAll)(host);
  if (!ips.length) throw new SsrfError("host does not resolve");
  if (ips.some(isPrivateIp)) throw new SsrfError("host resolves to a private address");
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 5000);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(u.href, {
      redirect: "manual",
      signal,
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new SsrfError(signal.aborted ? "timeout" : `fetch failed: ${(e as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new SsrfError("redirects are not followed");
  }
  const max = opts.maxBytes ?? 5 * 1024;
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new SsrfError("document too large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof SsrfError) throw e;
    throw new SsrfError(signal.aborted ? "timeout" : "read failed");
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) bytes.set(c, (off += c.length) - c.length);
  return { status: res.status, headers: res.headers, bodyText: new TextDecoder().decode(bytes) };
}
