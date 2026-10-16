# CLI commands

Status: **agreed**. The command surface for v2. Behavior details live in
[overview.md](overview.md) and [data-model.md](data-model.md).

## Invocation

`repo-cloak` is the main command; `cloak` is an alias and behaves the same
everywhere. Docs, help, and error messages always say `repo-cloak`.

## Commands

```
repo-cloak                       interactive mode (detects where it is run)
repo-cloak pull                  bring changes HERE from the other side
repo-cloak push                  send changes from here to the OTHER side
repo-cloak status                what changed in this workspace since the last sync
repo-cloak profile <sub>         manage profiles
repo-cloak workspaces            list cloak workspaces linked to this source repo
repo-cloak ui                    start the local web UI
repo-cloak schema <kind>         print a JSON Schema (profile, repo, manifest, config)
```

## Flags on every command

```
-h, --help
-v, --version
--json            output as JSON, for scripts and LLM agents
```

## Direction

`pull` and `push` mean the same thing on both sides: **pull = into here,
push = to the other side**. Underneath there are two operations
(see [sync.md](sync.md)):

```
                     in a source worktree          in a cloak workspace
                     --------------------          --------------------
repo-cloak push      CLOAK    source -> workspace   RESTORE  workspace -> source
repo-cloak pull      RESTORE  workspace -> source   CLOAK    source -> workspace

CLOAK   = select files, anonymize, copy, update manifest
RESTORE = restore names, write back, all or nothing
```

The **first** `repo-cloak push` (or `repo-cloak`) in a source worktree with no
linked workspace creates one, in `workspacesRoot` unless `--to` says
otherwise. There is no `init` command.

Running without a command opens the guided menu in a terminal. Source repos
can create or refresh workspaces, restore changes, or view status; workspaces
can refresh, restore, or view status. Profile selection allows creating a new
profile in the JSON editor and validates combined rules before continuing.
Selection combines files, recent commits, working changes, extra paths, and
previously tracked files. Saved profiles and workspaces are suggested first.
Without a terminal, bare invocation prints help. Use explicit commands with
`--yes` or `--json`. The dashboard entry opens the same UI as `repo-cloak ui`.

## CLOAK flags (`push` in a source worktree, `pull` in a workspace)

```
  --profile <name>        repeatable; also accepts global:<name> or repo:<name>
  --files <paths...>      files picked explicitly
  --commit <sha>          repeatable; files changed in these commits
  --working               current working changes (staged, unstaged, untracked)

  in a source worktree:
  --to <workspace|dir>    existing workspace (name, id, or path), or a folder for a new one
                          default: the workspace linked to this branch, else a new
                          folder in workspacesRoot

  in a cloak workspace:
  --worktree <path>       read from this worktree instead of the target branch's

  --dry-run               show what would be copied and replaced, write nothing
  -y, --yes               skip confirmations (for scripts and agents)
```

Selection flags combine: `--commit a1b2 --working --files README.md` copies the
union, deduplicated. With no selection flags, an existing workspace refreshes
the files it already has, using the profiles recorded in its manifest.

Extraction runs with `push` in a source repo and `pull` in a workspace.
Restore runs in the opposite directions. Commit selection reads
the selected paths' current worktree contents. Refresh without selection flags
reuses the tracked paths and saved profile ids. Changed profile rules are
shown before confirmation; `--yes` accepts them, while an edited workspace
must first be restored or cleaned before its profile snapshot can change.

Examples:

```bash
repo-cloak push --profile global:acme --files src README.md --to ../cloak-work --yes
repo-cloak push --profile acme --commit HEAD --working --dry-run
# From the resulting workspace:
repo-cloak pull --yes
```

## RESTORE flags (`pull` in a source worktree, `push` in a workspace)

```
  in a source worktree:
  --from <workspace>      which workspace (default: the one linked to this branch)

  in a cloak workspace:
  --worktree <path>       write into this existing worktree
  --new-worktree <branch> create a worktree on a new branch, then write into it
    --base <ref>          base commit (default: the commit last cloaked from)
    --path <dir>          folder (default: worktreePath in config.json)

  --skip-conflicts        write everything except files changed in the source
  --force                 overwrite source files changed since the last cloak
  --dry-run               show what would be written, write nothing
  -y, --yes               skip confirmations
```

Without `--skip-conflicts` or `--force`, any conflict stops the restore and
nothing is written.

Restoring into existing worktrees is implemented. The draft `--new-worktree`,
`--base` and `--path` options are not implemented yet; create the worktree with
Git first and pass `--worktree`. Restore uses the rules saved in the manifest,
leaves source changes uncommitted, and updates successful files' baselines.
Skipped conflicts retain their old baselines. Deletions appear in the
confirmation; `--yes` accepts them. `--force` and `--skip-conflicts` are mutually
exclusive. Dry runs do not modify source files, the workspace, or the store.

## `status`

```
repo-cloak status         modified / added / deleted files in this workspace
```

Uses the plain part of the manifest (hashes), so it works without decrypting.
Works from any directory inside the workspace. Reports added, modified and
deleted paths in sorted order; unchanged files and Git/tool metadata are omitted.
`--json` returns the workspace id and the three path lists. The command only
reads files and does not create a store or require the machine key.

## `profile`

```
repo-cloak profile list               global + this repo's profiles
repo-cloak profile show <name>        rules in a profile (decrypted, for review)
repo-cloak profile create <name>      interactive; --global for a global profile
repo-cloak profile edit <name>        open the decrypted profile in $EDITOR, validated on save
repo-cloak profile delete <name>
repo-cloak profile export <name>      print the profile as JSON (e.g. to hand to an LLM)
repo-cloak profile import <file|->    validate and save JSON (e.g. LLM output via stdin)
repo-cloak profile check <name...>    validate profiles together; report conflicts
```

When a repo-specific and a global profile share a name, `--global` or
`--repo` picks one; without it the command asks (or fails under `--yes`).

Profile options: `--global` and `--repo` are mutually exclusive and can be
placed before or after the profile subcommand. Create/import default to the
current repo; outside Git, pass `--global`. Import rejects duplicate names
within a scope. Create/edit use the editor and need a terminal; delete needs
confirmation or `--yes`.

```
repo-cloak profile import rules.json --global
repo-cloak profile import - --repo       # pipe JSON on stdin
repo-cloak profile list --json
repo-cloak profile export acme --global
repo-cloak profile delete acme --repo --yes
```

Show/export always print the full decrypted JSON. `list --json` prints only
ids, names, scopes, and rule counts; `check --json` prints the number of
profiles and active deduplicated rules.

## `workspaces`

```
repo-cloak workspaces     linked workspaces for this source repo, most recent first
```

## `ui`

```
repo-cloak ui
  --port <n>              default: a random free port
  --no-open               don't open the browser
```

## `schema`

```
repo-cloak schema <kind>  kind: profile | repo | manifest | config
```

## Not included

- `merge`: deferred (see push in [overview.md](overview.md)).
- `init`, `config`: the store is created on first use; settings are edited in
  the UI.
- Separate secret-scanning commands: secrets are handled by `secret` rules.

## Exit codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Success                                         |
| 1    | Error (invalid input, I/O failure, bad profile) |
| 2    | Stopped on conflicts (push)                     |
| 130  | Cancelled by the user (Ctrl+C)                  |
