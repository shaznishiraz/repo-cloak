---
type: architecture
title: CLI entrypoint and program
description: How the repo-cloak v2 CLI starts, how the commander program is built by createProgram, where its name/version/description come from, and the layering new commands must follow.
tags: [cli, architecture, commander, entrypoint]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-16T13:36:07.841Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-d2f650c01f560a60ae9115b9
    resource: repo://src/cli.ts
  - id: openwiki-source-a93be9f59f4034d9001d88eb
    resource: repo://src/program.ts
  - id: openwiki-source-bb917cfc421aafb728da5768
    resource: repo://tests/program.test.ts
generated: { by: "claude-code", at: "2026-10-16T13:36:07.841Z" }
---

# CLI entrypoint and program

repo-cloak v2 is at the scaffold stage: the CLI parses arguments and answers
`--help` and `--version`, but registers no subcommands yet. This page explains
the two source files that exist and the structure that new commands are expected
to slot into.

## Startup flow

```
node dist/cli.js [args]          (bin: repo-cloak / cloak)
        |
        v
src/cli.ts  --- createProgram() --->  src/program.ts
        |                                  |
        |                                  +-- reads ../package.json
        |                                  |   (version, description)
        |                                  v
        |                             commander Command
        |                               name: repo-cloak
        |                               -v, --version
        v
  parseAsync(process.argv)
```

`src/cli.ts` is the only side-effecting module: it builds the program and calls
`parseAsync(process.argv)` with top-level `await`, so asynchronous command
actions added later are awaited before the process exits.

`src/program.ts` exports `createProgram()`, a factory that returns a fresh
commander `Command` each call. Keeping construction separate from parsing lets
tests build and inspect the program without touching `process.argv`.

## Metadata sourced from package.json

The program does not hard-code its version or description. `program.ts` uses
`createRequire(import.meta.url)` to load `../package.json` at runtime. The same
relative path resolves in both places the module runs:

| Running from        | Module location     | `../package.json` resolves to |
| ------------------- | ------------------- | ----------------------------- |
| tests (Vitest)      | `src/program.ts`    | repository `package.json`     |
| installed / built   | `dist/cli.js`       | package root `package.json`   |

Because `package.json` is always shipped in an npm tarball, the published CLI
reports exactly the version that was published. Bumping the version therefore
only requires editing `package.json`.

The version flag is registered as `-v, --version` (commander's default is
`-V`), and the program name is fixed to `repo-cloak` regardless of which bin
alias (`repo-cloak` or `cloak`) invoked it.

## Where new code goes

`AGENTS.md` defines the intended layering. Only `cli.ts` and `program.ts` exist
today; the other layers are created as features land:

```
cli.ts  -->  commands/  -->  core/  <--  adapters/
(args)      (orchestrate)   (pure logic) (fs, git, prompts)
```

- **commands/** wire a subcommand onto the program and orchestrate work.
- **core/** holds pure logic, does no I/O, and imports nothing from
  `commands/` or `adapters/`.
- **adapters/** wrap file system, git, and prompt I/O behind small interfaces
  so commands can be tested with fakes.

New subcommands are expected to be registered from `createProgram()` so that
the tested factory remains the single description of the CLI surface.

## Tests

`tests/program.test.ts` checks that `createProgram()` reports the version from
`package.json` and is named `repo-cloak`. These guard the two properties npm
users see first: `repo-cloak --version` and the help header.

## Related pages

- [Build and npm publishing](../operations/build-and-publish.md): how
  `src/cli.ts` becomes `dist/cli.js` and the `repo-cloak` / `cloak` bins.
- [Development workflow and quality gates](../workflows/development-workflow.md):
  design-first process, lint, typecheck, and test setup.
