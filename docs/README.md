# repo-cloak docs

Everything needed to understand and build repo-cloak v2, in reading order.

```
requirements.md  -->  design/  -->  plan.md  -->  code  -->  openwiki/
  what & why          how           steps &        src/      how it works
                                    checklists     tests/    (generated)
```

## Start here

| Doc                                                            | Read it to                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| [requirements.md](requirements.md)                             | Know what repo-cloak must do and why                                 |
| [design/overview.md](design/overview.md)                       | See the big picture, flows, and module layout                        |
| [design/cli.md](design/cli.md)                                 | Look up a command, flag, or exit code                                |
| [design/data-model.md](design/data-model.md)                   | Understand a JSON file, encryption, or rule types                    |
| [design/anonymizer.md](design/anonymizer.md)                   | Understand how names are matched, replaced, and restored             |
| [design/sync.md](design/sync.md)                               | Understand pull/push direction, multiple workspaces, worktrees       |
| [design/web-ui.md](design/web-ui.md)                           | Work on the local web UI                                             |
| [design/repository-groups.md](design/repository-groups.md)     | Review the proposed backend/frontend grouping and combined sync      |
| [design/agent-file-requests.md](design/agent-file-requests.md) | Review scoped agent probes, queued requests and human-approved pulls |
| [plan.md](plan.md)                                             | Find the next step to build and how it is accepted                   |

## Launch the dashboard

```bash
repo-cloak                 # open on the current source/worktree/workspace
cloak                      # equivalent alias
repo-cloak --no-open       # print a local session URL
repo-cloak --port 4321     # choose a port
```

All file selection, profile management, workspace creation, Pull/Push, review and
export run in the dashboard. See [dashboard-first](design/dashboard-first.md).
The `ui` alias, help/version and launcher options remain; terminal workflow
subcommands have been removed.

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
