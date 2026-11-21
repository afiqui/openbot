# Custom server maintenance

The custom server keeps OpenBot's released agent identity, database and Team API.
Local features must stay in source control when the upstream source changes.
A source update does not install or restart an application.

## Build identity and update policy

Build the main process with `__OPENBOT_CUSTOM_SERVER_BUILD__` set to a JSON object:

```json
{
  "format": 1,
  "buildId": "local-example",
  "upstreamCommit": "<full upstream commit SHA>",
  "upstreamVersion": "<upstream application version>",
  "builtAt": "<UTC ISO timestamp>"
}
```

Keep the same object in the package build manifest. Record the source branch,
custom patch commits, application version and package hashes with the build.
Do not put profile paths, account data or credentials in that record.

The main-process define is part of the compiled application. Runtime environment
variables cannot remove it. A custom build refuses to load the official Electron
updater. Its update service reports the existing `unsupported` state and does not
check, download or install official packages. The newer-database recovery path
uses the same updater loader and cannot install an official package either.
This policy preserves the existing remote update API and its released states.

Source runs without the define keep upstream update behavior. A custom release
must include the define; a separate resource file alone does not enable this
protection. Verify the compiled marker and updater refusal before release.

Run these focused checks one at a time after staging the package:

```powershell
bun scripts/custom-server-updates-e2e.ts
bun scripts/verify-custom-server-package.ts dist/server-work-v3/win-unpacked
bun scripts/verify-windows-package.ts dist/server-work-v3/win-unpacked
```

The custom package verifier reads the staged ASAR without starting OpenBot. It
compares the compiled build record with the source build settings and checks
that the work policy, dispatch and discovery code markers are present. Its
report is `.openbot-build/custom-server-package-verification/latest-report.json`.
This static check does not invoke packaged tools or the packaged updater. The
source updater E2E separately checks update refusal, and the Windows verifier
checks an isolated package launch. Keep these results separate in build records.

An administrator can still install a package outside OpenBot. Install only a
complete validated custom package when local features must stay available.
Read-only upstream release discovery can report a newer official version. That
report does not mean the custom server can install the official release.

## Integrate upstream changes

1. Preserve all existing source changes. Keep custom changes as separate commits
   by feature. Do not discard the earlier custom checkout.
2. Use a private fork as writable `origin` and the official repository as
   read-only `upstream`. Keep the upstream tracking branch free of custom edits.
3. Fetch upstream refs. Select and record the exact upstream commit to test.
4. Merge that commit into a custom integration branch. Resolve each conflict
   against the feature's required behavior. Remove a local patch only after
   upstream provides the same behavior and its process test passes.
5. Keep shared branch history. Rebase only unpublished local patches. Do not
   force-push a shared branch as a routine sync step.
6. Run focused process tests one at a time. Check database preservation,
   startup cancellation and failure, queue limits, task routing, restart
   recovery and released remote-client behavior. Leave broad checks to CI.
7. Build a complete package with a new build record. Verify native runtimes,
   Electron fuses, ASAR integrity, helper files and an isolated-profile launch.
8. Stage the package. Install it at an agreed safe restart. A merge or a
   successful test is not permission to restart the live server.

## Data and compatibility

Never skip database integrity checks to reduce startup time. A loading window
proves that the UI responds; authenticated API readiness proves that the server
can serve work. Record loading, database preparation, renderer and API readiness
separately when comparing startup performance.

Keep released database migrations unchanged. A new migration must preserve all
released source schemas and update the separate schema for new installations.
A newer database can make an earlier application package unable to read it.
Retain the previous package, but check schema compatibility before a rollback.
Do not start an older release against a newer live database.

Keep released Team API adapters and meanings unchanged. Use optional negotiated
capabilities for additive features. A missing custom feature must not break an
older remote client's normal chat or queue controls.
