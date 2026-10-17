# Testing and release confidence

Test counts alone are not a release criterion. The suite focuses on restoring
source files safely, keeping replacement mappings reversible, and preventing
unauthorized dashboard writes.

## Shortcut scripts

Run these from the repository root. They also work when invoked by an absolute
path from another directory. Each script stops on the first failed command.

| Script                      | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `./scripts/setup.sh`        | Install both locked dependency sets and Chromium (first run or dependency updates) |
| `./scripts/check.sh`        | Types, lint, backend coverage, build and package checks                            |
| `./scripts/test-browser.sh` | Browser test types and dashboard browser tests                                     |
| `./scripts/test-all.sh`     | All checks above, excluding dependency installation                                |

On Linux/WSL, run `./scripts/setup.sh --with-deps` to install Chromium's system
packages too; the installer may request administrator privileges. The scripts
use POSIX `sh` on macOS/Linux and WSL on Windows. Browser automation requires
Node 24.8+ or 22.22.3+ on the Node 22 line. Run setup before the check scripts.
Reports remain at `coverage/index.html` and `e2e/.e2e/`.

## Local checks

```bash
npm ci
npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm run test:package
```

`npm test` runs the same suite without coverage instrumentation. The HTML
coverage report is generated at `coverage/index.html`; a machine-readable
summary is at `coverage/coverage-summary.json`. Reports are ignored by Git.

Coverage includes **all backend TypeScript under `src/`**, including CLI and
prompt adapters. It does not measure the browser JavaScript. The dashboard's
API and main browser interactions have automated tests; layout and form
interactions have also been checked in BrowserOS neo. A browser smoke check remains part of release review.

## Regression floors

| Scope                  | Lines | Statements | Branches | Functions |
| ---------------------- | ----- | ---------- | -------- | --------- |
| All backend TypeScript | 85%   | 83%        | 75%      | 85%       |
| Core logic, combined   | 95%   | 93%        | 85%      | 98%       |

These are regression floors, not a claim that every behavior is tested. The
core gate is stricter because it transforms names, paths, secrets and restore
baselines. Do not exclude difficult files or raise timeouts to pass a gate;
inspect the missing behavior or resource contention first.

## Important behavior checks

- Exact replacement round trips, Unicode and case variants, path collisions,
  stable secret placeholders, residue rejection and regex capture semantics.
- Encryption authentication, wrong/missing keys, schema versions, opaque
  profile storage and concurrent writers.
- Dry runs and cancellation without destination or branch creation.
- Source conflicts, skipped conflicts, explicit overwrite, file creation and
  confirmed deletion.
- Partial write failure, restoration of deleted files and permissions, removal
  of newly created files, and private recovery copies if rollback also fails.
- A private-store failure after a successful save must preserve the completed
  source/workspace changes; retry repairs the record.
- New-worktree base selection, full snapshots, disabled hooks and rollback
  of newly created branches and worktrees.
- Simultaneous dashboard launches, stale locks, busy-port cleanup, API tokens,
  foreign Host/Origin rejection and unauthorized mutations leaving data intact.
- CLI error and conflict exit codes, quiet cancellation and JSON output.

The package smoke check executes the built CLI in a temporary workspace,
compares its schemas to shipped files, checks status without a private key,
checks malformed-import failure, and inspects the npm package file list and
UI asset budget. It does not read or write the user's private machine store.

## Release gates

CI runs the full suite and package checks on macOS, Windows and Linux with
Node 22 and 24. Ubuntu/Node 24 also enforces coverage floors and uploads the
report. `prepublishOnly` runs the local coverage and package checks too.

Before publishing:

1. Confirm all six CI jobs pass for the exact commit being released.
2. Smoke-test dashboard status/history and profile form/JSON editing in a
   browser, including a rejected invalid profile.
3. Try extract, edit and restore on a disposable representative repository.
4. Complete the migration/documentation checks in [plan.md](plan.md).

Ordinary I/O rollback is tested. A process or power failure is not an atomic
multi-file transaction; percentage coverage does not change that limitation.

## Automated dashboard browser tests

The isolated [e2e/](../e2e/) project uses
[TesterArmy e2e](https://github.com/tester-army/e2e) with its Playwright engine.
It requires Node **24.8+**, or **22.22.3+** on the Node 22 line. On Windows,
run this browser suite inside WSL; ordinary CLI checks still run natively.

```bash
npm ci
npm ci --prefix e2e
npm run test:browser
```

The first run downloads Chromium. On Linux, install system dependencies first:

```bash
cd e2e
E2E_TELEMETRY_DISABLED=1 npx --no-install e2e-web install chromium --with-deps
cd ..
```

The root command disables framework telemetry and builds the shipped UI before
running tests. It creates a temporary source repo, encrypted private store and
workspace using real adapters, binds a runner-selected loopback port, and
removes the fixture on shutdown. Each test gets a fresh browser context. No AI
subscription, API key, production data, or machine-store override is needed.

The suite covers status/history, token removal and reload, profile form/JSON
editing, rejected regex validation, extension preservation, compatibility
checks, canceled/confirmed deletion and a narrow layout. Results and JUnit XML
are in `e2e/.e2e/`, with traces retained on failure. CI uploads these for seven
days. They contain synthetic fixture data only. Both framework packages and
their dependency tree are locked separately from the CLI.

Browser tests complement backend coverage; they do not add browser JavaScript
to the V8 coverage percentages. Keep the manual release smoke check for actual
browser and operating-system behavior beyond the automated Chromium target.
