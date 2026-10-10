import { stamp } from "../core/time.ts";
import { validKey } from "./name.ts";

export interface BackupInfo {
  key: string;
  size: number;
  modified: string;
}

/** pb_data/backups: the zips, by key (file name). PB's backups filesystem, local only. */
export class BackupStore {
  constructor(readonly dir: string) {}

  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    try {
      for await (const e of Deno.readDir(this.dir)) {
        if (!e.isFile) continue;
        const st = await Deno.stat(`${this.dir}/${e.name}`);
        out.push({ key: e.name, size: st.size, modified: stamp(st.mtime ?? new Date(0)) });
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      return validKey(key) && (await Deno.stat(`${this.dir}/${key}`)).isFile;
    } catch {
      return false;
    }
  }

  read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    return Deno.readFile(`${this.dir}/${key}`);
  }

  /** Never overwrites: a taken key fails. */
  async write(key: string, data: Uint8Array): Promise<void> {
    await Deno.mkdir(this.dir, { recursive: true });
    await Deno.writeFile(`${this.dir}/${key}`, data, { createNew: true });
  }

  async delete(key: string): Promise<void> {
    await Deno.remove(`${this.dir}/${key}`);
  }
}
