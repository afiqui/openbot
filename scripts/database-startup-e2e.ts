// Drives the real startup helper under Electron, with separate databases. Writes a JSON report.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const logger = createOpenBotLogger("database-startup-e2e");
const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(
  process.env.OPENBOT_STARTUP_TEST_OUTPUT ?? join(projectRoot, ".openbot-build/database-startup-e2e"),
);

async function runElectronHarness(): Promise<void> {
  const { app } = await import("electron");
  const { DatabaseCore } = await import("../src/backend/database/database-core");
  const { runCauseEffect } = await import("../src/backend/effect-boundary");
  const { NewerDatabaseError } = await import("../src/backend/openbot-database-schema");
  const { prepareApplicationDatabase } = await import("../src/main/database-startup-process");
  const { openStartupLoadingWindow } = await import("../src/main/startup-loading-window");
  const { StartupTiming } = await import("../src/main/startup-timing");
  mkdirSync(outputRoot, { recursive: true });
  const runRoot = mkdtempSync(join(outputRoot, "run-"));
  app.setPath("userData", join(runRoot, "electron-profile"));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const report: { passed: boolean; steps: Array<{ name: string; detail: unknown }> } = { passed: false, steps: [] };
  const loading = openStartupLoadingWindow({ translate: translateFor("en"), iconPath: "", quit: () => app.quit() });
  try {
    const shownAt = performance.now();
    await loading.ready;
    if (!loading.window.isVisible()) await once(loading.window, "show");
    assert.deepEqual(
      await loading.window.webContents.executeJavaScript(
        "({node:typeof require,bridge:typeof window.openbot,text:document.body.innerText.trim()})",
      ),
      { node: "undefined", bridge: "undefined", text: translateFor("en")("app.loading") },
    );
    assert.equal(await loading.window.webContents.executeJavaScript("window.open('https://example.com')"), null);
    assert.equal(
      await loading.window.webContents.executeJavaScript("fetch('http://127.0.0.1:9/').then(()=>false,()=>true)"),
      true,
    );
    writeFileSync(join(runRoot, "loading-window.png"), (await loading.window.webContents.capturePage()).toPNG());
    report.steps.push({
      name: "Isolated loading page is ready without database or privileged bridge",
      detail: { durationMs: performance.now() - shownAt },
    });
    const profile = join(runRoot, "database-profile");
    performance.mark("openbot:database-preparation-start");
    await runCauseEffect(prepareApplicationDatabase(profile));
    performance.mark("openbot:database-preparation-end");
    report.steps.push({ name: "New database prepared in the real helper", detail: true });

    const core = new DatabaseCore({ userDataPath: profile });
    await runCauseEffect(core.initialize());
    try {
      const db = core.connection;
      const latest = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version;
      assert.ok(typeof latest === "number");
      db.exec("CREATE TABLE startup_fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
      db.prepare("INSERT INTO startup_fixture VALUES (?, ?)").run(1, "preserve-this-chat-fixture");
      // Only this test database changes. Re-run the last shipped migration through its real path.
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latest);
      db.exec("BEGIN IMMEDIATE");
      let heartbeats = 0;
      let lockReleased = false;
      const heartbeat = setInterval(() => {
        heartbeats += 1;
        if (heartbeats === 5) {
          db.exec("COMMIT");
          lockReleased = true;
        }
      }, 10);
      // An intentional SQLite lock: the main event loop must release it while preparation waits.
      const startedAt = performance.now();
      try {
        await runCauseEffect(prepareApplicationDatabase(profile));
        assert.ok(lockReleased, "The SQLite lock must be released by the main event loop.");
        assert.ok(heartbeats >= 5, "The main process must run while SQLite preparation waits.");
        assert.equal(
          db.prepare("SELECT payload FROM startup_fixture WHERE id = 1").get()?.payload,
          "preserve-this-chat-fixture",
        );
        assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, latest);
        report.steps.push({
          name: "Pending migration preserves data and leaves the main loop responsive",
          detail: { heartbeats, durationMs: Math.round(performance.now() - startedAt) },
        });
      } finally {
        clearInterval(heartbeat);
        if (db.isTransaction) db.exec("ROLLBACK");
      }
    } finally {
      core.close();
    }

    // Kill only this isolated fixture writer to leave a real unclean WAL.
    const unclean = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL'); db.prepare('INSERT INTO startup_fixture VALUES (?,?)').run(2,'preserve-after-unclean-exit'); process.kill(process.pid,'SIGKILL');",
        join(profile, "openbot.db"),
      ],
      { windowsHide: true, timeout: 10000 },
    );
    assert.notEqual(unclean.status, 0);
    assert.ok(existsSync(join(profile, "openbot.db-wal")));
    await runCauseEffect(prepareApplicationDatabase(profile));
    assert.equal(existsSync(join(profile, "openbot.db-wal")), false, "Helper closes before handing the database back");
    const reopened = new DatabaseCore({ userDataPath: profile });
    await runCauseEffect(reopened.initialize());
    try {
      assert.equal(
        reopened.connection.prepare("SELECT payload FROM startup_fixture WHERE id=2").get()?.payload,
        "preserve-after-unclean-exit",
      );
    } finally {
      reopened.close();
    }
    report.steps.push({ name: "Unclean WAL recovery preserves committed data and closes cleanly", detail: true });

    const locked = new DatabaseCore({ userDataPath: profile });
    await runCauseEffect(locked.initialize());
    const latestForCancellation = locked.connection
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get()?.version;
    assert.ok(typeof latestForCancellation === "number");
    locked.connection.prepare("DELETE FROM schema_migrations WHERE version=?").run(latestForCancellation);
    const stop = new AbortController();
    locked.connection.exec("BEGIN IMMEDIATE");
    const preparation = Effect.runPromise(prepareApplicationDatabase(profile), { signal: stop.signal }).then(
      () => false,
      () => true,
    );
    const hasStartupChild = () =>
      app
        .getAppMetrics()
        .some(
          (metric) => metric.name === "OpenBot database startup" || metric.serviceName === "OpenBot database startup",
        );
    const deadline = performance.now() + 5_000;
    try {
      while (!hasStartupChild()) {
        assert.ok(performance.now() < deadline, "The owned startup process must appear.");
        await delay(10);
      }
      stop.abort();
      assert.equal(await preparation, true, "Preparation must reject on cancellation.");
      while (hasStartupChild()) {
        assert.ok(performance.now() < deadline, "The cancelled startup process must exit.");
        await delay(10);
      }
    } finally {
      stop.abort();
      if (locked.connection.isTransaction) locked.connection.exec("ROLLBACK");
      locked.close();
    }
    await runCauseEffect(prepareApplicationDatabase(profile));
    report.steps.push({ name: "Cancellation ends the owned helper and a later preparation succeeds", detail: true });

    const newer = new DatabaseSync(join(profile, "openbot.db"));
    newer
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(latestForCancellation + 1, new Date().toISOString());
    newer.close();
    await assert.rejects(
      runCauseEffect(prepareApplicationDatabase(profile)),
      (error) =>
        error instanceof NewerDatabaseError &&
        error.databaseVersion === latestForCancellation + 1 &&
        error.supportedVersion === latestForCancellation,
    );
    const afterRefusal = new DatabaseSync(join(profile, "openbot.db"));
    try {
      assert.equal(
        afterRefusal.prepare("SELECT payload FROM startup_fixture WHERE id=2").get()?.payload,
        "preserve-after-unclean-exit",
      );
      assert.equal(
        afterRefusal.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
        latestForCancellation + 1,
      );
    } finally {
      afterRefusal.close();
    }
    report.steps.push({ name: "A newer schema retains its typed recovery error and stored data", detail: true });

    const invalidProfile = join(runRoot, "invalid-profile");
    mkdirSync(invalidProfile);
    const invalidPath = join(invalidProfile, "openbot.db");
    writeFileSync(invalidPath, "This is not a SQLite database.");
    const digest = () => createHash("sha256").update(readFileSync(invalidPath)).digest("hex");
    const before = digest();
    await assert.rejects(runCauseEffect(prepareApplicationDatabase(invalidProfile)));
    assert.equal(digest(), before);
    report.steps.push({ name: "An invalid database is refused without changing its contents", detail: true });
    let summaries = 0;
    const timing = new StartupTiming({
      userDataPath: profile,
      appVersion: "0.71.0",
      server: false,
      send: () => {
        summaries += 1;
      },
    });
    await Effect.runPromise(timing.recordStart());
    timing.rendererLoaded();
    timing.workspaceReady();
    timing.workspaceReady();
    const timingPath = join(profile, "startup-timing-last.json");
    const timingDeadline = performance.now() + 2_000;
    while (!existsSync(timingPath)) {
      assert.ok(performance.now() < timingDeadline, "A local startup report must be written.");
      await delay(10);
    }
    const timingReport = JSON.parse(readFileSync(timingPath, "utf8"));
    assert.ok(timingReport.databasePreparationMs > 0);
    assert.ok(timingReport.loadingWindowReadyMs > 0);
    assert.ok(timingReport.properties.workspace_ready_ms > 0);
    assert.equal(summaries, 1);
    timing.dispose();
    report.steps.push({
      name: "Local startup timing separates database preparation and workspace readiness",
      detail: true,
    });
    report.passed = true;
  } catch (error) {
    report.steps.push({
      name: "Startup process test failed",
      detail: error instanceof Error ? error.stack : String(error),
    });
  } finally {
    loading.close();
    writeFileSync(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outputRoot, "latest-report.json"), `${JSON.stringify({ ...report, runRoot }, null, 2)}\n`);
    app.exit(report.passed ? 0 : 1);
  }
}

function runDriver(): void {
  mkdirSync(outputRoot, { recursive: true });
  const bundleRoot = join(outputRoot, "bundle");
  const built = spawnSync(
    process.execPath,
    [
      "build",
      import.meta.filename,
      join(projectRoot, "src/backend/database/database-startup-host.ts"),
      "--target=node",
      "--format=esm",
      "--external=electron",
      "--entry-naming=[name].js",
      `--outdir=${bundleRoot}`,
    ],
    { cwd: projectRoot, stdio: "inherit", windowsHide: true },
  );
  assert.equal(built.status, 0, "Build the startup test harness.");
  const electronPath = readFileSync(join(projectRoot, "node_modules/electron/path.txt"), "utf8").trim();
  const electron = join(projectRoot, "node_modules/electron/dist", electronPath);
  const run = spawnSync(electron, [join(bundleRoot, "database-startup-e2e.js"), "--electron-harness"], {
    cwd: projectRoot,
    env: { ...withoutElectronRuntimeFlags(process.env), OPENBOT_STARTUP_TEST_OUTPUT: outputRoot },
    stdio: "inherit",
    windowsHide: true,
    timeout: 60_000,
  });
  if (run.error) throw run.error;
  assert.equal(run.status, 0, "The database startup process smoke test must pass.");
  logger.info(`Report: ${join(outputRoot, "latest-report.json")}`);
}

if (process.argv.includes("--electron-harness")) {
  runElectronHarness().catch((error: unknown) => {
    logger.error("The database startup test failed.", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else runDriver();
