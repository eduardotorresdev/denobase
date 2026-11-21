/** The socket file a serve listens on for service calls, in pb_data: kept out of backups and of a restore swap. */
export const SOCKET_PREFIX = ".svc-";

/** sun_path is 108 bytes on Linux, 104 on macOS (with the NUL): a longer path cannot be bound at all (B4). */
const SUN_MAX = 100;

/** The private temp dirs a too-deep pb_data falls back to. */
const TMP_PREFIX = "dnb-";

const enc = new TextEncoder();

/**
 * Where this process listens: `<pb_data>/.svc-<pid>.sock`; when that path does not fit a socket address, a private
 * (0700) dir of its own under the system temp dir. The real path goes in `_services.addr` either way.
 */
export function socketPath(dir: string): string {
  const inData = `${dir}/${SOCKET_PREFIX}${Deno.pid}.sock`;
  if (enc.encode(inData).length <= SUN_MAX) return inData;
  const tmp = Deno.makeTempDirSync({ prefix: TMP_PREFIX });
  Deno.chmodSync(tmp, 0o700);
  return `${tmp}/${SOCKET_PREFIX}${Deno.pid}.sock`;
}

/** Whether a process still listens on `path`: a connect is answered by any OS; refused or missing means dead. */
async function listening(path: string): Promise<boolean> {
  try {
    (await Deno.connect({ transport: "unix", path })).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the sockets of processes that died without closing them, in `dir` (pb_data) and the private temp dirs
 * (`dnb-*`) a too-deep pb_data falls back to: every OS, by trying to connect (no /proc needed).
 */
export async function sweepSockets(dir: string): Promise<void> {
  const dead = async (path: string) => !(await listening(path));
  try {
    for (const e of Deno.readDirSync(dir)) {
      const m = e.name.match(/^\.svc-(\d+)\.sock$/);
      const path = `${dir}/${e.name}`;
      if (m && Number(m[1]) !== Deno.pid && (await dead(path))) {
        await Deno.remove(path).catch(() => {});
      }
    }
  } catch { /* no dir */ }
  let tmp: string;
  try {
    const probe = Deno.makeTempDirSync({ prefix: "dnb-probe-" });
    tmp = probe.slice(0, probe.lastIndexOf("/"));
    Deno.removeSync(probe);
  } catch {
    return;
  }
  try {
    for (const e of Deno.readDirSync(tmp)) {
      if (!e.isDirectory || !e.name.startsWith(TMP_PREFIX)) continue;
      const d = `${tmp}/${e.name}`;
      let socks: string[];
      try {
        socks = [...Deno.readDirSync(d)].map((x) => x.name);
      } catch {
        continue; // another user's: not ours to judge
      }
      if (socks.some((n) => !/^\.svc-\d+\.sock$/.test(n))) continue; // not a socket dir of ours
      // An empty one may be a serve between making it and binding: only once it is old.
      if (!socks.length && Date.now() - (Deno.statSync(d).mtime?.getTime() ?? 0) < 60_000) continue;
      const live = await Promise.all(socks.map((n) => listening(`${d}/${n}`)));
      if (!live.some(Boolean)) await Deno.remove(d, { recursive: true }).catch(() => {});
    }
  } catch { /* no temp dir */ }
}
