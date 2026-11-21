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

Deno.test("a very compressible entry restores with bounded memory; one inflating past its declared size is refused early", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const size = 256 * 1024 * 1024; // zeros: what a db full of free pages looks like to deflate
    const f = await Deno.open(`${dir}/zeros`, { write: true, create: true });
    await f.truncate(size);
    f.close();
    await Deno.writeFile(`${dir}/z.zip`, zipStream([["data.db", `${dir}/zeros`]], { bytes: 0 }));
    const base = Deno.memoryUsage().rss;
    let peak = base;
    const probe = setInterval(() => (peak = Math.max(peak, Deno.memoryUsage().rss)), 5);
    try {
      await extract(`${dir}/z.zip`, `${dir}/o1`);
    } finally {
      clearInterval(probe);
    }
    assertEquals((await Deno.stat(`${dir}/o1/data.db`)).size, size);
    assert(peak - base < 96 * 1024 * 1024, `peak grew ${Math.round((peak - base) / 2 ** 20)} MiB`);

    // The same entry claiming 10 bytes in the central directory: refused before it writes more than a push's worth.
    const zip = await Deno.readFile(`${dir}/z.zip`);
    const cd = zip.lastIndexOf(0x50, zip.length - 22 - 3);
    let at = -1;
    for (let i = cd; i >= 0; i--) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
        at = i;
        break;
      }
    }
    new DataView(zip.buffer).setUint32(at + 24, 10, true);
    await Deno.writeFile(`${dir}/bomb.zip`, zip);
    await assertRejects(() => extract(`${dir}/bomb.zip`, `${dir}/o2`), Error, "larger than it declares");
    await assertRejects(() => Deno.stat(`${dir}/o2/data.db`), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a 0.3.0 backup whose deflate references bytes before its start restores (zero dictionary, CRC checked)", async () => {
  const out = await Deno.makeTempDir();
  try {
    await extract(new URL("./testdata/old_writer_0_3_0.zip", import.meta.url).pathname, out);
    assertEquals((await Deno.stat(`${out}/data.db`)).size, 4096);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
