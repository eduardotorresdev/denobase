import { Cli, type Command } from "./engine.ts";
import { serveCommand, type ServeOptions } from "./commands/serve.ts";
import { migrateCommand, reconcileCommand } from "./commands/migrate.ts";
import { genesisCommand } from "./commands/genesis.ts";
import { testDataCommand } from "./commands/test_data.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { storageCommand } from "./commands/storage.ts";

/** The CLI: the command engine plus the built-in commands, one file each under commands/. */
export * from "./engine.ts";
export { DEFAULT_DB } from "./data.ts";
export { serve, serveCommand, type ServeOptions } from "./commands/serve.ts";
export { migrateCommand, reconcileCommand } from "./commands/migrate.ts";
export { genesis, genesisCommand, genesisPreflight, INSTALLER_EMAIL, runGenesis } from "./commands/genesis.ts";
export { mcpCommand } from "./commands/mcp.ts";
export { fromS3, storageCommand } from "./commands/storage.ts";
export { buildTemplate, fingerprint, testData, testDataCommand } from "./commands/test_data.ts";

/** The built-ins; createCli registers them, and a consumer adds, replaces or removes on the returned Cli. */
export function defaultCommands(opts: ServeOptions = {}): Command[] {
  return [
    serveCommand(opts),
    migrateCommand,
    reconcileCommand,
    genesisCommand,
    testDataCommand,
    mcpCommand(opts),
    storageCommand(opts),
  ];
}

export function createCli(opts: ServeOptions = {}): Cli {
  return new Cli(defaultCommands(opts));
}
