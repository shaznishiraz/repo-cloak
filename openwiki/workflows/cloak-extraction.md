---
type: workflow
title: "Cloak: extracting into a workspace"
description: How repo-cloak copies selected source files into an anonymized cloak workspace (push in a source worktree, pull inside a workspace to refresh), including destination rules, file selection, refresh semantics and conflicts, the manifest it writes, and the transactional write with rollback.
tags: [extraction, pull, push, workspace, manifest, selection, transactions]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-8ceff43a85f185d7d17dedb7
    resource: repo://src/adapters/git.ts
  - id: openwiki-source-b6ccbda2a46cd0f7093c23fa
    resource: repo://src/adapters/workspace-git.ts
  - id: openwiki-source-e34b8c2413afb9828759d6f0
    resource: repo://src/adapters/workspace.ts
  - id: openwiki-source-9a31df27307a75d8de6bd8be
    resource: repo://src/commands/pull-setup.ts
  - id: openwiki-source-39aa2e897ce9e4e7405895be
    resource: repo://src/commands/pull.ts
  - id: openwiki-source-cd1c967ebdc10e2badb82347
    resource: repo://src/commands/sync.ts
  - id: openwiki-source-6b07dbe542a43b1cfcd99637
    resource: repo://src/core/manifest.ts
  - id: openwiki-source-87e682078b57e3a0f0a360ca
    resource: repo://src/core/pull.ts
  - id: openwiki-source-57bc4d10bf83af780f255038
    resource: repo://src/core/selection.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Cloak: extracting into a workspace

Runs as `repo-cloak push` in a source worktree, or `repo-cloak pull` inside a
cloak workspace (refresh). See [routing](../architecture/cli-program.md).

```
preparePull ──────────────────────────────────────────────────────────────
  source:       current worktree, or (refresh) the worktree of the
                workspace's target branch  (sourceForWorkspace)
  destination:  --to <workspace id|name|path>
                | workspace linked to this branch   (refresh it)
                | new: <workspacesRoot>/<anonymized repo name>-<id8>
  profiles:     --profile | recorded in manifest | prompt
  paths:        files ∪ commit files ∪ working changes, filtered by profiles
runPull ──────────────────────────────────────────────────────────────────
  read source files (bounded concurrency) -> planPull (pure) -> dry-run?
  -> confirm profile changes / pull (unless --yes) -> save
save ─────────────────────────────────────────────────────────────────────
  lock workspace, recheck source + workspace, stage, write, git commit,
  then record in the store
```

## Destination

- `--to` matches a linked workspace by id or folder name, otherwise it is
  treated as a path.
- Without `--to`, the workspace linked to the current branch is refreshed;
  several candidates are asked about interactively and fail under `--yes`.
- A new workspace goes under `workspacesRoot` from `config.json`, asked once
  and saved. Its folder name is the repo name **after** applying the
  profiles, or `workspace` if that would not anonymize it.
- The destination must be separate from the source, may not be inside
  another Git repository, and must be empty when new.

## Selecting files

```
--files <paths...>   files or folders (expanded, metadata and excluded folders skipped)
--commit <ref>       files changed in a commit (diff-tree, including root and merge commits)
--working            staged, unstaged and untracked changes, with both sides of renames
```

The sources are combined, deduplicated, validated as portable relative paths
and filtered by the profiles' [file patterns](../concepts/profiles-and-file-patterns.md).
A first extraction needs at least one selection flag. A refresh without
selection flags refreshes the files the workspace already tracks; tracked
files are also included when profiles changed or `includeTracked` is set.

## The plan (`core/pull.ts`)

`planPull` is pure and decides everything before any write:

- Paths are anonymized first, then each text file with the
  [anonymizer](../concepts/anonymizer-engine.md), threading one ledger through
  the run. Binary files and invalid UTF-8 are copied unchanged with a warning.
- **Refresh conflicts:** a tracked file edited in the workspace is kept as
  is, unless its source also changed, which is a `ConflictError` (exit 2)
  with nothing written. Changing profiles while workspace files are edited,
  or without refreshing every tracked file, is refused.
- A source file that disappeared is deleted from the workspace; a renamed
  anonymized path deletes the old one.
- An untracked workspace file at a target path, or overlapping one, is never
  overwritten.
- Only files whose bytes changed are written.

### What the manifest records

```
plain (readable)   kind manifest v2, tool version, workspaceId, source.repoId,
                   files { anonymized path: hash, size, binary }, pulls history
sealed             source path + commonDir, origin {worktree, branch, commit, dirty},
                   target {branch}, profiles {id, name, scope, content hash},
                   merged rules, ledger, files { anonymized: original path,
                   sourceHash, executable }, pulls {commit, branch}
```

`origin` is reset on every extraction; `target` is kept from the previous
manifest, so a workspace keeps pointing at its push target.

## Writing (`adapters/workspace.ts`)

```
lock workspace -> recheck (source and workspace unchanged since planning)
-> manifest matches the expected one, new destination still empty
-> back up every affected file, stage the new bytes in a temp folder
-> prepare git (git init -b cloak, refuse staged destination files)
-> delete, write, chmod executables, commit "Refresh anonymized files"
-> record in the store (and save config if workspacesRoot was asked)
```

If anything fails after writing starts, every affected file is restored from
its backup, a freshly created `.git` is removed or the index reset, and new
empty folders are removed. If the rollback itself fails, the staged copies
are kept and their location is reported. A failure after the workspace was
saved only asks to retry so the store record can be repaired.

The workspace commit uses a private hooks folder, no signing, fixed line
endings and a `repo-cloak` author, so user Git settings cannot change the
anonymized bytes. `initGit: false` in `config.json` skips Git entirely.

## Related pages

- [Restore and Git worktrees](restore-and-worktrees.md)
- [Anonymizer engine](../concepts/anonymizer-engine.md)
- [Machine store, encryption and repository identity](../architecture/store-and-encryption.md)
- [Interactive mode](interactive-mode.md)
