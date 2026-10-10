import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { collectSpans } from "../testing/mod.ts";
import { runTask } from "../workers/mod.ts";

const TASK = new URL("../workers/testdata/tasks.ts", import.meta.url);

function setup() {
  const app = createApp({ db: new DatabaseSync(":memory:"), mailer: new MemoryMailer(), adminUiDir: false });
  return { app, collected: collectSpans(app) };
}

Deno.test("cron tracing: each run is a root `cron <id>` trace", async () => {
  const { app, collected } = setup();
  app.cron.add("relatorio", "* * * * *", () => app.tracer.span("work", undefined, () => {}));
  await app.cron.get("relatorio")!.run();
  const spans = collected.spans().filter((s) =>
    s.traceId === collected.spans().find((x) => x.name === "cron relatorio")?.traceId
  );
  const root = spans.find((s) => s.root)!;
  assertEquals([root.name, root.kind, root.attributes["cron.job.id"]], ["cron relatorio", 0, "relatorio"]);
  assertEquals(spans.find((s) => s.name === "work")!.parentId, root.id);
});

Deno.test("cron tracing: a failing job marks its trace error", async () => {
  const { app, collected } = setup();
  app.cron.add("quebra", "* * * * *", () => {
    throw new Error("falhou");
  });
  const err = console.error;
  console.error = () => {};
  try {
    await app.cron.get("quebra")!.run();
  } finally {
    console.error = err;
  }
  const root = collected.spans().find((s) => s.name === "cron quebra")!;
  assertEquals(root.status, 2);
});

Deno.test("cron tracing: a worker task is a child span and the worker receives the trace", async () => {
  const { app, collected } = setup();
  app.cron.addTask("eco", "* * * * *", TASK, () => ({ value: "x" }));
  await app.cron.get("eco")!.run();
  const spans = collected.spans();
  const root = spans.find((s) => s.name === "cron eco")!;
  const worker = spans.find((s) => s.name === "worker tasks")!;
  const inWorker = spans.find((s) => s.name === "task tasks")!;
  assertEquals(worker.parentId, root.id);
  assertEquals([inWorker.traceId, inWorker.parentId, inWorker.root], [root.traceId, worker.id, false]);
});

Deno.test("cron tracing: runTask outside a trace runs untraced", async () => {
  const { collected } = setup();
  assertEquals(await runTask(TASK, { value: "y" }), "echo:y");
  assertEquals(collected.spans(), []);
});

Deno.test("cron tracing: a worker task that throws still sends back its spans, error and exception included", async () => {
  const { app, collected } = setup();
  await app.tracer.span("root", undefined, () => runTask(TASK, { fail: true })).catch(() => {});
  const inWorker = collected.spans().find((s) => s.name === "task tasks")!;
  assertEquals([inWorker.status, inWorker.events.map((e) => e.name)], [2, ["exception"]]);
});
