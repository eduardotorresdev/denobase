import { assertEquals, assertRejects } from "@std/assert";
import { Cli, createCli, genesis, parseArgs, UsageError } from "./mod.ts";

Deno.test("parseArgs reads --k v, --k=v, bare flags and positionals", () => {
  assertEquals(parseArgs(["genesis", "--email", "a@b.c", "--password=x", "--check"]), {
    pos: ["genesis"],
    flags: { email: "a@b.c", password: "x", check: true },
    lists: { email: ["a@b.c"], password: ["x"] },
  });
});

Deno.test("genesis requires both email and password before opening any db", async () => {
  Deno.env.delete("ADMIN_EMAIL");
  Deno.env.delete("ADMIN_PASSWORD");
  await assertRejects(() => genesis({ email: "a@b.c" }), Error, "--password");
});

/** Runs fn with console.error captured, so expected usage output stays out of the test log. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ out: T; err: string }> {
  const orig = console.error;
  let err = "";
  console.error = (m: unknown) => void (err += `${m}\n`);
  try {
    return { out: await fn(), err };
  } finally {
    console.error = orig;
  }
}

Deno.test("unknown command and bad built-in args print usage and exit 2", async () => {
  const cli = createCli();
  const r = await quiet(() => cli.run(["nope"]));
  assertEquals(r.out, 2);
  assertEquals(r.err.includes("migrate up|status|create"), true);
  assertEquals((await quiet(() => cli.run(["migrate", "sideways"]))).out, 2);
});

Deno.test("a consumer command gets positionals and flags, and its return is the exit code", async () => {
  let seen: unknown;
  const cli = createCli().add({
    name: "seed",
    usage: "<n> [--fast]",
    run: (c) => {
      seen = { args: c.args, fast: c.flags.fast, db: c.str("db") };
      return 3;
    },
  });
  assertEquals(await cli.run(["seed", "10", "--fast", "--db", "x.db"]), 3);
  assertEquals(seen, { args: ["10"], fast: true, db: "x.db" });
  assertEquals((await quiet(() => cli.run(["help"]))).err.includes("seed <n> [--fast]"), true);
});

Deno.test("a repeated flag keeps its last value in str and every value, in order, in all", async () => {
  let seen: unknown;
  const cli = createCli().add({
    name: "x",
    run: (c) => void (seen = [c.str("p"), c.all("p"), c.all("nada"), c.all("b")]),
  });
  assertEquals(await cli.run(["x", "--p", "a=1", "--p=b=2", "--b"]), 0);
  assertEquals(seen, ["b=2", ["a=1", "b=2"], [], []]);
});

Deno.test("registering a built-in name replaces it, and remove drops it", async () => {
  let ran = false;
  const cli = createCli().add({ name: "serve", run: () => void (ran = true) });
  assertEquals(await cli.run(["serve"]), 0);
  assertEquals(ran, true);
  cli.remove("serve");
  assertEquals((await quiet(() => cli.run(["serve"]))).out, 2);
});

Deno.test("UsageError exits 2 with the command usage; other errors exit 1", async () => {
  const cli = new Cli([
    {
      name: "a",
      usage: "<x>",
      run: () => {
        throw new UsageError("missing x");
      },
    },
    {
      name: "b",
      run: () => {
        throw new Error("boom");
      },
    },
  ]);
  const a = await quiet(() => cli.run(["a"]));
  assertEquals(a, { out: 2, err: "missing x\nusage: main.ts a <x>\n" });
  const b = await quiet(() => cli.run(["b"]));
  assertEquals(b, { out: 1, err: "error: boom\n" });
});
