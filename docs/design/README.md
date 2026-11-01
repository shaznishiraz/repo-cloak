# Design docs

How repo-cloak v2 is built. Written **before** the code, kept in sync with it.
One file per topic; see [`../README.md`](../README.md) for the full index.

| Doc                                                          | Covers                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| [overview.md](overview.md)                                   | Big picture, interactive flow, modules, push, build order    |
| [data-model.md](data-model.md)                               | Every JSON file, schemas, encryption, regex and secret rules |
| [cli.md](cli.md)                                             | Commands, flags, exit codes                                  |
| [anonymizer.md](anonymizer.md)                               | Case styles, word boundaries, matching, exact restore        |
| [sync.md](sync.md)                                           | Pull/push direction, multiple workspaces, git worktrees      |
| [web-ui.md](web-ui.md)                                       | The local web UI                                             |
| [hardening-60-sync-engine.md](hardening-60-sync-engine.md)   | Bulk group runs and pull from commit                         |
| [hardening-61-leak-guard.md](hardening-61-leak-guard.md)     | Heuristic leftover-name warnings                             |
| [hardening-62-push.md](hardening-62-push.md)                 | Crash-safe, per-file push and sealed backups                 |
| [hardening-63-profiles.md](hardening-63-profiles.md)         | Regex limits and profile@2                                   |
| [hardening-64-session-lock.md](hardening-64-session-lock.md) | Server-side session lock and relaunch                        |
| [hardening-65-enterprise.md](hardening-65-enterprise.md)     | Workspace Git safety, secret warnings, audit signing key     |

New design topics use the template below.

## Template

````markdown
# <Topic>

## Problem

What we need and why, in a few sentences.

## Design

```
+---------+      +-----------+      +--------+
|  input  | ---> |  process  | ---> | output |
+---------+      +-----------+      +--------+
```

Key types:

```ts
// the few types that define the shape of this feature
```

## Decisions

- Chose X over Y because ...

## Open questions

- ...
````
