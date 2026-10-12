import { extract } from "../archive.ts";

export interface ExtractInput {
  /** The zip, already downloaded next to pb_data (pb_data/.pb_temp_to_delete). */
  zip: string;
  dir: string;
}

/** Worker task: unzip a backup into dir, streaming (inflate is the CPU-heavy part of a restore). */
export default async function extractTask(input: ExtractInput): Promise<void> {
  await extract(input.zip, input.dir);
}
