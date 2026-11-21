import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { utilityProcess } from "electron";
import { NewerDatabaseError } from "../backend/openbot-database-schema";
import { StoredStateFailure, storedSync } from "../backend/stored-state-effects";

/** Owns the startup child so large SQLite checks do not block the Electron main process. */
export const prepareApplicationDatabase = Effect.fn("DatabaseStartup.prepare")(function* (userDataPath: string) {
  yield* Effect.acquireUseRelease(
    storedSync(() =>
      utilityProcess.fork(join(import.meta.dirname, "database-startup-host.js"), [userDataPath], {
        serviceName: "OpenBot database startup",
        stdio: "ignore",
      }),
    ),
    (child) =>
      Effect.callback<void, StoredStateFailure>((resume) => {
        const onMessage = (message: unknown) => {
          if (message === null) resume(Effect.void);
          else if (
            isDynamicRecord(message) &&
            message.kind === "newer-database" &&
            typeof message.databaseVersion === "number" &&
            Number.isSafeInteger(message.databaseVersion) &&
            typeof message.supportedVersion === "number" &&
            Number.isSafeInteger(message.supportedVersion)
          ) {
            resume(
              Effect.fail(
                new StoredStateFailure({
                  cause: new NewerDatabaseError(message.databaseVersion, message.supportedVersion),
                }),
              ),
            );
          } else {
            resume(
              Effect.fail(
                new StoredStateFailure({
                  cause: new Error(typeof message === "string" ? message : "Invalid database startup reply."),
                }),
              ),
            );
          }
        };
        const onExit = (code: number) => {
          resume(
            Effect.fail(
              new StoredStateFailure({
                cause: new Error(`The database startup process ended before its reply (${code}).`),
              }),
            ),
          );
        };
        child.once("message", onMessage);
        child.once("exit", onExit);
        return Effect.sync(() => {
          child.removeListener("message", onMessage);
          child.removeListener("exit", onExit);
        });
      }),
    (child) =>
      Effect.callback<void>((resume) => {
        const onExit = () => resume(Effect.void);
        child.once("exit", onExit);
        if (!child.kill()) resume(Effect.void);
        return Effect.sync(() => child.removeListener("exit", onExit));
      }),
  );
});
