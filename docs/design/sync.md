# Sync: direction, multiple workspaces, worktrees

Status: **draft, planning**. Extends [overview.md](overview.md) (push) and
[cli.md](cli.md) (`pull`, `push`).

## Problem

1. `pull` and `push` should do the obvious thing from **either side**.
2. A source repo can have **several** cloak workspaces.
3. Work happens in **git worktrees**: a workspace is often pulled from `main`,
   but its changes belong on a feature branch, in an existing or a new
   worktree.

## 1. Direction: relative to where you stand

`pull` always brings changes **here**. `push` always sends changes **there**.

```
                    pull  (bring here)            push  (send there)
                    ------------------            ------------------
in a cloak         source  --> workspace          workspace --> source
workspace          (refresh from source)          (restore + write back)

in a source        workspace --> source           source --> workspace
repo/worktree      (bring in agent's work)        (refresh the workspace)
```

So the same two words cover the four moves, and there are only **two
operations** underneath:

```
anonymize-and-copy   source -> workspace   (cloak pull,  source push)
restore-and-write    workspace -> source   (cloak push,  source pull)
```

`push --from <workspace>` in the earlier draft becomes `pull --from
<workspace>` when run in a source repo.

## 2. Which side am I on?

```
repo-cloak <cmd>
   |
   +-- .repo-cloak/manifest.json here or in a parent?  --> cloak workspace
   |
   +-- inside a git repo/worktree?
   |      repoId = hash(git common dir)  --> known in store? --> source repo
   |                                     --> unknown         --> new source repo
   |
   +-- neither --> error: "not a repo-cloak workspace or git repo"
```

`repoId` changes from "hash of the top-level path" to **"hash of the git
common dir"** (`git rev-parse --git-common-dir`). Every worktree of a repo
shares one common dir, so all worktrees share the same profiles, workspaces,
and suggestions.

## 3. Several workspaces for one source

```
source repo  acme-platform
   |
   +-- workspace  northwind-billing   last used 10 min ago   <- latest
   +-- workspace  northwind-auth      last used 2 days ago
   +-- workspace  northwind-spike     last used 3 weeks ago (missing on disk, hidden)
```

Choosing one, when running `pull` or `push` in a source repo:

| Situation                          | Behavior                             |
| ---------------------------------- | ------------------------------------ |
| `--from` / `--to <workspace>`      | Use it (name, id, or path)           |
| Workspace linked to current branch | Use it                               |
| Exactly one workspace              | Use it                               |
| Several, interactive               | Pick from a list, latest preselected |
| Several, `--yes`                   | Fail and require `--from` / `--to`   |

## 4. Worktrees

### What a pull records

Each workspace is linked to a **branch**, not a folder. Git knows which
worktree has a branch checked out (`git worktree list --porcelain`), and a
branch can be checked out in only one worktree at a time, so the branch is
enough to find the folder, even after `git worktree move`.

```
manifest (sealed)
  origin:                                    set by each pull
    branch:   feature-x                      (null when detached)
    commit:   a1b2c3d                        (HEAD at pull time)
    dirty:    true | false                   (working changes were pulled)
    worktree: /work/acme-platform-feature-x  (informational only)
  target:                                    where push goes; default = origin
    branch:   feature-x
```

### Two ways to start, one model

Both directions are supported; they differ only in whether `target` starts
equal to `origin`.

```
A. Start in the feature worktree (everyday)      B. Start on main, branch later

   /work/acme-platform-feature-x                    /work/acme-platform  (main)
     $ repo-cloak                                     $ repo-cloak
       origin = target = feature-x                      origin = target = main
                                                      ...agent works...
   cloak workspace                                    cloak workspace
     $ repo-cloak push                                  $ repo-cloak push --new-worktree feature-x
       -> worktree of feature-x                          -> git worktree add -b feature-x <path> a1b2c3d
                                                          -> target = feature-x from now on
```

### Flow B in detail

```
main worktree                 cloak workspace               feature worktree
/work/acme-platform           ~/cloak/northwind             /work/acme-platform-feature-x
(branch main)                                               (branch feature-x)

   |   1. pull (from main)        |                                |
   |----------------------------->|                                |
   |                              |  2. agent edits files          |
   |                              |                                |
   |                              |  3. push --new-worktree feature-x
   |                              |------------------------------->|  git worktree add
   |                              |                                |  -b feature-x
   |                              |                                |  <path> a1b2c3d
   |                              |                                |  then restore + write
   |                              |  4. later pushes go here       |
   |                              |------------------------------->|  (remembered target)
```

### Choosing the push target

```
repo-cloak push   (in a cloak workspace)
   |
   +-- --worktree <path>             -> that existing worktree (its branch becomes target)
   +-- --new-worktree <branch>       -> create one, then push into it
   |      [--base <ref>]                base default: origin.commit
   |      [--path <dir>]                path default: see below
   +-- otherwise                     -> target branch
   |
   +-- resolve target branch to a folder via `git worktree list --porcelain`:
   |     checked out in a worktree    -> push there
   |     exists, not checked out      -> offer to create a worktree for it
   |     deleted                      -> ask for a new target (fail under --yes)
   |
   +-- safety checks:
         same repo (common dir)?      no  -> error
         conflicts? (see overview)    yes -> stop, write nothing, exit 2
```

Interactive mode asks the same question as a list:

```
? Push changes to:
  > feature-x   /work/acme-platform-feature-x   (target)
    main        /work/acme-platform
    + new worktree from a1b2c3d...
```

### New worktrees

- Created with `git worktree add -b <branch> <path> <base>`.
- **Base defaults to the pulled commit**, so the workspace's starting point
  and the new branch match exactly.
- Default path: `<repo-parent>/<repo-name>-<branch>` (for example
  `/work/acme-platform-feature-x`), configurable in `config.json`.
- Tracked workspace files replace their base versions in a new worktree.
  New agent files are still checked against unrelated base files so they
  cannot silently overwrite them.
- If the pull included **uncommitted** working changes (`dirty: true`), those
  are not in the new branch. Push writes the full workspace version of every
  pulled file, so they arrive with the agent's edits, and the summary says so.

### Refreshing a workspace (cloak pull)

```
repo-cloak pull   (in a cloak workspace)
   source = --worktree <path>  |  remembered target  |  origin worktree

   for each file:
     source changed, workspace unchanged  -> update workspace
     source unchanged, workspace changed  -> keep workspace edit
     both changed                         -> conflict: stop, write nothing
```

Refreshing from the target worktree is what you want mid-feature: it brings
in teammates' commits on `feature-x` without losing the agent's edits.

## 5. First run from a worktree

```
$ cd /work/acme-platform-feature-x
$ repo-cloak

  source repo   acme-platform (known)       branch feature-x
  workspace     none linked to feature-x yet

? Workspaces root (asked once):  ~/cloak
? Profiles:  [x] acme (repo)  [x] common-secrets (global)  [ ] + new profile
? Pull:      [x] working changes  [ ] commits  [x] files...
  preview:   42 files, 318 replacements, 1 secret redacted
? Pull into ~/cloak/northwind-platform-7c1e?  Yes

  linked     ~/cloak/northwind-platform-7c1e  <->  acme-platform @ feature-x
```

Running `repo-cloak` again in the same worktree finds the linked workspace
and offers pull, push, status, ui, or a new workspace.

Rules:

- **No init command.** The first `repo-cloak` (or `repo-cloak push`) in a
  worktree creates and links the workspace.
- **Workspaces root** is asked once and saved as `workspacesRoot` in
  `config.json`. `pull --to <dir>` overrides it for one workspace. The root
  must not be inside a source repo.
- **Profiles come first**, because the workspace folder name is anonymized
  with them: `<anonymized repo name>-<short id>`. Folder names never contain
  the original repo or branch name.
- **Branch names can be sensitive** (`feature/acme-sso`), so they are only
  stored sealed, and shown anonymized in the workspace and UI.
- **Detached HEAD**: pull works, but push then needs `--worktree` or
  `--new-worktree`.
- **Workspace is a git repo** (`git init` plus a first commit after each pull)
  so the agent's changes are easy to review with `git diff`. Configurable
  with `initGit` in `config.json`.
- **Smart profile suggestions on first run**: candidate names from the repo
  name, the git remote's owner, and package or module names, offered as rules
  for a new profile.

## CLI changes

```
repo-cloak pull
  in a cloak workspace:   [--worktree <path>]
  in a source repo:       [--from <workspace>]          (was push --from)

repo-cloak push
  in a cloak workspace:   [--worktree <path>]
                          [--new-worktree <branch> [--base <ref>] [--path <dir>]]
  in a source repo:       [--to <workspace>]            (refresh that workspace)
```

`repo-cloak workspaces` gains columns for origin branch and target branch.

## Key types

```ts
interface WorktreeRef {
  worktree: string; // absolute path
  branch: string | null; // null when detached
  commit: string; // HEAD sha
}

interface WorkspaceLink {
  origin: WorktreeRef & { dirty: boolean }; // set by each pull
  target: WorktreeRef | null; // remembered push target
}

type Side = 'workspace' | 'source';
```

## Decisions

- Direction is relative to the current directory: `pull` = into here,
  `push` = to the other side.
- `repoId` is based on the git common dir, so worktrees share one identity.
- One cloak workspace targets one branch at a time. Several features in
  parallel = several workspaces.
- Workspaces link to a **branch**; the folder is looked up from git each time.
- Both starting points are supported: from the feature worktree (target =
  origin), or from main with `push --new-worktree`.
- No `init` command; the first run in a worktree creates the workspace under
  the configured workspaces root.

## Open questions

1. Resolved: several workspaces without a unique branch link require
   `--from` / `--to` under `--yes`.
2. Resolved: default to a sibling `<repo>-<branch>` folder, replacing branch
   slashes with hyphens. `worktreePath` overrides the parent directory.
3. Resolved: leave restored source changes uncommitted for review.

## Extraction implementation (step 4)

```
resolve side -> source/workspace + repo identity -> profiles + selection
  -> read source and workspace (bounded parallel I/O)
  -> plan in memory: paths, replacements, baseline hashes, conflicts
  -> preview + confirmation
  -> lock destination -> recheck snapshots -> stage anonymized files
  -> apply files + authenticated manifest -> record repo link and backup
```

- `push` from a source repo and `pull` from a cloak workspace perform
  extraction. Reverse directions are added in step 5.
- Commit flags select paths changed by those commits, then read their current
  worktree contents. Selection is a sorted union of explicit paths, commits,
  working changes, and additional repo-relative paths. Directory selections
  expand recursively. Paths outside the source repo and submodules are not
  entered; external symlinks are skipped, internal file symlinks materialized.
- Glob/minimatch handle selection, p-limit bounds I/O, and isbinaryfile plus
  fatal UTF-8 decoding identify binary data. Binary bytes remain unchanged
  and the preview names them as warnings. Text decoding preserves the BOM.
- Default exclusions cover metadata, dependencies, generated output, lockfiles,
  and snapshots. A profile's optional `include` globs override ordinary default
  exclusions; optional `exclude` globs add exclusions. Metadata is never included.
  Exclusions do not untrack previously selected files, like Git ignore rules.
- Without selection flags, refresh reuses the original paths in the manifest.
  Profiles are reloaded by saved id/scope and compared by canonical JSON hash.
  Changed profiles are shown and confirmed. Changing the profile set requires
  an unedited workspace; otherwise its old replacement snapshot is still needed.
- Refresh preserves edits when the source is unchanged, updates unchanged
  workspace files when source changes, and rejects edits on both sides.
  Source deletions remove unchanged tracked workspace files. Untracked files
  are never overwritten, including paths that collide by case or Unicode.
- Manifests keep public anonymized paths, hashes, sizes, binary flags and pull
  history. The authenticated blob keeps source paths and Git common directory, branch/commit, profile
  hashes, rules, concrete ledger pairs, original file paths and source hashes.
  An unborn source branch records a null commit.
- `--dry-run` never creates the store, key, destination, locks, Git metadata,
  or files. A new destination must be empty and outside source repositories.
  The default destination is `<workspacesRoot>/<anonymized repo name>-<id>`;
  if that name cannot be anonymized, use `workspace-<id>` rather than leak it.
- More than one workspace without a branch match requires `--to` under
  `--yes`. An explicit path creates a workspace or opens its existing manifest.
- The writer stages anonymized output, rechecks hashes under a lock, and
  restores prior files on an ordinary write error. A process/power failure is
  not a multi-file transaction; the manifest is written last and is backed up
  sealed in the machine store. No original plaintext is staged in a workspace.
  The lock remains held through the record/backup update. If that private-store
  update fails after a successful workspace commit, the valid workspace stays
  in place and the error explains that a retry repairs its record.
- With `initGit` enabled (default), the workspace gets its own Git repository
  and commits only the pull's changed paths and manifest. Existing staged
  changes on those paths are rejected before writing; unrelated edits remain
  untouched. Hooks and signing are disabled for the tool's local commits.

## Restore implementation (step 5)

```
resolve workspace + target worktree -> read authenticated saved rules and ledger
  -> compare workspace hashes -> restore changed contents and new paths
  -> preflight source hashes and portable path collisions -> preview
  -> lock workspace and source common directory -> recheck both snapshots
  -> write source files -> update encrypted manifest baseline -> save private record
```

Restore uses the rules saved at extraction time, rather than edited profiles.
Unchanged workspace files are skipped. Source changes conflict only on paths
being restored; `--force` accepts them and `--skip-conflicts` leaves their old
baselines intact. New files never silently overwrite existing source files.
Deletion appears in the confirmation; `--yes` explicitly accepts it. Source
files remain uncommitted. Successful paths get new workspace and source hashes,
so repeating a restore skips them. Binary contents are copied unchanged.

Before writing, all paths and contents are restored and checked for residue.
Source symlinks and nested repositories are refused. Ordinary write failures
roll back source bytes, modes and the workspace manifest. A process or power
failure is not a multi-file transaction. Rollback failures preserve recovery
copies in a private temporary directory outside the workspace. A private-store
failure after saving is reported without undoing the successfully restored files.

## Creating a restore target

```
--new-worktree branch [--base ref] [--path directory]
  -> validate new branch and separate, nonexistent destination
  -> resolve base to a commit (default: origin.commit)
  -> read selected blobs and path inventory directly from that commit
  -> restore every tracked workspace file, including unchanged files
  -> dry-run: return plan without creating directories, refs or worktrees
  -> confirm -> lock workspace + common Git directory -> recheck
  -> create branch ref atomically -> git worktree add
  -> write restored files + manifest -> remember target
```

`--new-worktree` is workspace-only and cannot combine with `--worktree`.
`--base` and `--path` require it. The default directory is a sibling named
`<source-repo>-<branch-with-slashes-replaced-by-hyphens>`. `worktreePath`, when
set in the machine config, is the parent directory for these default folders.
Names must be portable to all supported operating systems; pass `--path` if
a branch name cannot form a portable default. A destination must not exist or
sit inside any Git repository or cloak workspace. Branches must be new.

The base is resolved once to an immutable commit. Tracked files are copied in
full because captured working changes may not exist in that commit. Files
newly added by the agent still conflict if they would overwrite an unrelated
base file, unless `--force` was explicitly given. Source worktrees are not
modified. Worktree creation disables checkout hooks. Successful changes stay
uncommitted. Subsequent restore and refresh operations find the remembered
branch through Git's worktree registry.

Ordinary failures roll files and the manifest back, then remove the newly
created worktree and its still-unmodified branch. Cleanup never force-removes
an edited worktree or deletes a branch whose commit moved. If saving the private
record fails after the restore succeeded, the new target remains in place.
