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

Screens for the first version: **repos and workspaces** (list, status,
history), **profiles** (list, form editor, raw JSON, check conflicts). Pull
and push stay in the CLI at first; the buttons can come later.

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
                                       same commands/ and core/ as the CLI
```

Choices:

- **No framework, no build step for the UI.** Plain HTML, CSS, and
  JavaScript modules, copied into `dist/ui/`. Target: under 50 KB total.
- **`node:http` only.** No Express or similar; a small router over a handful
  of JSON routes.
- **No new logic.** Every route calls the same `commands/` and `core/`
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
  build, which matters more than developer convenience at this size. Revisit
  if the UI grows past a few screens.
- One UI per machine, opened on the current context; no background service.
- First screens: repos and workspaces, profiles. Pull and push stay in the
  CLI for now.

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
JSON write requests are limited to 1 MB. Only three named static assets are
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
profile store as the CLI. Deletion is confirmed in the browser. Workspace
status uses the shared status command; history comes from the authenticated
manifest. Missing workspace folders are marked in the list.

Sources live in `src/ui/`. The CLI build copies them into `dist/ui/` without
a frontend build tool or framework. Tests enforce the 50 KB asset budget.

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
