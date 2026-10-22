---
type: integration
title: Local web dashboard
description: How `repo-cloak ui` runs one machine-wide local dashboard, how a second invocation reuses it, the loopback, token and header protections, the JSON API it exposes, and what it can and cannot do today (profiles and status, not extraction or restore).
tags: [dashboard, ui, http, security, api]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-c6f4629904c6f6890c5acb17
    resource: repo://src/adapters/server.ts
  - id: openwiki-source-64363449d6fd476df06ce5bc
    resource: repo://src/adapters/ui-session.ts
  - id: openwiki-source-52da1e7bdc19d6c570028d4f
    resource: repo://src/commands/dashboard.ts
  - id: openwiki-source-860d21594322ce7c732711ac
    resource: repo://src/ui-program.ts
  - id: openwiki-source-5bea248e2b9fb9c38d140ffe
    resource: repo://src/ui/app.js
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Local web dashboard

## Starting and reusing a session

```
repo-cloak ui [--port <n>] [--no-open]
   |
   +-- dashboard.context()       in a workspace -> its repoId + workspaceId
   |                              in a repo      -> register it, its repoId
   +-- startUiSession(~/.repo-cloak)
   |     guard lock ui.guard (stale after 5 s)
   |       held by someone else? read ui.lock, call GET /api/session with its token
   |         same app, protocol 1 and pid -> reuse that server (print "Using the running dashboard")
   |       acquired -> random 32-byte token, listen on 127.0.0.1:<port|free>,
   |                   write ui.lock {port, token, pid} atomically (0600)
   +-- open browser at http://127.0.0.1:<port>/#token=...&repo=...&workspace=...
   +-- Ctrl+C / SIGTERM -> close connections, delete ui.lock, release the guard
```

There is one dashboard per machine store, not per repository. It runs only
while the `repo-cloak ui` process runs; nothing stays in the background.
`--json` prints `{ url, reused }`; if the browser cannot be opened, the URL is
printed for manual use.

## Security model

| Protection        | How                                                                       |
| ----------------- | ------------------------------------------------------------------------- |
| Loopback only     | The server binds `127.0.0.1`                                              |
| Session token     | Every `/api/` call needs `Authorization: Bearer <token>`, compared in constant time |
| Host / Origin     | Requests whose `Host` or `Origin` is not the dashboard's own are refused (blocks DNS rebinding and other sites) |
| Token in the page | Taken from the URL fragment, kept in tab-local `sessionStorage`, then removed from the address bar |
| Headers           | `Cache-Control: no-store`, `nosniff`, `no-referrer`, and a strict content security policy (`'self'` only, no framing) |
| Requests          | JSON bodies only, at most 1 MB; request and header timeouts               |
| Assets            | Only `index.html`, `app.js` and `app.css` are served                      |
| Rendering         | User-controlled text is set with `textContent`, not HTML                  |

## API

```
GET    /api/session                     app, protocol and pid (used to verify reuse)
GET    /api/repos                       registered repos with their workspaces (missing folders flagged)
GET    /api/workspaces/:repoId/:id      status, pull history (newest first), profile names
GET    /api/profiles[?repoId=...]       global profiles, plus the repo's when given
POST   /api/profiles                    create or update { scope, id?, profile }
DELETE /api/profiles                    remove { scope, id }
POST   /api/profiles/check              validate several profiles together
GET    /api/schema/:kind                JSON Schema for profile, repo, manifest or config
```

Handlers live in `commands/dashboard.ts` and reuse the CLI's building blocks:
the same sealed profile store, `validateProfile`, `mergeProfiles` and the
status command. A repo-scoped request is refused unless that repository is
registered, and a workspace is only shown when its manifest matches the
requested repo and workspace ids. Errors come back as `{ error }` with 4xx
status codes.

## The page

Plain HTML, CSS and JavaScript with no framework or build step
(`src/ui/`, copied into `dist/ui/` by the build). It lists repositories and
workspaces, shows a workspace's status and history, and edits profiles
through a schema-driven form or raw JSON, including exclude/include file
patterns and a combined compatibility check.

Extraction and restore are not available in the dashboard; they stay in the
CLI.

## Related pages

- [Profiles, rules and file patterns](../concepts/profiles-and-file-patterns.md)
- [Machine store, encryption and repository identity](../architecture/store-and-encryption.md)
- [Development workflow and quality gates](../workflows/development-workflow.md) (browser tests)
