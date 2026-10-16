# AGENTS.md

Instructions for AI agents working in this repo. Keep it short; put knowledge about
how the code works in the wiki, not here.

## Project

`repo-cloak` is a CLI that pulls selected files out of a repository, anonymizes
proprietary names and secrets, and pushes changes back with the original names
restored. It is published to npm as **`repo-cloak-cli`**.

This is **v2, a ground-up rewrite**. `archive/` holds v1 for reference only:
read it for ideas, never import from it, never edit it.

## Commands

```bash
npm run build        # tsup -> dist/
npm test             # vitest
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier
```

Before calling work done: `npm run typecheck && npm run lint && npm test`.

## Code style

- TypeScript strict, ESM, Node >= 22. Use `.js` extensions in relative imports.
- Prefer the simplest abstraction that works. No interfaces with one
  implementation unless they mark an I/O boundary that tests need to fake.
- Small modules, one responsibility each. Named exports, no default exports.
- Dependencies point inward:

  ```
  cli.ts  -->  commands/  -->  core/  <--  adapters/
  (args)      (orchestrate)   (pure logic) (fs, git, prompts)
  ```

  `core/` does no I/O and imports nothing from `commands/` or `adapters/`.

- Tests live in `tests/`, mirroring `src/`. Test `core/` directly; test commands
  with fake adapters.
- Add a runtime dependency only when it clearly earns its place.

## Workflow: design in ASCII first

Docs are the plan; start at [`docs/README.md`](docs/README.md).

1. **Pick.** Take the next unticked step in `docs/plan.md`.
2. **Design.** If the step needs design the docs don't cover yet, add it to
   the relevant `docs/design/*.md` first (ASCII diagram, key types) and get it
   agreed. Don't repeat what a design doc already says; link to it.
3. **Build.** Write a test for each acceptance scenario in the step, then the
   code.
4. **Close.** Tick the step's boxes in `docs/plan.md`. If the code ended up
   different from the design, update the design doc in the same change.
5. **Wiki.** Update the OpenWiki at milestones (marked in `docs/plan.md`), not
   after every step.

Small fixes and refactors skip steps 1-2.

Where things live:

| What                                       | Where                  |
| ------------------------------------------ | ---------------------- |
| Product requirements: what and why         | `docs/requirements.md` |
| Designs: how                               | `docs/design/`         |
| Build steps, tasks, acceptance scenarios   | `docs/plan.md`         |
| How the code works (generated, never edit) | `openwiki/`            |

## Publishing

- Package name stays `repo-cloak-cli`; bins stay `repo-cloak` and `cloak`.
- Version must be higher than what is on npm (`npm view repo-cloak-cli version`).
- Never run `npm publish` or push tags without the user asking.

## Git

- Commit only when asked. Never force-push without asking.
- Imperative, concise commit subjects.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
