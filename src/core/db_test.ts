import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../store/mod.ts";
import { restore } from "../testing/mod.ts";
import { afterCommit, beforeCommit, openDb, tx, txState } from "./db.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("concurrent top-level txs do not share a commit or rollback", async () => {
  const db = openDb();
  db.exec("CREATE TABLE t (v TEXT)");
  const a = tx(db, async (d) => {
    d.exec("INSERT INTO t VALUES ('a')");
    await sleep(20);
    throw new Error("A fails");
  });
  const b = tx(db, async (d) => {
    await sleep(1);
    d.exec("INSERT INTO t VALUES ('b')");
    return "B ok";
  });
  await assertRejects(() => a, Error, "A fails");
  assertEquals(await b, "B ok");
  assertEquals(db.prepare("SELECT v FROM t").all().map((r) => r.v), ["b"]);
});

Deno.test("tx inside tx is a savepoint of the same transaction", async () => {
  const db = openDb();
  db.exec("CREATE TABLE t (v TEXT)");
  await tx(db, async (d) => {
    d.exec("INSERT INTO t VALUES ('outer')");
    await assertRejects(() =>
      tx(d, () => {
        d.exec("INSERT INTO t VALUES ('inner')");
        throw new Error("inner");
      })
    );
  });
  assertEquals(db.prepare("SELECT v FROM t").all().map((r) => r.v), ["outer"]);
});

Deno.test("afterCommit runs after the outermost commit, never for a rolled-back level", async () => {
  const db = openDb();
  db.exec("CREATE TABLE t (v TEXT)");
  const log: string[] = [];
  await tx(db, async (d) => {
    afterCommit(d, () => log.push(`outer saw ${d.isTransaction ? "open" : "committed"}`));
    await tx(d, () => afterCommit(d, () => log.push("inner kept")));
    await assertRejects(() =>
      tx(d, () => {
        afterCommit(d, () => log.push("inner dropped"));
        throw new Error("x");
      })
    );
    log.push("body done");
  });
  assertEquals(log, ["body done", "outer saw committed", "inner kept"]);
  await assertRejects(() =>
    tx(db, () => (afterCommit(db, () => log.push("rolled back")), Promise.reject(new Error())))
  );
  afterCommit(db, () => log.push("no tx runs now"));
  assertEquals(log.slice(3), ["no tx runs now"]);
});

Deno.test("beforeCommit runs once per key inside the outermost transaction, and not after a rollback", async () => {
  const db = openDb();
  db.exec("CREATE TABLE t (v TEXT)");
  const log: string[] = [];
  const recalc = () => {
    log.push(`recalc ${db.isTransaction ? "in tx" : "outside"}`);
    db.exec("INSERT INTO t VALUES ('derived')");
  };
  await tx(db, async (d) => {
    await beforeCommit(d, "k", recalc);
    await tx(d, () => beforeCommit(d, "k", recalc));
    await beforeCommit(d, "chain", () => beforeCommit(d, "late", () => void log.push("queued by queued work")));
    log.push("body done");
  });
  assertEquals(log, ["body done", "recalc in tx", "queued by queued work"]);
  assertEquals(db.prepare("SELECT count(*) AS n FROM t").get()?.n, 1);
  await assertRejects(() => tx(db, async (d) => (await beforeCommit(d, "k", recalc), Promise.reject(new Error()))));
  assertEquals(log.length, 3);
  await beforeCommit(db, "k", recalc);
  assertEquals(log.at(-1), "recalc outside");
});

Deno.test("txState is shared inside one transaction and fresh after a commit or a rollback", async () => {
  const db = openDb();
  const marcar = (v: string) => txState(db, "k", () => [] as string[]).push(v);
  await assertRejects(() =>
    tx(db, async () => {
      marcar("a");
      await tx(db, () => void marcar("b"));
      assertEquals(txState(db, "k", () => [] as string[]), ["a", "b"]);
      throw new Error("rollback");
    })
  );
  await tx(db, () => assertEquals(txState(db, "k", () => [] as string[]), []));
  assertEquals(txState(db, "k", () => ["fora"]), ["fora"]);
});

Deno.test("every connection a store or the framework opens has fold(): a ~ filter never fails with no such function", () => {
  const crua = new DatabaseSync(":memory:");
  const conexoes: [string, DatabaseSync][] = [
    ["openDb", openDb()],
    ["restore", restore(openDb().serialize())],
    ["createStore sobre conexao aberta a mao", (createStore(crua), crua)],
  ];
  for (const [origem, db] of conexoes) {
    assertEquals(db.prepare("SELECT fold('Ação') AS f").get()?.f, "acao", origem);
  }
});
