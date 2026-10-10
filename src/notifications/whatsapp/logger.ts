import type { UserFacingSocketConfig } from "baileys";

type ILogger = NonNullable<UserFacingSocketConfig["logger"]>;

/** Baileys wants a pino-like logger; a silent one keeps pino out of the process and its output out of the logs. */
export const silentLogger: ILogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
