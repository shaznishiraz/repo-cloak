# Web UI

Status: **agreed**. Implements requirement R7.

## Problem

A browser UI to manage workspaces, profiles, and rules, shipped inside the npm
package without making it heavy or slow to install.

## One UI for everything

There is **one** UI per machine, not one per repo or workspace. Profiles are
global as well as per repo, and workspaces span repos, so one place sees it
all. It only runs while `repo-cloak ui` runs; there is no background service.

```
repo-cloak ui   (run anywhere)
   |
   +-- UI already running?  (~/.repo-cloak/ui.lock, mode 0600: port, token, pid)
   |      yes -> open the browser on it, exit
   |      no  -> start server, write ui.lock, open browser
   |
   +-- opens on the current context:
          in a cloak workspace   -> that workspace
          in a source worktree   -> that repo (its workspaces and profiles)
          elsewhere              -> home: all repos and workspaces
```

Sync workflows: [dashboard sync wizard](dashboard-sync.md), including
first-run setup, preview and confirmed extraction/restoration from the browser.

## Session and security

`repo-cloak ui` and the bare launcher share one process per machine store.
`proper-lockfile` maintains a startup/shutdown guard at `ui.guard`; `ui.lock` holds
the port, PID and session token and is written atomically with mode 0600 on POSIX. A
second launch authenticates through `GET /api/session` before reusing the server.
Stale guards recover after five seconds. Ctrl+C or SIGTERM closes connections and
removes both session files. `--no-open` prints the address instead of opening it.

- Bound to `127.0.0.1` only, on `node:http` with no framework.
- The token starts in the URL fragment, moves to tab-local session storage and leaves
  the address bar. API requests use `Authorization: Bearer`, and nothing logs them.
- `Host` and `Origin` are checked to block DNS rebinding and other sites.
- Every response disables caching and sets a `'self'` content security policy. JSON
  bodies are limited to 1 MB. Only the named static assets are served.
- Every route calls shared `application/` and `core/` functions, so validation is
  the same everywhere. User-controlled text renders as text, not HTML.

## Browser regression automation

The separate `e2e/` test project uses TesterArmy's `e2e` runner and its Playwright
web engine, pinned while the framework is pre-1.0. Tests use locators and assertions,
without model calls, and the test dependencies stay out of the published CLI.

```text
npm run test:browser
  build CLI assets -> bundle fixture -> e2e runner
    -> choose loopback port -> start fixture server
       -> temporary Git repo + encrypted store + extracted workspace
    -> fresh browser context per test -> assertions + failure traces
    -> stop fixture -> remove temporary files
```

The fixture uses the real dashboard, store and sync adapters with synthetic names and
never opens the user's private store. The suite covers the shell today; each screen
package adds its own journeys.

## Rebuilt dashboard (foundation)

Plan: [rebuild index](../rebuild/INDEX.md), visual reference:
[rebuild design](../rebuild/design/README.md). The vanilla dashboard in `src/ui/` and
its `/api/*` routes were removed before the screens landed, so **until packages 10-50
merge, this branch's dashboard is the shell with placeholder screens and cannot run a
sync**. The engine and its tests are unaffected.

```
repo-cloak
   |
   v
server.ts: same loopback bind, token, Host/Origin checks and CSP 'self'
   |
   +-- assets: dist/web/, including supply-chain.json
   |
   +-- /api/session  lets a second launch authenticate this server, nothing else
   +-- /api/v2/*  server-v2/index.ts route table
                    foundation.ts  session, overview, operations/:id
                    home.ts new.ts push.ts profiles.ts admin.ts  (empty, one per package)

src/web/ (Preact + signals, bundled; devDependencies only)
   main.tsx --> shell/shell.tsx --> screens.tsx --> screens/<name>/index.tsx
   api/contracts.ts   types only, shared by server-v2 and the browser
   api/client.ts      typed fetch, ApiError, poll()
   shell/ui/          primitives; shell/commands.ts  palette command registry
```

- **A package touches its own files.** Each has a `screens/<name>/` stub and a
  `server-v2/<package>.ts` route array already registered, typed against
  `contracts.ts`. Screens add palette entries with `registerCommands`.
- **Polling, not SSE.** The server keeps its 15 second request timeout. `poll()`
  skips hidden tabs after the first load and refreshes as soon as a tab is shown.
- **Budget.** `dist/web` (JS, CSS, HTML) is limited to 160 KB by test and by
  `check-package`. No fonts are bundled or fetched: the stack falls back to system
  fonts. `--faint` fails 4.5:1, so it is for decoration only.

### Audit log

`core/audit.ts` is pure: strict event schema, canonical hash, `prevHash` chain and
`verifyChain`, which reports the first broken link. `adapters/audit-store.ts`
appends sealed JSONL to `audit/log.jsonl` under a lock with fsync, keeps a sealed
`audit/head.json` to detect a cut tail, and leaves an anchor line when retention
prunes old events. Events hold who (OS username), when, op, workspace, paths and
hashes, profile versions and keyId, never file contents. Settings events name the
changed fields only, because post-create commands can contain anything.

Recording never fails the user's operation; failures are counted and reported as
`auditFailures` in the session. Create, pull, push, delete, exclusions and settings
changes, agent request decisions and key rotation or migration are all recorded.

Limits: the chain is tamper-evident, not tamper-proof. Someone holding the key can
rewrite the log and its head together, and deleting log and head together, or
restoring both from an older backup, cannot be told apart from a fresh or older log.

### Key storage

`keyStorage: auto | keychain | file`. `adapters/keychain.ts` uses macOS `security`
(the key goes through stdin, never argv), Linux `secret-tool` and Windows DPAPI via
PowerShell, with `execFile` only. `auto` uses the keychain for new installs and keeps
an existing key file working until `dashboard.security.migrateKey`. A `key.ref` marker
stops a second key being generated when the keychain is unreachable.

`rotateStoreKey` preflights, then reseals store documents, workspace manifests and the
audit log, and can resume after interruption. If a workspace is unreachable the old key
is retained in `key.previous` and the result lists it as `pending`. Manifests already
committed to a workspace's Git history stay sealed under the old key.

Only the default store root uses the keychain and machine policy. Any other root is
file-only, so tests can never reach a real keychain.

### Org policy

`core/policy.ts` holds the schema and `effectiveSecurity`; `adapters/policy.ts` reads
`policy.json` from `/Library/Application Support/repo-cloak/`, `/etc/repo-cloak/` or
`%ProgramData%\repo-cloak\`, with an optional Ed25519 `policy.json.sig` checked against
`policy.pub`. Policy values override config and are reported as locked; saving a locked
setting is rejected.

- Locked exclusions merge into `readRepo` and are never persisted. Writes use the raw
  record. A locked file cannot be overridden, even with `includeExcluded`.
- An invalid policy fails closed on exclusion overrides and is reported in Settings.
- A policy file this account can write is still applied, but flagged as not enforced
  by the OS.
- `autoLockMinutes` is stored and reported only. Locking behaviour belongs to 50-admin.

### Supply chain

`.npmrc` sets `ignore-scripts=true` and `save-exact=true`, and every version is pinned.
`npm run sbom` writes CycloneDX; CI runs `npm audit --omit=dev --audit-level=moderate`
and uploads the SBOM. `scripts/supply-chain.ts` generates the numbers Settings shows.

`ignore-scripts` also stops `npm publish` running `prepublishOnly`, so that gate is now
`npm run release:check`, run by hand before publishing.
