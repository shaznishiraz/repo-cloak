---
type: quickstart
title: Quickstart
description: Orientation for repo-cloak v2 - a TypeScript CLI that copies selected files from a private Git repository into an anonymized workspace and restores changes with the original names; the cloak/restore model, repository map, everyday commands, and which wiki page to read for each task.
tags: [overview, quickstart, routing]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-cd1c967ebdc10e2badb82347
    resource: repo://src/commands/sync.ts
  - id: openwiki-source-a93be9f59f4034d9001d88eb
    resource: repo://src/program.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Quickstart

**repo-cloak** copies selected files out of a private Git repository into a
separate **cloak workspace**, replaces proprietary names, paths and secrets
there, and later writes the workspace's changes back with the original names
restored. It is published to npm as `repo-cloak-cli` and installed as the
`repo-cloak` and `cloak` commands. This is **v2**, a ground-up rewrite;
`archive/` holds v1 for reference only.

## The model

```
source worktree  ──── cloak (anonymize, copy) ────>  cloak workspace  <── AI agent
 (Acme...)       <─── restore (conflict-checked) ───  (Northwind...)
                                      ~/.repo-cloak: key, sealed profiles, repo records
```

`pull` always means "into here" and `push` "to the other side":

| Run from          | `push`                       | `pull`                         |
| ----------------- | ---------------------------- | ------------------------------ |
| Source worktree   | cloak files into a workspace | restore a workspace's changes  |
| Cloak workspace   | restore changes to the source| refresh files from the source  |

## Everyday commands

```bash
repo-cloak                                   # guided mode
repo-cloak profile create acme               # rules + file patterns in a validated editor
repo-cloak push --profile repo:acme --commit <sha> --to ../work --dry-run
repo-cloak status                            # in a workspace: what changed
repo-cloak push                              # in a workspace: restore
repo-cloak ui                                # local dashboard
repo-cloak schema profile                    # JSON Schema
```

Development: `npm run build`, `npm test`, `npm run test:coverage`,
`npm run lint`, `npm run typecheck`; `./scripts/install-local.sh` links the
checkout as the global command.

## Repository map

```
src/
  cli.ts, program.ts, *-program.ts   command parsing and output
  commands/                          orchestration (sync, pull setup, push, interactive, dashboard)
  core/                              pure logic: anonymizer, planners, schemas, patterns
  adapters/                          files, git, worktrees, crypto, store, prompts, HTTP server
  ui/                                dashboard HTML/CSS/JS (no framework)
tests/        Vitest, mirroring src/       e2e/      dashboard browser tests
docs/         requirements, design, plan   site/     project website
openwiki/     this generated wiki           archive/  v1, reference only
```

## Where to go

| Task                                                          | Read                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Add or change a command, flag or exit code                    | [CLI entrypoint and command routing](architecture/cli-program.md)    |
| Understand extraction: selection, destination, manifest       | [Cloak: extracting into a workspace](workflows/cloak-extraction.md)  |
| Understand restore, conflicts or `--new-worktree`             | [Restore and Git worktrees](workflows/restore-and-worktrees.md)      |
| Change how names, regexes or secrets are replaced or restored | [Anonymizer engine](concepts/anonymizer-engine.md)                   |
| Work on profiles, rule validation or exclude/include patterns | [Profiles, rules and file patterns](concepts/profiles-and-file-patterns.md) |
| Touch encryption, the store, schemas or repo identity         | [Machine store, encryption and repository identity](architecture/store-and-encryption.md) |
| Change the guided prompts                                     | [Interactive mode](workflows/interactive-mode.md)                    |
| Work on `repo-cloak ui`                                       | [Local web dashboard](integrations/dashboard.md)                     |
| Build, package, publish or deploy the site                    | [Build and npm publishing](operations/build-and-publish.md)          |
| Run checks, write tests, follow the workflow                  | [Development workflow and quality gates](workflows/development-workflow.md) |

## Key rules

- Design first: `docs/design/` and `docs/plan.md` before code.
- `core/` stays free of I/O.
- Never import from or edit `archive/`; never hand-edit `openwiki/`.
- Never publish or push tags unless asked.
