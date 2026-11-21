/** The backup zip on its own: written by zipStream, read back by extract, whatever the bytes inside (X1). */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { extract } from "./archive.ts";
import { zipStream } from "./tasks/archive.ts";

const SIGS = [[0x50, 0x4b, 0x01, 0x02], [0x50, 0x4b, 0x07, 0x08], [0x50, 0x4b, 0x03, 0x04]];

function random(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(d.subarray(i, Math.min(n, i + 65536)));
  return d;
}

/** The low byte of an LCG: a periodic pattern fflate's streaming Deflate wrote invalid streams for. */
function periodic(n: number, seed: number): Uint8Array {
  let x = seed;
  return new Uint8Array(n).map(() => (x = (x * 1103515245 + 12345) & 0x7fffffff) & 0xff);
}

async function roundTrip(dir: string, files: Record<string, Uint8Array>): Promise<void> {
  const src = `${dir}/src`, out = `${dir}/out`;
  await Deno.mkdir(src, { recursive: true });
  const list: [string, string][] = [];
  for (const [name, data] of Object.entries(files)) {
    const path = `${src}/${name.replaceAll("/", "_")}`;
    await Deno.writeFile(path, data);
    list.push([name, path]);
  }
  await Deno.writeFile(`${dir}/b.zip`, zipStream(list, { bytes: 0 }));
  await extract(`${dir}/b.zip`, out);
  for (const [name, data] of Object.entries(files)) {
    const back = await Deno.readFile(`${out}/${name}`);
    assert(back.length === data.length && back.every((b, i) => b === data[i]), `${name} came back different`);
  }
  await Deno.remove(dir, { recursive: true });
  await Deno.mkdir(dir);
}

Deno.test("a valid zip whose deflated bytes carry zip signatures restores (regression: the streaming reader cut it)", async () => {
  const out = await Deno.makeTempDir();
  try {
    await extract(new URL("./testdata/signature_in_data.zip", import.meta.url).pathname, out);
    assertEquals([(await Deno.stat(`${out}/data.db`)).size, (await Deno.stat(`${out}/auxiliary.db`)).size], [
      49152,
      4096,
    ]);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("many backups of incompressible, signature-laden and periodic content all restore byte for byte", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (let i = 0; i < 60; i++) {
      const db = i % 3 === 2 ? periodic(4096 + i * 997, i + 1) : random(1024 + Math.floor(Math.random() * 400_000));
      // Signatures planted in the stored bytes at random places, as an incompressible upload carries by chance.
      for (let k = 0; k < 4 && db.length > 8; k++) db.set(SIGS[k % 3], Math.floor(Math.random() * (db.length - 4)));
      await roundTrip(dir, {
        "data.db": db,
        "auxiliary.db": periodic(8192, i * 7919 + 3),
        [`storage/c/${i}.bin`]: random(Math.floor(Math.random() * 70_000)),
        "empty.txt": new Uint8Array(0),
      });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a truncated or damaged backup zip is refused, never half restored", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(`${dir}/a.db`, random(100_000));
    await Deno.writeFile(`${dir}/b.zip`, zipStream([["data.db", `${dir}/a.db`]], { bytes: 0 }));
    const zip = await Deno.readFile(`${dir}/b.zip`);
    await Deno.writeFile(`${dir}/cut.zip`, zip.subarray(0, zip.length - 30));
    await assertRejects(() => extract(`${dir}/cut.zip`, `${dir}/o1`));
    const bad = zip.slice();
    bad[5000] ^= 0xff; // a flipped byte inside data.db's stored bytes: the CRC catches it
    await Deno.writeFile(`${dir}/bad.zip`, bad);
    await assertRejects(() => extract(`${dir}/bad.zip`, `${dir}/o2`), Error, "damaged");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
