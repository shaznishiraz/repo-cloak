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

```
+-----------------------------------------------------------+
| repo-cloak                    [Repos v]  [Profiles] [Help] |
+----------------+------------------------------------------+
| Repos          |  northwind-platform-7c1e    @ feature-x   |
|  acme-platform |  status: 3 modified, 1 added             |
|   > ws 7c1e    |  last push  2026-10-16 14:05              |
|     ws 91ad    |  history  2026-10-16 12:30  pull 42 files |
|  other-repo    |  profiles: acme, common-secrets           |
+----------------+------------------------------------------+
```

The original dashboard shipped with **repos and workspaces** (list, status,
history), **profiles** (list, form editor, raw JSON, check conflicts). The dashboard now also supports
guided creation, refresh and restoration; see the sync wizard design below.

Sync workflows: [dashboard sync wizard](dashboard-sync.md), including
first-run setup, preview and confirmed extraction/restoration from the browser.

## Design

```
repo-cloak ui
   |
   +-- start node:http server on 127.0.0.1:<random port>
   +-- create random session token
   +-- open browser at http://127.0.0.1:<port>/#token=<token>
   |
   v
browser                               server (same process as the CLI)
+-----------------------------+       +--------------------------------+
| index.html  (one page)      |  GET  | static: index.html, app.js,    |
| app.js      (vanilla ES     | ----> |         app.css  (from dist/)  |
|              modules)       |       |                                |
| app.css                     |  JSON | /api/workspaces   list, open   |
|                             | <---> | /api/profiles     CRUD+validate|
|                             |       | /api/schema/:kind JSON Schema  |
+-----------------------------+       +---------------+----------------+
                                                      |
                                       shared application/ and core/ services
```

Choices:

- **No framework.** Plain HTML, CSS, and JavaScript. The existing tsup build
  minifies browser JavaScript into `dist/ui/`; HTML and CSS are copied.
  Shipped assets stay under 96 KB total.
- **`node:http` only.** No Express or similar; a small router over a handful
  of JSON routes.
- **No new logic.** Every route calls the shared `application/` and `core/`
  functions as the CLI, so the UI and CLI cannot disagree, and validation
  errors look the same in both.
- **Profiles are edited as forms backed by the JSON Schema**, with a raw JSON
  view for power users and LLM-written profiles.

Security:

- Bound to `127.0.0.1` only.
- Every API call needs the session token (sent as a header, never in logs).
- `Host` and `Origin` headers checked, to block DNS-rebinding and other sites
  calling the API.
- Server exits when the CLI process stops (Ctrl+C).

## Decisions

- Vanilla JS over Preact, htmx, or similar: zero dependencies and nothing to
  build, which matters more than developer convenience at this size. Revisited
  for the [rebuild](#rebuilt-dashboard-foundation): the classic UI stays vanilla
  until cutover.
- One UI per machine, opened on the current context; no background service.
- Repos and workspaces, profiles, Settings and the context-first sync wizard.
  CLI and dashboard use the same prepared plans and writers.

## Implementation (step 7)

`repo-cloak ui` and the interactive UI entry share one process per machine
store. `proper-lockfile` maintains a startup/shutdown guard at `ui.guard`;
`ui.lock` contains the port, PID and session token and is written atomically
with mode 0600 on POSIX. A second invocation authenticates the existing
server before reusing it. Stale guards recover after five seconds. Ctrl+C
or SIGTERM closes connections and removes both session files. Browser opening
uses `open` for macOS, Windows and Linux; `--no-open` prints the address.

The token starts in the URL fragment, is moved into tab-local session storage,
and is removed from the address bar. API requests use `Authorization: Bearer`.
No API request logging is enabled. Every response disables caching and sets a
content security policy; the server accepts only its loopback Host and Origin.
JSON write requests are limited to 1 MB. Only four named static assets (HTML,
JavaScript, CSS and the SVG favicon) are
served. All user-controlled text is rendered as text, not HTML.

```
GET     /api/session                       authenticate an existing server
GET     /api/repos                         registered repos and workspace links
GET     /api/workspaces/:repoId/:id         status and authenticated pull history
GET     /api/profiles[?repoId=...]           global and selected repo profiles
POST    /api/profiles                      create or update { scope, id?, profile }
DELETE  /api/profiles                      remove { scope, id }
POST    /api/profiles/check                validate [{ scope, id }, ...] together
GET     /api/schema/:kind                  shared JSON Schemas
```

The profile form reads rule types and boundary choices from the profile
schema. Raw JSON exposes advanced options and preserves extension fields.
Saving, importing and checking use the same validation, merge and encrypted
encrypted profile store as sync. Deletion is confirmed in the browser. Workspace
status uses the shared status service; history comes from the authenticated
manifest. Missing workspace folders are marked in the list.

Sources live in `src/ui/`. The CLI build copies HTML/CSS and minifies JavaScript into `dist/ui/` using
the existing tsup dependency. Tests enforce the 96 KB shipped asset budget.

## Browser regression automation

The separate `e2e/` test project uses TesterArmy's `e2e` runner and its
Playwright web engine. Versions are pinned while the framework is pre-1.0.
These deterministic tests use locators and assertions, without model calls.
The test dependencies do not enter the published CLI or change its Node floor.

```text
npm run test:browser
  build CLI assets -> bundle fixture -> e2e runner
    -> choose loopback port -> start fixture server
       -> temporary Git repo + encrypted store + extracted workspace
    -> fresh browser context per test -> assertions + failure traces
    -> stop fixture -> remove temporary files
```

The fixture exercises the real dashboard, store and sync adapters with
synthetic names. It never opens the user's private store. Tests cover changed
workspace status and pull history, fragment-token removal and reload,
profile form/JSON editing, invalid rules, extension preservation, compatibility
checks, canceled/confirmed deletion, and a 390-pixel layout. CI runs Chromium
on Ubuntu/Node 24 and retains reports and failure traces. The existing native
macOS/Windows/Linux CLI matrix remains required; this runner currently supports
Windows through WSL only.

## Compact profile and settings management

Profiles use a narrow list and a wider editor. Only the editor body scrolls;
its header and Save/Export actions remain visible. Rule controls use compact
rows and a labelled trash icon. Long profile names truncate in the list and
remain available on hover. On narrow screens, the open editor replaces the list.

```
Profiles                         [Check] [Import] [+ New]
----------------------+----------------------------------
[ ] Name       [Edit] | Profile name       [Delete] [Close]
    Scope · N rules   | Scope                   Form / JSON
                      | Name          Description
                      | Exclude       Include
                      | Rules                  [+ Add]
                      |         scrollable fields
                      |----------------------------------
                      | [Save profile] [Export JSON]
```

Settings uses separated sections with a shared field width and left-aligned Save
actions. Folder browsing sits alongside the path. Padded scroll areas and
shrinkable grid columns leave room for input borders and focus outlines. The
asset budget is 96 KB (previously 92 KB), allowing the additional responsive form
styles while keeping build and package size checks enforced. No dependencies
were added.

## Rebuilt dashboard (foundation)

Plan: [rebuild index](../rebuild/INDEX.md), visual reference:
[rebuild design](../rebuild/design/README.md). The sections above describe the
classic UI in `src/ui/`, which stays the default until cutover.

```
repo-cloak --next-ui  (or REPO_CLOAK_UI=next)
   |
   v
server.ts: same loopback bind, token, Host/Origin checks and CSP 'self'
   |
   +-- assets: dist/web/ (next) or dist/ui/ (classic); dist/web/supply-chain.json
   |
   +-- /api/*     classic routes, unchanged
   +-- /api/v2/*  server-v2/index.ts route table
                    foundation.ts  session, overview, operations/:id
                    home.ts new.ts push.ts profiles.ts admin.ts  (empty, one per package)

src/web/ (Preact + signals, bundled; devDependencies only)
   main.tsx --> shell/shell.tsx --> screens.tsx --> screens/<name>/index.tsx
   api/contracts.ts   types only, shared by server-v2 and the browser
   api/client.ts      typed fetch, ApiError, poll()
   shell/ui/          primitives; shell/commands.ts  palette command registry
```

- **One server per machine, one UI per server.** `/api/session` reports `ui`. A
  launch that asks for the other UI fails with a clear message rather than opening
  the wrong one. The v2 API is token-protected and present under both UIs; only the
  assets differ.
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
