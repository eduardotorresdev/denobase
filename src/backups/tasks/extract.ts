import { extract } from "../archive.ts";

export interface ExtractInput {
  zip: string;
  dir: string;
}

/** Worker task: unzip a backup into dir (inflate is the CPU-heavy part of a restore). */
export default async function extractTask(input: ExtractInput): Promise<void> {
  await extract(await Deno.readFile(input.zip), input.dir);
}
