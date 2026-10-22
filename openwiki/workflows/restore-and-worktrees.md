---
type: workflow
title: Restore and Git worktrees
description: How repo-cloak writes workspace changes back to the source (push in a workspace, pull in a source worktree) - finding the workspace and the target worktree by branch, planning the full restore in memory, detecting source conflicts, writing all-or-nothing with rollback, restoring into a new Git worktree, and reporting workspace status.
tags: [restore, push, worktrees, conflicts, transactions, status]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-73982cfdaedbbf42cbf640a9
    resource: repo://src/adapters/source-writer.ts
  - id: openwiki-source-dc3fabbf75964d2670eec523
    resource: repo://src/adapters/worktree.ts
  - id: openwiki-source-437accf12711b0a40d73a08c
    resource: repo://src/commands/pull-source.ts
  - id: openwiki-source-2d68cba4c76aeebb96f1fd07
    resource: repo://src/commands/push-worktree.ts
  - id: openwiki-source-72784f9084778283ee42fa5d
    resource: repo://src/commands/push.ts
  - id: openwiki-source-2b3964b0c7d910af4539ffa5
    resource: repo://src/commands/workspaces.ts
  - id: openwiki-source-f9a873c81dafb74714ac5ace
    resource: repo://src/core/push.ts
  - id: openwiki-source-39c1a8913a3bf48ef7c6aa48
    resource: repo://src/core/status.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Restore and Git worktrees

Runs as `repo-cloak push` inside a cloak workspace, or `repo-cloak pull` in a
source worktree. See [routing](../architecture/cli-program.md).

```
find the workspace ────────────────────────────────────────────────────
  in a workspace:       this one
  in a source worktree: --from <id|name|path> | the one linked to this branch
                        | ask (several; fails under --yes)
find the target ───────────────────────────────────────────────────────
  --worktree <path>          that worktree
  --new-worktree <branch>    create one from --base (default: extracted commit)
  otherwise                  the worktree that has the target branch checked out
plan (pure, in memory) ────────────────────────────────────────────────
  restore every changed / added / deleted workspace file + new paths
  compare each target with the source hash recorded at extraction
     changed since?  -> conflict  (stop, exit 2 | --skip-conflicts | --force)
write ─────────────────────────────────────────────────────────────────
  lock workspace + source, recheck everything, back up, write, update manifest,
  record in the store; roll back on failure
```

## Finding the target worktree

A workspace remembers a **branch**, not a folder (`target.branch` in the
sealed manifest). `sourceForWorkspace` asks Git which worktree currently has
that branch checked out, so a moved worktree is still found. When the branch
is not checked out anywhere, restore asks for `--worktree`. A workspace whose
target is a detached HEAD needs `--worktree` or `--new-worktree`. The chosen
worktree must belong to the same repository.

## The plan (`core/push.ts`)

`planPush` restores in memory before any source file is touched:

- Workspace files whose hash equals the extraction baseline are skipped.
- Changed text files are restored with the [anonymizer](../concepts/anonymizer-engine.md)
  using the manifest's saved rules and ledger (not the current profiles), so
  editing a profile later never changes how a workspace restores. Binary
  files are copied with a warning.
- New workspace files get their original path by restoring the path.
- Files deleted in the workspace become deletions in the source.
- Restored paths are checked for collisions.

### Conflicts

For each target, the current source file is compared with the `sourceHash`
and executable bit recorded at extraction. If it changed and the restored
result is not already identical:

| Flags              | Result                                                            |
| ------------------ | ----------------------------------------------------------------- |
| none               | `ConflictError`: lists the files, **writes nothing**, exit code 2 |
| `--skip-conflicts` | writes everything else; conflicts are reported as warnings        |
| `--force`          | overwrites the changed source files                               |

`--force` and `--skip-conflicts` cannot be combined. Deletions are listed
and need confirmation unless `--yes`.

## Writing (`adapters/source-writer.ts`)

```
lock workspace, lock source (git common dir)
recheck: manifest, workspace files, source files, source inventory,
         branch and HEAD unchanged since planning          -> else "retry"
[--new-worktree: create the worktree now]
refuse targets through symlinks or into nested repositories
back up every affected file and the manifest
delete, write (executable bit preserved), write the new workspace manifest
record in the store
```

On an ordinary failure every backed-up file is restored, new files and empty
folders are removed, and a new worktree is removed again. If the rollback
itself fails, recovery copies and an `index.json` are written to a private
temp folder and its path is reported. Restored changes stay **uncommitted**
in the source for review.

## Restoring into a new worktree

`--new-worktree <branch> [--base <ref>] [--path <dir>]`, from a workspace:

- The base defaults to the commit the workspace was extracted from.
- The path defaults to `<repo-parent>/<repo-name>-<branch>` (`/` in the
  branch becomes `-`), or the `worktreePath` folder from `config.json`.
- The branch name must be valid and new, and the folder must not exist or be
  inside the source, the workspace, another Git repository or a cloak
  workspace.
- The plan reads the base commit's files straight from Git objects (no
  checkout), refusing symlinks, submodules and unusual modes. A brand-new
  worktree cannot conflict, and the full workspace snapshot is written. If
  the extraction included uncommitted changes, a warning says they are
  included.
- The branch is created with a compare-and-swap ref update, and Git hooks are
  disabled during `worktree add`. Rollback removes the worktree and deletes
  the branch only if it still points at the base.
- From then on the workspace targets the new branch.

## Status and listing

- `repo-cloak status` compares workspace bytes with the plain manifest
  hashes and lists added, modified and deleted files. It needs no key.
- `repo-cloak workspaces` lists workspaces linked to the current repository,
  most recent first, with their origin and target branches.

## Related pages

- [Cloak: extracting into a workspace](cloak-extraction.md)
- [Anonymizer engine](../concepts/anonymizer-engine.md)
- [CLI entrypoint and command routing](../architecture/cli-program.md)
