import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { OUTPUT, renderUiAssets, UI_DIR } from "../../scripts/embed_ui.ts";
import { adminUiRoutes } from "./admin_ui.ts";
import type { AppEnv } from "./app.ts";
import { diskUi, embeddedUi, uiSourceFor } from "./ui_source.ts";

Deno.test("ui_assets.ts matches ui/ (run `deno task embed-ui` after editing ui/)", async () => {
  assert(await Deno.readTextFile(OUTPUT) === await renderUiAssets(), "src/http/ui_assets.ts is stale");
});

Deno.test("a package root that is not a file: URL (JSR) reads the embedded UI", () => {
  assertEquals(uiSourceFor(new URL("https://jsr.io/@denobase/denobase/0.1.0/ui/")), embeddedUi);
  assert(uiSourceFor(UI_DIR) !== embeddedUi);
});

Deno.test("the embedded map serves the admin UI and the OAuth assets with the same bytes as ui/", async () => {
  const app = new Hono<AppEnv>();
  adminUiRoutes(app, embeddedUi);
  const root = await app.request("/_/");
  assertEquals([root.status, root.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  assert((await root.text()).includes("src/main.js"));
  const main = await app.request("/_/src/main.js");
  assertEquals(main.headers.get("content-type"), "text/javascript; charset=utf-8");
  assertEquals(await main.text(), await Deno.readTextFile(new URL("src/main.js", UI_DIR)));
  assertEquals(await (await app.request("/_/records/x")).text(), await (await app.request("/_/")).text());

  const disk = diskUi(UI_DIR);
  for (const path of ["oauth.css", "css/tokens.css", "assets/logo.svg", "assets/fonts/instrument-sans.woff2"]) {
    const [e, d] = [await embeddedUi.read(path), await disk.read(path)];
    assert(e && d, path);
    assertEquals([e.type, e.data], [d.type, d.data], path);
  }
  assertEquals(await embeddedUi.read("missing.css"), null);
  assertEquals(await embeddedUi.read("constructor"), null);
});
