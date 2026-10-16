# CLI commands

Status: **agreed**. The command surface for v2. Behavior details live in
[overview.md](overview.md) and [data-model.md](data-model.md).

## Invocation

`repo-cloak` is the main command; `cloak` is an alias and behaves the same
everywhere. Docs, help, and error messages always say `repo-cloak`.

## Commands

```
repo-cloak                       interactive mode (detects where it is run)
repo-cloak pull                  source repo -> cloak workspace
repo-cloak push                  cloak workspace -> source repo (run from either side)
repo-cloak status                what changed in this workspace since the last pull
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

## `pull`

```
repo-cloak pull
  --profile <name>        repeatable; profiles to use (global or repo-specific)
  --to <dir>              destination cloak workspace
  --files <paths...>      files picked explicitly
  --commit <sha>          repeatable; files changed in these commits
  --working               current working changes (staged, unstaged, untracked)
  --dry-run               show what would be pulled and replaced, write nothing
  -y, --yes               skip confirmations (for scripts and agents)
```

Selection flags combine: `--commit a1b2 --working --files README.md` pulls the
union, deduplicated. Running `pull` inside an existing workspace re-pulls it
using the profiles and source recorded in its manifest.

## `push`

```
repo-cloak push
  --from <workspace>      when run in a source repo: which workspace to bring in
  --skip-conflicts        push everything except files changed in the source
  --force                 overwrite source files changed since the pull
  --dry-run               show what would be written, write nothing
  -y, --yes               skip confirmations
```

Without `--skip-conflicts` or `--force`, any conflict stops the push and
nothing is written.

## `status`

```
repo-cloak status         modified / added / deleted files in this workspace
```

Uses the plain part of the manifest (hashes), so it works without decrypting.

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
