// Owns database preparation before the application opens its connection. The child uses the same
// migrations and integrity checks as DatabaseCore, then closes the file before it reports success.
// A null reply means success; a string is a redacted failure. A newer schema keeps its typed
// recovery error. No database contents cross the port.
import { isAbsolute } from "node:path";
import { redactText } from "@openbot/logging";
import { runCauseEffect } from "../effect-boundary";
import { NewerDatabaseError } from "../openbot-database-schema";
import { DatabaseCore } from "./database-core";

interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(
    value: string | null | { kind: "newer-database"; databaseVersion: number; supportedVersion: number },
  ): void;
  start(): void;
}

function isParentPort(value: unknown): value is ParentPort {
  return typeof value === "object" && value !== null && "postMessage" in value && "start" in value;
}

const port = process.parentPort;
const userDataPath = process.argv[2];
if (!isParentPort(port) || !userDataPath || !isAbsolute(userDataPath)) {
  throw new Error("The database startup host needs a parent port and an absolute profile path.");
}

// Keep the result available until the parent releases this process. The database is already closed.
port.on("message", (message) => {
  if (message.data === "close") process.exit(0);
});
port.start();

const core = new DatabaseCore({ userDataPath });
let failure: Parameters<ParentPort["postMessage"]>[0] = null;
try {
  await runCauseEffect(core.initialize());
} catch (error) {
  failure =
    error instanceof NewerDatabaseError
      ? { kind: "newer-database", databaseVersion: error.databaseVersion, supportedVersion: error.supportedVersion }
      : redactText(error instanceof Error ? error.message : "OpenBot database preparation failed.");
} finally {
  core.close();
}
port.postMessage(failure);
