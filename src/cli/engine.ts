/** Parsed argv handed to a command: positionals after the command name and every --flag. */
export interface CommandContext {
  args: string[];
  flags: Record<string, string | true>;
  /** --name value as a string, undefined when absent or bare. */
  str(name: string): string | undefined;
  /** Every string value of a repeatable --name, in order; [] when absent. */
  all(name: string): string[];
}

/** One subcommand. A consumer defines its own and registers them next to (or instead of) the built-ins. */
export interface Command {
  name: string;
  /** One line after the command name, e.g. "up|status|create" or "[--check]". */
  usage?: string;
  description?: string;
  /** Returns the exit code; void means 0. Throw UsageError for bad args (exit 2), anything else exits 1. */
  run(ctx: CommandContext): number | void | Promise<number | void>;
}

/** Bad invocation: the CLI prints the usage instead of an error and exits 2. */
export class UsageError extends Error {}

/** --key value and --key=value flags; positionals keep their order for subcommands. */
export function parseArgs(
  args: string[],
): { pos: string[]; flags: Record<string, string | true>; lists: Record<string, string[]> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  const lists: Record<string, string[]> = {};
  const set = (k: string, v: string | true) => {
    flags[k] = v;
    if (typeof v === "string") (lists[k] ??= []).push(v);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) set(a.slice(2), args[++i]);
    else set(a.slice(2), true);
  }
  return { pos, flags, lists };
}

/** Command registry and dispatcher; registering a name again replaces it, so a consumer can override a built-in. */
export class Cli {
  #commands = new Map<string, Command>();

  constructor(commands: Command[] = []) {
    this.add(...commands);
  }

  add(...commands: Command[]): this {
    for (const c of commands) this.#commands.set(c.name, c);
    return this;
  }

  remove(name: string): this {
    this.#commands.delete(name);
    return this;
  }

  get(name: string): Command | undefined {
    return this.#commands.get(name);
  }

  commands(): Command[] {
    return [...this.#commands.values()];
  }

  usage(): string {
    const heads = this.commands().map((c) => [c.usage ? `${c.name} ${c.usage}` : c.name, c.description ?? ""]);
    const width = Math.max(0, ...heads.map(([h]) => h.length));
    const lines = heads.map(([h, d]) => (d ? `  ${h.padEnd(width)}  ${d}` : `  ${h}`));
    return ["usage: main.ts <command>", ...lines].join("\n");
  }

  /** Dispatches argv and returns the exit code: 0 ok, 1 command error, 2 usage. */
  async run(argv: string[]): Promise<number> {
    const { pos, flags, lists } = parseArgs(argv);
    const cmd = pos[0] ? this.#commands.get(pos[0]) : undefined;
    if (!cmd) {
      console.error(this.usage());
      return 2;
    }
    const ctx: CommandContext = {
      args: pos.slice(1),
      flags,
      str: (name) => (typeof flags[name] === "string" ? flags[name] as string : undefined),
      all: (name) => [...(lists[name] ?? [])],
    };
    try {
      return (await cmd.run(ctx)) ?? 0;
    } catch (e) {
      if (e instanceof UsageError) {
        console.error(`${e.message ? e.message + "\n" : ""}usage: main.ts ${cmd.name} ${cmd.usage ?? ""}`.trimEnd());
        return 2;
      }
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
}
