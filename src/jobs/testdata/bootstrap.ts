// The bootstrap a consumer hands app.jobs.use: collections, hooks, job definitions and a setup for the worker's app.
import { defineCollection } from "../../core/define.ts";
import { registerCollections } from "../../core/registry.ts";
import type { App } from "../../app.ts";
import { defineJob } from "../context.ts";
import { inJobWorker, onMain } from "../on_main.ts";

/** Where hooks ran, as each thread saw it: hooks run in the thread that writes. */
export const observed = { hooks: [] as string[], setup: 0 };

export const jb_items = defineCollection({
  slug: "jb_items",
  fields: [{ name: "nome", type: "text", required: true }, { name: "n", type: "number" }],
  access: { read: () => true },
  hooks: {
    afterChange: [() => void observed.hooks.push(inJobWorker() ? "worker" : "main")],
  },
});
registerCollections(jb_items);

/** A unit that needs the main thread's singleton (here, a counter only the main thread holds). */
export const enviados: string[] = [];
export const enviar = onMain("jb.enviar", (_store, texto: string) => {
  enviados.push(texto);
  return inJobWorker() ? "worker" : "main";
});

/** The worker's app is set up like the served one, minus the singletons. */
export default function setup(_app: App): void {
  observed.setup++;
}

defineJob("jb_criar", async (ctx) => {
  const n = (ctx.input as { n: number }).n;
  await ctx.span("criar", { n }, async () => {
    for (let i = 0; i < n; i++) await ctx.store.collection(jb_items).create({ nome: `i${i}`, n: i });
  });
  ctx.record({ "jb.criados": n });
  return { hooks: [...observed.hooks], setup: observed.setup, inWorker: ctx.inWorker };
});

defineJob("jb_apagar", async (ctx) => {
  for (const r of await ctx.store.collection(jb_items).find()) await ctx.store.collection(jb_items).delete(r.id);
});

defineJob("jb_enviar", async (ctx) => await enviar(ctx.store, "oi"));

defineJob("jb_escrever", async (ctx) => {
  // Short transactions, as jobs write: one row each, many times, while another thread writes too.
  const { n, prefixo } = ctx.input as { n: number; prefixo: string };
  for (let i = 0; i < n; i++) await ctx.store.collection(jb_items).create({ nome: `${prefixo}${i}` });
});

defineJob("jb_lento", async (ctx) => {
  await new Promise((r) => setTimeout(r, (ctx.input as { ms: number }).ms));
  return "ok";
});

defineJob("jb_falha", () => {
  throw new Error("falhou no worker");
});

defineJob("jb_crash", () => {
  // An error no one catches: the worker dies.
  setTimeout(() => {
    throw new Error("boom");
  }, 0);
  return new Promise(() => {});
});
