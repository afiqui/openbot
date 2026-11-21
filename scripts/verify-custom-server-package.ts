// Inspects the staged archive only. It does not launch the app or use a live profile.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const projectRoot = resolve(import.meta.dirname, "..");
const appPath = resolve(process.argv[2] ?? join(projectRoot, "dist/win-unpacked"));
const archivePath = join(appPath, "resources/app.asar");
const reportRoot = join(projectRoot, ".openbot-build/custom-server-package-verification");

type Literal = string | number;
interface BuildIdentity {
  format: number;
  buildId: string;
  upstreamCommit: string;
  upstreamVersion: string;
}

/** Reads literal fields only. It never evaluates configuration or packaged JavaScript. */
function literalObject(text: string): Map<string, Literal> {
  const values = new Map<string, Literal>();
  const fields = /(?:^|[,{])\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*:\s*("(?:\\.|[^"\\])*"|\d+)(?=\s*[,}])/gu;
  for (const match of text.matchAll(fields)) {
    const name = match[1] ?? match[2];
    const literal = match[3];
    if (name === undefined || literal === undefined) continue;
    const value = JSON.parse(literal);
    if (typeof value === "string" || typeof value === "number") values.set(name, value);
  }
  return values;
}

function stringValue(values: Map<string, Literal>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string") throw new Error(`The build record has no literal ${key}.`);
  return value;
}

function identity(values: Map<string, Literal>): BuildIdentity {
  const format = values.get("format");
  assert.equal(format, 1);
  return {
    format: 1,
    buildId: stringValue(values, "buildId"),
    upstreamCommit: stringValue(values, "upstreamCommit"),
    upstreamVersion: stringValue(values, "upstreamVersion"),
  };
}

function objectAt(text: string, token: string, offset = 0): string | null {
  const marker = text.indexOf(token, offset);
  if (marker < 0) return null;
  const start = text.lastIndexOf("{", marker);
  const end = text.indexOf("}", marker);
  if (start < 0 || end < start || end - start > 2_000) return null;
  return text.slice(start, end + 1);
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const report: {
  passed: boolean;
  mode: string;
  appPath: string;
  archiveSha256?: string;
  sourceBuild?: BuildIdentity;
  packagedBuild?: BuildIdentity & { builtAt: string };
  markerFiles: string[];
  compiledFiles: Array<{ archiveEntry: string; sha256: string }>;
  evidence: Array<{ token: string; packagedFiles: string[]; sourceFile: string }>;
  sourceUpdaterE2E?: { passed: boolean; reportPath: string; reportSha256: string };
  limitations: string[];
  error?: string;
} = {
  passed: false,
  mode: "static-archive-inspection",
  appPath,
  markerFiles: [],
  compiledFiles: [],
  evidence: [],
  limitations: [
    "This verifies packaged code and build identity; it does not invoke the packaged updater or tools.",
    "The updater process E2E tests source bundles separately; its result is not a packaged runtime test.",
    "The Windows package verifier separately checks launch, native runtimes, ASAR integrity and Electron fuses.",
  ],
};

mkdirSync(reportRoot, { recursive: true });
try {
  const configuration = readFileSync(join(projectRoot, "electron.vite.config.ts"), "utf8");
  const defineStart = configuration.indexOf("__OPENBOT_CUSTOM_SERVER_BUILD__");
  assert.ok(defineStart >= 0, "The source build must define its custom record.");
  const objectStart = configuration.indexOf("{", defineStart);
  const objectEnd = configuration.indexOf("}", objectStart);
  assert.ok(objectStart >= 0 && objectEnd > objectStart);
  const expected = identity(literalObject(configuration.slice(objectStart, objectEnd + 1)));
  assert.match(expected.buildId, /^server-work-[a-z0-9-]+$/u);
  assert.match(expected.upstreamCommit, /^[0-9a-f]{40}$/u);
  const sourcePackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  assert.equal(expected.upstreamVersion, sourcePackage.version);
  report.sourceBuild = expected;

  const packagedPackage = JSON.parse(extractFile(archivePath, "package.json").toString("utf8"));
  assert.equal(packagedPackage.version, expected.upstreamVersion);
  const names = listPackage(archivePath, { isPack: false })
    .map((name) => name.replaceAll("\\", "/").replace(/^\//u, ""))
    .filter((name) => /^out\/main\/.*\.js$/u.test(name));
  assert.ok(names.includes("out/main/index.js"), "The archive must contain the main entry.");
  const compiled = new Map(
    names.map((name) => [name, extractFile(archivePath, join(...name.split("/"))).toString("utf8")]),
  );
  report.compiledFiles = [...compiled].map(([archiveEntry, text]) => ({
    archiveEntry,
    sha256: createHash("sha256").update(text).digest("hex"),
  }));

  for (const [name, text] of compiled) {
    const snippet = objectAt(text, expected.buildId);
    if (!snippet) continue;
    const values = literalObject(snippet);
    const packagedIdentity = identity(values);
    assert.deepEqual(packagedIdentity, expected);
    const builtAt = stringValue(values, "builtAt");
    assert.equal(new Date(builtAt).toISOString(), builtAt, "The compiled build time must be UTC ISO format.");
    report.markerFiles.push(name);
    report.packagedBuild = { ...packagedIdentity, builtAt };
  }
  assert.ok(report.markerFiles.length > 0, "The staged archive has no matching compiled custom build record.");

  const required = [
    { token: "custom-server-work-v1.json", sourceFile: "src/backend/agent/server-work-policy.ts" },
    { token: "maxConcurrentTasks", sourceFile: "src/backend/agent/server-work-policy.ts" },
    { token: "maxUnfinishedTasks", sourceFile: "src/backend/agent/server-work-policy.ts" },
    { token: "ServerWorkDispatch.dispatch", sourceFile: "src/backend/agent/server-work-dispatch.ts" },
    { token: "ServerWorkDispatch.enqueue", sourceFile: "src/backend/agent/server-work-dispatch.ts" },
    { token: "openbot-work-", sourceFile: "src/backend/agent/server-work-dispatch.ts" },
    { token: "server-work-receipt:", sourceFile: "src/backend/agent/server-work-dispatch.ts" },
    { token: "dispatch_work", sourceFile: "src/backend/openbot-tools.ts" },
    { token: "find_work", sourceFile: "src/backend/openbot-tools.ts" },
    { token: "dispatch_queued_work", sourceFile: "src/backend/openbot-tools.ts" },
    { token: "ServerWorkBacklog.move", sourceFile: "src/backend/agent/server-work-backlog.ts" },
    { token: "custom-message-routing-v1.json", sourceFile: "src/main/custom-message-routing-preference-store.ts" },
    { token: "ServerWorkRouting.plan", sourceFile: "src/backend/agent/server-work-routing.ts" },
    { token: "JevWorkRouter.decide", sourceFile: "src/backend/agent/jev-work-router.ts" },
    { token: "RoutineFlowDiscovery.close", sourceFile: "src/backend/routine-flows/routine-flow-discovery.ts" },
    { token: "OpenBot Claude history", sourceFile: "src/main/claude-history-host-process.ts" },
    { token: "https://api.experientiallabs.ai/v1/systemone", sourceFile: "src/backend/agent/jev-work-router.ts" },
  ];
  for (const item of required) {
    assert.ok(readFileSync(join(projectRoot, item.sourceFile), "utf8").includes(item.token));
    const packagedFiles = [...compiled].filter(([, text]) => text.includes(item.token)).map(([name]) => name);
    assert.ok(packagedFiles.length > 0, `The archive has no ${item.token} code marker.`);
    report.evidence.push({ ...item, packagedFiles });
  }

  const sourceTestPath = join(projectRoot, ".openbot-build/custom-server-updates-e2e/latest-report.json");
  const sourceTest = JSON.parse(readFileSync(sourceTestPath, "utf8"));
  assert.equal(sourceTest.passed, true, "Run the separate source updater E2E before package verification.");
  assert.deepEqual(sourceTest.variants, ["upstream", "custom"]);
  report.sourceUpdaterE2E = {
    passed: true,
    reportPath: sourceTestPath,
    reportSha256: await fileHash(sourceTestPath),
  };
  report.archiveSha256 = await fileHash(archivePath);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(reportRoot, "latest-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (!report.passed) throw new Error(report.error ?? "The custom package verification failed.");
