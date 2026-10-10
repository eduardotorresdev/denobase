import { z } from "zod";
import type { McpHost } from "../host.ts";

/** Platform prompts (no domain): scripts over the built-in tools. */
export function builtinPrompts(host: McpHost, p: string): void {
  host.prompt({
    name: "explorar-collection",
    title: "Explore a collection",
    description: "Schema, a sample of records and what the caller may do on one collection.",
    args: z.object({ collection: z.string().describe("Collection name.") }),
    render: ({ collection }) =>
      [
        `Explore the collection "${collection}" of this denobase server:`,
        `1. Read the resource schema://collections/${collection} (or call ${p}collections with name="${collection}").`,
        `2. Call ${p}list with collection="${collection}", perPage=5, sort="-created" for a sample.`,
        `3. Summarize the fields (type, required, relations) and what the sample says about real usage.`,
        "4. Say which operations the caller can do (read worked? try nothing destructive) and what is denied.",
      ].join("\n"),
  });

  host.prompt({
    name: "investigar-erro",
    title: "Investigate errors",
    description: "Recent errors in the logs, grouped and explained (superuser).",
    visibility: "superuser",
    args: z.object({ desde: z.string().optional().describe("ISO date to start from, e.g. 2026-01-01 00:00:00.") }),
    render: ({ desde }) => {
      const since = desde ? ` && created >= '${desde.replaceAll("'", "")}'` : "";
      return [
        "Investigate recent errors on this denobase server:",
        `1. Call ${p}logs op="stats" filter="level >= 8${since}" to see when errors spiked.`,
        `2. Call ${p}logs op="list" filter="level >= 8${since}" perPage=50.`,
        "3. Group by message/url/status; for each group show count, first/last time and a likely cause.",
        `4. Open the worst ones with ${p}logs op="get" and propose the next check.`,
      ].join("\n");
    },
  });

  host.prompt({
    name: "auditar-acesso",
    title: "Audit access",
    description: "Reads a collection's rules and checks them against what the caller really gets (superuser).",
    visibility: "superuser",
    args: z.object({ collection: z.string() }),
    render: ({ collection }) =>
      [
        `Audit the access rules of "${collection}":`,
        `1. Call ${p}collections name="${collection}" full=true and read listRule/viewRule/createRule/updateRule/` +
        "deleteRule.",
        `2. Call ${p}list on it and compare what comes back with what the rules should allow.`,
        "3. Point out rules that are open (empty), superuser-only (null) or depend on fields a user can set.",
      ].join("\n"),
  });
}
