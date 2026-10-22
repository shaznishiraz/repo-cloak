---
type: workflow
title: Development workflow and quality gates
description: How changes are made in repo-cloak - design-first docs and the build plan, TypeScript, ESLint and Prettier settings, Vitest coverage floors, the browser test suite, the CI matrix, shortcut scripts and dekit tasks, and which paths each tool ignores.
tags: [workflow, design, testing, coverage, lint, ci, e2e, conventions]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-f235d856bed1fd44853c5195
    resource: repo://.prettierignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-08bced5a89277a6d0978110b
    resource: repo://dekit.yaml
  - id: openwiki-source-eee5c7be246c24d6cba899ce
    resource: repo://e2e/e2e.config.ts
  - id: openwiki-source-276795f6d5ad19adb078c64e
    resource: repo://eslint.config.js
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-f9fafda300b014057921ac73
    resource: repo://scripts/check.sh
  - id: openwiki-source-98d5ddb014a0fd4d678f6f2a
    resource: repo://tsconfig.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Development workflow and quality gates

## Change lifecycle

From `AGENTS.md`:

```
1 Pick     next unticked step in docs/plan.md
2 Design   add what is missing to docs/design/*.md (ASCII diagram, key types),
           agreed before code; link instead of repeating
3 Build    a test for each acceptance scenario, then the code
4 Close    tick the step; update the design doc if the code differs
5 Wiki     update OpenWiki at milestones only
```

Small fixes and refactors skip steps 1 and 2. Requirements live in
`docs/requirements.md`, designs in `docs/design/`, the step checklist in
`docs/plan.md`, and generated code documentation in `openwiki/`.

Work is done only when `npm run typecheck && npm run lint && npm test` pass.

## TypeScript, lint and format

- `tsconfig.json` is type-check only (`noEmit`; tsup emits) with `NodeNext`
  resolution, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride` and
  `verbatimModuleSyntax`. Relative imports use `.js` extensions.
- ESLint uses `@eslint/js` recommended, `typescript-eslint` **strict** and
  `eslint-config-prettier`.
- Prettier formats everything except generated or vendored paths.

## Tests and coverage

Vitest collects `tests/**/*.test.ts` with at most four workers, since
integration tests spawn real Git processes in temporary repositories. Tests
mirror `src/`; core logic is tested directly and commands through fake
adapters or the loader seams.

`npm run test:coverage` instruments all of `src/**/*.ts` and enforces floors:

| Scope        | Lines | Statements | Branches | Functions |
| ------------ | ----- | ---------- | -------- | --------- |
| all of `src` | 85    | 83         | 75       | 85        |
| `src/core/`  | 95    | 93         | 85       | 98        |

Coverage is part of the publish gate
([build and publishing](../operations/build-and-publish.md)).

## Browser tests

`e2e/` is a separate project for the [dashboard](../integrations/dashboard.md).
`npm run test:browser` builds the CLI, bundles a fixture server that creates
a temporary Git repo, encrypted store and workspace with synthetic names,
then runs `dashboard.e2e.ts` on Chromium with one worker and no retries,
writing list and JUnit reports. It never touches the user's own store.

## CI

The `CI` workflow runs on pushes and pull requests to `main`/`master` and on
manual dispatch, across Ubuntu, macOS and Windows with Node 22 and 24:
install, typecheck, lint, tests (with coverage on Ubuntu + Node 24, uploaded
as an artifact), build, and the package check. Browser tests are not part of
this workflow.

## Shortcuts

| Command                        | Runs                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `./scripts/setup.sh`           | both dependency sets and Chromium (`--with-deps` on Linux/WSL) |
| `./scripts/check.sh`           | typecheck, lint, coverage, build, package check             |
| `./scripts/test-browser.sh`    | browser test types and dashboard browser tests              |
| `./scripts/test-all.sh`        | everything above except setup                               |
| `./scripts/install-local.sh`   | build and link the CLI globally                             |
| `dekit attach` / `dekit start` | tasks from `dekit.yaml` (dev, checks, release, site, wiki); none start automatically |

## Ignore boundaries

| Path                    | ESLint  | Prettier | OpenWiki | npm tarball |
| ----------------------- | ------- | -------- | -------- | ----------- |
| `archive/` (v1)         | ignored | ignored  | ignored  | excluded    |
| `dist/`                 | ignored | ignored  | ignored  | shipped     |
| `node_modules/`         | ignored | ignored  | ignored  | excluded    |
| `openwiki/`             | n/a     | ignored  | output   | excluded    |
| `e2e/.build`, `e2e/.e2e`| ignored | ignored  | read     | excluded    |
| `.claude/`, `.mcp.json` | n/a     | ignored  | read     | excluded    |

`archive/` holds v1 for reference only and must not be imported or edited.

## Related pages

- [Build and npm publishing](../operations/build-and-publish.md)
- [Local web dashboard](../integrations/dashboard.md)
