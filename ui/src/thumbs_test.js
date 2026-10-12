import { assertEquals } from "@std/assert";
import { addThumbs, thumbError, thumbsSnippet } from "./thumbs.js";

Deno.test("thumbError matches the server's PB checks", () => {
  for (const ok of ["100x100", "0x30", "30x0", "10x10t", "10x10b", "10x10f", ""]) assertEquals(thumbError(ok), "", ok);
  for (const z of ["0x0", "0x0t", "0x0b", "0x0f"]) assertEquals(thumbError(z), "Must not be in list.");
  for (const bad of ["abc", "10x10x", "10X10", " 10x10", "-1x10"]) {
    assertEquals(thumbError(bad), "Must be in a valid format.", bad);
  }
});

Deno.test("addThumbs splits on commas and spaces and skips repeats; the snippet is pasteable", () => {
  const list = addThumbs(["10x10"], "20x20, 10x10 30x0,,");
  assertEquals(list, ["10x10", "20x20", "30x0"]);
  assertEquals(thumbsSnippet(list), 'thumbs: ["10x10", "20x20", "30x0"],');
});
