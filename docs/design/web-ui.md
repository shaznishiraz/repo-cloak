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
its `/api/*` routes are gone; packages 10-50 replaced every placeholder screen. Decisions
those packages made are under [Rebuilt screens](#rebuilt-screens).

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
audit log, and can resume after interruption. Not every writer takes the operation lock, so
each file is re-read immediately before resealing and scanning repeats until a pass finds
nothing on the old key. A file that cannot be read or parsed stops the rotation with the old
key intact. The remaining race is a write landing between that read and its reseal. If a workspace is unreachable the old key
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
- An invalid policy has unknown locked exclusions, so it blocks create, pull, agent
  probes and requests, and commit export until it is fixed. Status, history and restoring
  into the source still work, and Settings reports it.
- Changes apply within five seconds, without a restart.
- A policy file this account can write is still applied, but flagged as not enforced
  by the OS.
- `autoLockMinutes` drives a lock in the browser tab: `startAutoLock()` in `main.tsx`
  clears the tab's session after idle time. The token stays valid on the server.

### Supply chain

`.npmrc` sets `ignore-scripts=true` and `save-exact=true`, and every version is pinned.
`npm run sbom` writes CycloneDX; CI runs `npm audit --omit=dev --audit-level=moderate`
and uploads the SBOM. `scripts/supply-chain.ts` generates the numbers Settings shows.

`ignore-scripts` also stops `npm publish` running `prepublishOnly`, so that gate is now
`npm run release:check`, run by hand before publishing.

## Rebuilt screens

Each package owns `src/web/screens/<screen>/` and `src/adapters/server-v2/<area>.ts`.
Shared types live only in `src/web/api/contracts.ts`.

- **Agent decisions** are per file: the route id is `<request id>:<path>`. The inbox
  decides one file; Home decides a whole request by posting each file in turn, so a
  failure part way leaves earlier files decided and the list is refreshed.
- **Signatures-only pulls, auto-approve and allowed roots** return 501 and change nothing.
  The inbox shows them disabled; Home does not offer them.
- **Pins** persist as `pinned` in the repo document.
- **New cloak** takes `#/new?repo=&worktree=`, which Known repos uses for a worktree
  without a cloak. The folder field is fixed once Settings names a workspaces folder.
- **First run**: home redirects to `#/setup` once, when there is no workspaces folder and
  no workspace.
- **Push backups** go in `<git common dir>/repo-cloak-backups/`, unsealed. Merge output
  is a second locked write after the engine write, so a crash between them needs manual
  recovery.
- **Profiles** map the designed rule format onto schema v1; there is no `profile@2`,
  `extends` or `allowRoots`. Rule hits come from a capped on-demand scan.
- **Schema errors** reach the client as `Invalid request: <path>: <message>`, never raw JSON.
