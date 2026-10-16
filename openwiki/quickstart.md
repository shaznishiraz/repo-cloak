---
type: quickstart
title: Quickstart
description: Orientation for repo-cloak v2, a from-scratch TypeScript rewrite of the repo-cloak-cli npm package; what exists today, where things live, and which wiki page to read for each task.
tags: [overview, quickstart, routing]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-16T13:36:07.841Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-d2f650c01f560a60ae9115b9
    resource: repo://src/cli.ts
  - id: openwiki-source-a93be9f59f4034d9001d88eb
    resource: repo://src/program.ts
generated: { by: "claude-code", at: "2026-10-16T13:36:07.841Z" }
---

# Quickstart

**repo-cloak** is a CLI that pulls selected files out of a repository,
anonymizes proprietary names and secrets, and pushes changes back with the
original names restored. It is published to npm as `repo-cloak-cli` and
installed as the `repo-cloak` and `cloak` commands.

## Current state

This is **v2, a ground-up rewrite** in TypeScript, versioned `2.0.0`. It is at
the scaffold stage: the CLI answers `--help` and `--version` but has no
subcommands yet. The v1 implementation lives in `archive/` for reference only;
it is not built, linted, tested, published, or documented here.

## Repository map

```
repo-cloak/
├── src/
│   ├── cli.ts          entrypoint: build program, parse argv
│   └── program.ts      createProgram(): commander setup
├── tests/              Vitest tests mirroring src/
├── docs/design/        hand-written ASCII designs (written before code)
├── openwiki/           this generated wiki
├── archive/            v1 source, reference only
├── AGENTS.md           rules for agents working in the repo
└── package.json        name, bins, scripts, publish gate
```

## Common commands

```bash
npm install
npm run build        # bundle to dist/cli.js
node dist/cli.js -h  # run the local build
npm test             # Vitest
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## Where to go

| Task                                              | Read                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Understand how the CLI starts or add a subcommand | [CLI entrypoint and program](architecture/cli-program.md)                |
| Change the build, bins, version, or publish       | [Build and npm publishing](operations/build-and-publish.md)              |
| Start a feature, run checks, write tests          | [Development workflow and quality gates](workflows/development-workflow.md) |

## Key rules

- Design first: add `docs/design/<topic>.md` with an ASCII diagram before
  writing code.
- Keep `core/` free of I/O; put fs, git, and prompts behind adapters.
- Never import from or edit `archive/`.
- Do not hand-edit `openwiki/`; regenerate it after code changes.
