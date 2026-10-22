---
type: operations
title: Build and npm publishing
description: How repo-cloak is built into dist/ with its dashboard assets and generated JSON Schemas, what the repo-cloak-cli npm package ships and depends on, the checks that gate publishing, how to install a local build, and how the project website is deployed.
tags: [build, npm, publishing, tsup, release, website]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-5f219f204b3e870beec929d9
    resource: repo://.github/workflows/pages.yml
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-63d4fad4703701fc23e12969
    resource: repo://scripts/check-package.mjs
  - id: openwiki-source-c4e56b42032b0fb65061cb2f
    resource: repo://scripts/install-local.sh
  - id: openwiki-source-74c6b0267a12bbfb67847a09
    resource: repo://tsup.config.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Build and npm publishing

repo-cloak v2 is published as a new major version of the **existing** npm
package `repo-cloak-cli`, under the same command names as v1.

## Build

```
npm run build  ->  tsup
  src/cli.ts (+ imports)  ->  dist/cli.js        ESM, node22 target, sourcemap,
                                                  "#!/usr/bin/env node" banner
  onSuccess:
    src/ui/               ->  dist/ui/           dashboard assets, copied as-is
    core/schemas.ts       ->  schemas/*.schema.json   profile, repo, manifest, config
```

`npm run dev` runs the same build in watch mode. `package.json` is read at
runtime, not bundled, so the CLI always reports the published version.

## What the package ships

| Field     | Value                                                            |
| --------- | ---------------------------------------------------------------- |
| `name`    | `repo-cloak-cli`                                                 |
| `bin`     | `repo-cloak` and `cloak`, both `dist/cli.js`                     |
| `files`   | `dist`, `schemas` (npm adds `package.json`, `README.md`, `LICENSE`) |
| `engines` | `node ^22.13.0 \|\| >=23.5.0`                                    |

Runtime dependencies: `@inquirer/prompts` (prompts), `ahocorasick` (matcher),
`commander` (CLI), `glob` and `minimatch` (file selection), `isbinaryfile`,
`lodash-es` (word splitting), `open` (browser), `p-limit` (bounded
concurrency), `proper-lockfile` (locks) and `zod` (schemas).

## Publish gate

`prepublishOnly` runs before every `npm publish`:

```
typecheck -> lint -> test:coverage -> build -> test:package
```

Any failure aborts the publish. `test:package` (`scripts/check-package.mjs`)
runs the built CLI and `npm pack --dry-run` to confirm:

- `--version` matches `package.json`, both bins point at `dist/cli.js`, and
  `schema <kind>` output equals the generated schema files;
- `status --json` works on a public manifest, and a malformed import fails
  with exit code 1 and a single `error:` line, without touching the user's
  machine store;
- the tarball contains the CLI, dashboard assets, schemas, README, LICENSE
  and package.json, keeps dashboard assets under 50 KB, and contains nothing
  from `src/`, `tests/`, `archive/` or `coverage/`.

## Publishing rules

From `AGENTS.md`: keep the package name and both bins, publish a version
higher than the one on npm (`npm view repo-cloak-cli version`), and never
publish or push tags unless the user asks.

## Local install

`./scripts/install-local.sh` installs dependencies when needed, builds,
removes any earlier global install, and runs `npm link`, so `repo-cloak` and
`cloak` run this checkout. Rebuilding (or `npm run dev`) updates the linked
commands; `--uninstall` removes them.

## Project website

`site/` is a static page. The `Deploy site` workflow publishes it to GitHub
Pages when `site/` or the workflow changes on `main`, or on manual dispatch.

## Related pages

- [Development workflow and quality gates](../workflows/development-workflow.md)
- [CLI entrypoint and command routing](../architecture/cli-program.md)
