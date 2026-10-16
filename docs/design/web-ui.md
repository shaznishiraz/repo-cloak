# Web UI

Status: **draft, not agreed**. Implements requirement R7.

## Problem

A browser UI to manage workspaces, profiles, and rules, shipped inside the npm
package without making it heavy or slow to install.

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

## Open questions

- Which screens are needed for the first version? Suggested: workspaces list,
  profile list and editor, pull history.
