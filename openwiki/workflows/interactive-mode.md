---
type: workflow
title: Interactive mode
description: The guided `repo-cloak` flow with no arguments - how it picks the source repository and worktree, which actions it offers in a source or a workspace, how profiles are chosen or created with live conflict checks, the selection prompts including typed commit IDs, and how answers are passed to the same sync commands as the CLI flags.
tags: [interactive, prompts, worktrees, profiles, selection, ux]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-8ceff43a85f185d7d17dedb7
    resource: repo://src/adapters/git.ts
  - id: openwiki-source-a890982e6d5a196869d45a66
    resource: repo://src/adapters/interactive.ts
  - id: openwiki-source-8e2e2c94194d44a6442c70c8
    resource: repo://src/adapters/prompts.ts
  - id: openwiki-source-1d190beb50c234a67f3a6c87
    resource: repo://src/adapters/sync-services.ts
  - id: openwiki-source-32ddcb8628672cd1a1f31996
    resource: repo://src/commands/interactive.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Interactive mode

`repo-cloak` with no command needs a terminal (see
[routing](../architecture/cli-program.md)). It only collects answers; the
actual work is done by the same `createSyncCommand` that `push` and `pull`
use, so prompts and flags cannot behave differently.

```
repo-cloak
  inside a cloak workspace? ── yes ─> menu: refresh, restore, status, dashboard, exit
  │ no
  ├─ Source repository   current directory's repo (default) | registered repos (A-Z)
  │                      | "Enter a path..." (relative or ~/..., must be a Git repo)
  ├─ Worktree            only when the repo has several; default: the current
  │                      worktree, else the main one; missing folders hidden
  │  (everything below runs in that worktree)
  ├─ register the repo in the store
  ├─ menu: refresh / restore / status (if workspaces are linked), new workspace,
  │        dashboard, exit
  ├─ Profiles            multi-select, repo and global, last-used preselected,
  │                      "+ Create a profile", combined set validated live
  ├─ What to include     previously tracked files | repository tree |
  │                      recent commits | specific commits (typed) |
  │                      working changes | extra paths
  └─ run push (new/refresh from source) or pull (refresh in workspace)
       -> workspaces root prompt, preview and confirmation come from the sync code
```

## Source and worktree

The source prompt is skipped only inside a cloak workspace, where the source
comes from the manifest. Known repositories come from the store and only
those whose folder still exists are listed. A typed path is resolved against
the current directory, `~` means the home folder, and it must be inside a Git
repository.

Worktrees come from `git worktree list`; the first entry is labeled
`(main worktree)`. After the choice, interactive mode continues with services
rooted in that worktree, so typed commit IDs, the file tree and the new
workspace link all use its branch.

## Choosing the workspace

Workspaces linked to the current branch are ranked first. If several remain,
the user picks one. "New workspace" always creates a separate workspace.

## Profiles

The checkbox validates the combined selection on every change with
`mergeProfiles`, so a conflict shows inline before continuing. "+ Create a
profile" asks for a name and scope (this repository or all repositories) and
opens a validated JSON editor prefilled with empty `rules`, `exclude` and
`include`; the new profile is then preselected.

## What to include

- **Repository tree:** every eligible file after profile and default
  exclusions, shown indented.
- **Recent commits:** the last 20 commits by subject.
- **Specific commits:** a loop asking for a commit ID, short ID, branch or
  tag. Each entry is checked against the repository as it is typed; unknown
  refs are rejected, at least one is required, and duplicates (including
  ones already ticked under recent commits) are dropped. Refs are stored as
  full commit IDs.
- **Working changes**, **extra paths** typed one per line, and, for an
  existing workspace, **previously tracked files** (checked by default).

Picked paths are made absolute against the repository root, so starting in a
subdirectory does not change what is selected.

## Workspaces root

When a new workspace needs a location and none is saved, the prompt is
prefilled (as editable text) with the directory `repo-cloak` was started in,
or with the folder that holds the repository when started inside one, since a
workspace may not live inside its source. Relative answers resolve from the
start directory. The answer is saved as `workspacesRoot`.

## Related pages

- [Cloak: extracting into a workspace](cloak-extraction.md)
- [Restore and Git worktrees](restore-and-worktrees.md)
- [Profiles, rules and file patterns](../concepts/profiles-and-file-patterns.md)
