import { assert, assertEquals } from "@std/assert";
import { Cron } from "./cron.ts";
import { isTimeZone, Schedule } from "./schedule.ts";

Deno.test("schedule matches the wall clock of the given timezone", () => {
  const s = new Schedule("0 2 * * *");
  const at0500Z = new Date("2026-10-06T05:00:00Z"); // 02:00 in Sao Paulo (UTC-3)
  assert(s.isDue(at0500Z, "America/Sao_Paulo"));
  assert(!s.isDue(at0500Z));
  assert(s.isDue(new Date("2026-10-06T02:00:00Z")));
});

Deno.test("day of week follows the timezone across midnight", () => {
  const s = new Schedule("30 22 * * 1"); // Monday 22:30 local
  assert(s.isDue(new Date("2026-10-06T01:30:00Z"), "America/Sao_Paulo")); // Tuesday 01:30Z
});

Deno.test("cron ticks in the timezone it reads at each tick", async () => {
  let tz = "UTC";
  const cron = new Cron(() => tz);
  let runs = 0;
  cron.add("job", "0 2 * * *", () => runs++);
  const at = new Date("2026-10-06T05:00:00Z");
  await cron.tick(at);
  tz = "America/Sao_Paulo";
  await cron.tick(at);
  assertEquals(runs, 1);
});

Deno.test("unknown timezone is invalid and matches as UTC", () => {
  assert(isTimeZone("America/Sao_Paulo"));
  assert(!isTimeZone("Mars/Base"));
  assert(new Schedule("0 2 * * *").isDue(new Date("2026-10-06T02:00:00Z"), "Mars/Base"));
});
