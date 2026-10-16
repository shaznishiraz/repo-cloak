---
type: workflow
title: Development workflow and quality gates
description: The design-first ASCII workflow for repo-cloak v2, the TypeScript, ESLint, Prettier and Vitest setup that gates changes, and which paths each tool ignores.
tags: [workflow, design, testing, lint, typescript, conventions]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-16T13:36:07.841Z
sources:
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-f235d856bed1fd44853c5195
    resource: repo://.prettierignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-39983ea45fb70699639f3e56
    resource: repo://docs/design/README.md
  - id: openwiki-source-276795f6d5ad19adb078c64e
    resource: repo://eslint.config.js
  - id: openwiki-source-98d5ddb014a0fd4d678f6f2a
    resource: repo://tsconfig.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "claude-code", at: "2026-10-16T13:36:07.841Z" }
---

# Development workflow and quality gates

## Change lifecycle

Every feature or structural change follows four steps defined in `AGENTS.md`:

```
 1. Design            2. Build              3. Sync               4. Wiki
 docs/design/   --->  src/ + tests/  --->   docs/design/   --->   openwiki/
 <topic>.md           (follow design)       (fix drift)           (regenerate)
 ASCII diagram,
 key types, agreed
```

1. **Design** in `docs/design/<topic>.md`: the problem, an ASCII diagram of the
   flow or modules, and the key types. It is agreed before code is written.
2. **Build** the implementation with tests.
3. **Sync** the design doc in the same change if the code diverged.
4. **Wiki**: regenerate OpenWiki after meaningful code changes.

`docs/design/README.md` holds the template (Problem, Design with ASCII diagram
and key types, Decisions, Open questions). The split of ownership is strict:

| Location       | Content                         | Written by           |
| -------------- | ------------------------------- | -------------------- |
| `docs/design/` | Intended design, before code    | Humans and agents    |
| `openwiki/`    | What the code does, with Claims | OpenWiki run only    |
| `AGENTS.md`    | Rules for working in the repo   | Humans (+ OpenWiki block) |

## Quality gates

Work is considered done only when this passes:

```bash
npm run typecheck && npm run lint && npm test
```

The same three checks, plus a build, run automatically before publish (see
[Build and npm publishing](../operations/build-and-publish.md)).

### TypeScript

`tsconfig.json` is type-check only (`noEmit`; tsup does the emitting) and
covers `src/`, `tests/`, and root `*.config.ts`. Beyond `strict` it enables
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, and `verbatimModuleSyntax`. With `NodeNext` module
resolution, relative imports must use `.js` extensions (for example
`./program.js`).

### ESLint and Prettier

`eslint.config.js` (flat config) combines `@eslint/js` recommended rules,
`typescript-eslint`'s **strict** preset, and `eslint-config-prettier` so
formatting is left to Prettier. Prettier uses single quotes and a 100-column
width.

### Tests

Vitest only collects `tests/**/*.test.ts`. Tests mirror `src/` (today:
`tests/program.test.ts` for `src/program.ts`). The convention is to test
`core/` logic directly and test commands with fake adapters.

## Ignore boundaries

| Path / file   | ESLint | Prettier | OpenWiki | npm tarball |
| ------------- | ------ | -------- | -------- | ----------- |
| `archive/`    | ignored | ignored | ignored | excluded |
| `dist/`       | ignored | ignored | ignored | **shipped** |
| `openwiki/`   | n/a    | ignored  | output   | excluded |
| `.claude/`, `.mcp.json` | n/a | ignored | read | excluded |

`archive/` holds the v1 implementation for reference only. It is excluded from
every tool so v1 code never influences lint results, formatting, or the wiki,
and must not be imported or edited.

## Code conventions

From `AGENTS.md`: strict ESM TypeScript on Node 22+, small single-purpose
modules, named exports only, no single-implementation interfaces unless they
mark an I/O boundary tests must fake, and new runtime dependencies only when
they clearly earn their place. The layering rule is described in
[CLI entrypoint and program](../architecture/cli-program.md#where-new-code-goes).

## Related pages

- [CLI entrypoint and program](../architecture/cli-program.md)
- [Build and npm publishing](../operations/build-and-publish.md)
