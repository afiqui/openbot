// Runs the real update service in separate Node processes. No Electron or provider is started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { getCustomServerBuild, stockUpdatesAllowed } from "../src/main/custom-server-build";
import {
  createDisabledUpdateAdapter,
  loadElectronUpdater,
  type UpdateAdapter,
  UpdateService,
} from "../src/main/update-service";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(
  process.env.OPENBOT_CUSTOM_UPDATE_TEST_OUTPUT ?? join(projectRoot, ".openbot-build/custom-server-updates-e2e"),
);

const fixtureBuild = {
  format: 1,
  buildId: "isolated-update-policy-fixture",
  upstreamCommit: "0000000000000000000000000000000000000000",
  upstreamVersion: "0.71.0",
  builtAt: "2026-01-01T00:00:00.000Z",
};

async function runFixture(): Promise<void> {
  const variant = process.argv.at(-1);
  assert.ok(variant === "custom" || variant === "upstream");
  const custom = variant === "custom";
  const calls = { check: 0, download: 0, install: 0, prepareInstall: 0 };
  const checks: string[] = [];
  const adapter: UpdateAdapter = {
    ...createDisabledUpdateAdapter(),
    checkForUpdates: async () => {
      calls.check += 1;
      return { isUpdateAvailable: false, updateInfo: { version: "0.71.0" } };
    },
    downloadUpdate: async () => {
      calls.download += 1;
      return [];
    },
    quitAndInstall: () => {
      calls.install += 1;
    },
  };
  const updater = new UpdateService(adapter, {
    currentVersion: "0.71.0",
    enabled: true,
    autoDownload: true,
    platform: "win32",
    beforeInstall: async () => {
      calls.prepareInstall += 1;
    },
  });
  const report: { passed: boolean; variant: string; checks: string[]; calls: typeof calls; error?: string } = {
    passed: false,
    variant,
    checks,
    calls,
  };
  try {
    assert.equal(stockUpdatesAllowed(), !custom);
    assert.deepEqual(getCustomServerBuild(), custom ? fixtureBuild : null);
    checks.push("The compiled build record selects the update policy.");
    updater.start(false);

    if (custom) {
      assert.equal(await loadElectronUpdater(), null);
      checks.push("The custom build refuses the Electron updater loader.");
      assert.equal(updater.getStatus().phase, "unsupported");
      assert.equal((await runCauseEffect(updater.checkForUpdates())).phase, "unsupported");
      assert.equal((await runCauseEffect(updater.downloadUpdate())).phase, "unsupported");
      await Effect.runPromise(updater.setAutoDownload(false));
      await Effect.runPromise(updater.setAutoDownload(true));
      updater.resume();
      assert.equal((await runCauseEffect(updater.checkForUpdates())).phase, "unsupported");
      assert.deepEqual(calls, { check: 0, download: 0, install: 0, prepareInstall: 0 });
      checks.push("Manual checks, downloads and saved preference changes cannot enable stock updates.");
    } else {
      assert.equal(updater.getStatus().phase, "idle");
      assert.equal((await runCauseEffect(updater.checkForUpdates())).phase, "up-to-date");
      assert.deepEqual(calls, { check: 1, download: 0, install: 0, prepareInstall: 0 });
      checks.push("An upstream build still checks through its configured update adapter.");
    }

    await assert.rejects(runCauseEffect(updater.installUpdate()), {
      message: sourceText("error.update.notReady"),
    });
    assert.equal(calls.install, 0);
    assert.equal(calls.prepareInstall, 0);
    checks.push("A refused install keeps the released not-ready error and does not start shutdown.");
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    await Effect.runPromise(updater.stop());
    writeFileSync(join(outputRoot, `${variant}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
}

async function runDriver(): Promise<void> {
  mkdirSync(outputRoot, { recursive: true });
  const runRoot = mkdtempSync(join(outputRoot, "run-"));
  const report: { passed: boolean; runRoot: string; variants: string[]; error?: string } = {
    passed: false,
    runRoot,
    variants: [],
  };
  try {
    for (const variant of ["upstream", "custom"] as const) {
      const built = await Bun.build({
        entrypoints: [import.meta.filename],
        target: "node",
        format: "esm",
        outdir: runRoot,
        naming: `${variant}.mjs`,
        external: ["electron-updater"],
        define: {
          __OPENBOT_CUSTOM_SERVER_BUILD__: JSON.stringify(variant === "custom" ? fixtureBuild : null),
        },
      });
      assert.ok(built.success, String(built.logs));
      const child = spawnSync("node", [join(runRoot, `${variant}.mjs`), "--fixture", variant], {
        cwd: projectRoot,
        env: { ...process.env, OPENBOT_CUSTOM_UPDATE_TEST_OUTPUT: runRoot },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const fixtureReport: { passed: boolean } = JSON.parse(readFileSync(join(runRoot, `${variant}.json`), "utf8"));
      assert.equal(fixtureReport.passed, true);
      report.variants.push(variant);
    }
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    writeFileSync(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outputRoot, "latest-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv.includes("--fixture")) await runFixture();
else await runDriver();
