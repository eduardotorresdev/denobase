import { assertEquals } from "@std/assert";
import { canResume, planQuestion, progressLine, progressPercent, statusBadge, whenLine } from "./migration.js";

const state = (o) => ({
  status: "running",
  stalled: false,
  total: 0,
  processed: 0,
  copied: 0,
  skipped: 0,
  failed: 0,
  bytes: 0,
  updated: "",
  finished: "",
  ...o,
});

Deno.test("the dialog asks with the count, size and both storages", () => {
  assertEquals(
    planQuestion({ toCopy: 1234, bytes: 5 * 1024 * 1024, from: "local", to: "s3:b@http://x" }),
    "Migrate 1,234 files (5.0 MB) from local storage to S3 b@http://x?",
  );
  assertEquals(
    planQuestion({ toCopy: 1, bytes: 0, from: "s3:a@r", to: "local" }).startsWith("Migrate 1 file (0 B)"),
    true,
  );
});

Deno.test("progress, status and resume follow the job state", () => {
  assertEquals(progressPercent(state({ total: 0 })), 0);
  assertEquals(progressPercent(state({ total: 3, processed: 2 })), 66);
  assertEquals(progressPercent(state({ status: "done" })), 100);
  assertEquals(
    progressLine(state({ total: 3, processed: 2, copied: 1, skipped: 0, failed: 1, bytes: 2048 })),
    "2 of 3 files · 1 copied · 0 already there · 1 failed · 2.0 KB",
  );
  assertEquals(statusBadge(state({ stalled: true })), ["stalled", "warning"]);
  assertEquals(canResume(state({})), false);
  assertEquals(canResume(state({ stalled: true })), true);
  assertEquals(canResume(state({ status: "failed" })), true);
  assertEquals(canResume(null), false);
  // UTC until settings load: shown in the app timezone, never the browser's.
  assertEquals(whenLine(state({ finished: "2026-10-11 10:00:00.000Z" })), "Finished 2026-10-11 10:00:00");
});
