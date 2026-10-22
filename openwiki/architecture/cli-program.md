---
type: architecture
title: CLI entrypoint and command routing
description: How the repo-cloak CLI starts, which commands it registers, how push and pull route to extraction or restore depending on where they run, the global --json/--yes flags, exit codes, and the loader seams tests replace.
tags: [cli, architecture, commander, entrypoint, routing]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-d2f650c01f560a60ae9115b9
    resource: repo://src/cli.ts
  - id: openwiki-source-cd1c967ebdc10e2badb82347
    resource: repo://src/commands/sync.ts
  - id: openwiki-source-514e02a2af9b0f6a423be641
    resource: repo://src/core/errors.ts
  - id: openwiki-source-a93be9f59f4034d9001d88eb
    resource: repo://src/program.ts
  - id: openwiki-source-ef8ff361319680347ff5278d
    resource: repo://src/sync-program.ts
  - id: openwiki-source-bb917cfc421aafb728da5768
    resource: repo://tests/program.test.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# CLI entrypoint and command routing

## Startup

```
dist/cli.js  (bins: repo-cloak, cloak)
   |
   v
src/cli.ts ── createProgram().parseAsync(argv)
   |              |
   |              +── schema <kind>          src/program.ts
   |              +── profile <sub>          src/profile-program.ts
   |              +── push | pull            src/sync-program.ts  -> commands/sync.ts
   |              +── workspaces             src/sync-program.ts
   |              +── status                 src/status-program.ts
   |              +── ui                     src/ui-program.ts
   |              +── (no command)           interactive mode
   |
   +── catch: prompt cancelled -> exit 130
              ConflictError     -> exit 2
              other errors      -> "error: <message>", exit 1
```

`src/cli.ts` is the only module that sets the process exit code. Errors are
printed as one `error: ...` line rather than a stack trace.

| Exit code | When                                                        |
| --------- | ----------------------------------------------------------- |
| 0         | Success                                                     |
| 1         | Any ordinary error                                          |
| 2         | Restore stopped because source files changed (`ConflictError`) |
| 130       | The user cancelled an interactive prompt (Ctrl+C)           |

## The program object

`createProgram()` builds a commander `Command` named `repo-cloak`. Its version
and description are read from `package.json` at runtime, so the published CLI
always reports the version it was published with. Two global options apply to
every command:

- `--json`: machine-readable output for scripts and agents.
- `-y, --yes`: skip confirmations.

Running `repo-cloak` with no command starts [interactive mode](../workflows/interactive-mode.md).
It refuses `--json` and `--yes` (they imply no prompts), and when stdin or
stdout is not a terminal it prints help instead of prompting.

## Direction-based routing for push and pull

`push` and `pull` share one option set, but their meaning depends on where
they run (`commands/sync.ts`):

```
                      in a source worktree        in a cloak workspace
repo-cloak push   ->  extract (cloak)             restore
repo-cloak pull   ->  restore                     extract (refresh)
```

`createSyncCommand` looks for a `.repo-cloak/manifest.json` above the current
directory. `push` inside a workspace and `pull` outside one go to `runPush`
([restore](../workflows/restore-and-worktrees.md)); the other two go to
`preparePull` + `runPull` ([extraction](../workflows/cloak-extraction.md)).
Restore-only flags (`--from`, `--force`, `--skip-conflicts`, `--new-worktree`,
`--base`, `--path`) are rejected on the extraction path.

Without `--yes` or `--dry-run`, both directions refuse to write when there is
no interactive terminal, so a script never blocks on a hidden prompt.

The command prints `<status>: N files to write, M to remove`, the workspace
path, and any warnings; `--json` prints the full result object instead.

## Loader seams

`createProgram(loadProfiles, loadSync, loadStatus, loadInteractive)` accepts
optional factories. Production code omits them and builds real adapters;
tests pass fakes so commands can be exercised without a machine store, a
terminal, or Git side effects.

## Layering

Code follows the direction set in `AGENTS.md`:

```
cli.ts / *-program.ts  -->  commands/  -->  core/  <--  adapters/
(parse flags, print)       (orchestrate)   (pure logic) (fs, git, crypto, prompts, http)
```

`core/` holds the anonymizer, planners and schemas; `adapters/` performs file,
Git, encryption, prompt and HTTP I/O; `commands/` wires them together.

## Related pages

- [Cloak: extracting into a workspace](../workflows/cloak-extraction.md)
- [Restore and Git worktrees](../workflows/restore-and-worktrees.md)
- [Interactive mode](../workflows/interactive-mode.md)
- [Local web dashboard](../integrations/dashboard.md)
