# repo-cloak docs

Everything needed to understand and build repo-cloak v2, in reading order.

```
requirements.md  -->  design/  -->  plan.md  -->  code  -->  openwiki/
  what & why          how           steps &        src/      how it works
                                    checklists     tests/    (generated)
```

## Start here

| Doc                                          | Read it to                                                     |
| -------------------------------------------- | -------------------------------------------------------------- |
| [requirements.md](requirements.md)           | Know what repo-cloak must do and why                           |
| [design/overview.md](design/overview.md)     | See the big picture, flows, and module layout                  |
| [design/cli.md](design/cli.md)               | Look up a command, flag, or exit code                          |
| [design/data-model.md](design/data-model.md) | Understand a JSON file, encryption, or rule types              |
| [design/anonymizer.md](design/anonymizer.md) | Understand how names are matched, replaced, and restored       |
| [design/sync.md](design/sync.md)             | Understand pull/push direction, multiple workspaces, worktrees |
| [design/web-ui.md](design/web-ui.md)         | Work on the local web UI                                       |
| [plan.md](plan.md)                           | Find the next step to build and how it is accepted             |

## The CLI at a glance

```
repo-cloak                       interactive mode (detects where it is run)
repo-cloak pull                  bring changes HERE from the other side
repo-cloak push                  send changes from here to the OTHER side
repo-cloak status                what changed in this workspace since the last pull
repo-cloak profile <sub>         list | show | create | edit | delete | export | import | check
repo-cloak workspaces            list cloak workspaces linked to this source repo
repo-cloak ui                    start the local web UI
repo-cloak schema <kind>         print a JSON Schema (profile, repo, manifest, config)
```

`cloak` is an alias for `repo-cloak`. Flags and details: [design/cli.md](design/cli.md).

## Terms

| Term                | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| **Source repo**     | The proprietary repository files are pulled from and pushed back to.             |
| **Cloak workspace** | The anonymized copy that files are pulled into.                                  |
| **Rule**            | One replacement: literal, regex, or secret detector.                             |
| **Profile**         | A named set of rules, either global or repo-specific.                            |
| **Manifest**        | The JSON in a cloak workspace recording what was pulled; sensitive parts sealed. |
| **Ledger**          | The exact replacements a pull made, used to restore on push.                     |

## Conventions

- Designs are written **before** code, with ASCII diagrams, and updated when the
  code differs. See the workflow in [`../AGENTS.md`](../AGENTS.md).
- `openwiki/` is generated from the code. Never edit it by hand.
