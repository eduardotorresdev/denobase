/** A serve for rpc_test: "hang" never answers (a handler in flight), anything else answers at once. */
import { serveCalls } from "../rpc.ts";

serveCalls(Deno.args[0], (r) => r.method === "hang" ? new Promise(() => {}) : Promise.resolve("ok"));
console.log("ready");
