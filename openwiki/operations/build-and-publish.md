---
type: operations
title: Build and npm publishing
description: How repo-cloak v2 source is bundled by tsup into dist/cli.js, which files and bins the repo-cloak-cli npm package ships, and the checks and rules that gate publishing over the existing package.
tags: [build, npm, publishing, tsup, release]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-16T13:36:07.841Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-74c6b0267a12bbfb67847a09
    resource: repo://tsup.config.ts
generated: { by: "claude-code", at: "2026-10-16T13:36:07.841Z" }
---

# Build and npm publishing

repo-cloak v2 is published as a new major version of the **existing** npm package
`repo-cloak-cli`, replacing the v1 implementation under the same name and
command names.

## Build pipeline

```
src/cli.ts (+ imports)
      |
      |  npm run build  ->  tsup
      v
dist/cli.js        ESM, target node22, platform node
dist/cli.js.map    sourcemap
      ^
      +-- banner: "#!/usr/bin/env node"
```

`tsup.config.ts` bundles from the single entry `src/cli.ts` into ESM for
Node 22, cleans `dist/` before each build, emits a sourcemap, and prepends a
`#!/usr/bin/env node` shebang so the output can be executed directly as a bin.
`npm run dev` runs the same build in watch mode.

`package.json` is **not** bundled: the program reads it at runtime (see
[CLI entrypoint and program](../architecture/cli-program.md)), which works
because npm always includes `package.json` in the tarball.

## What the package ships

| Field        | Value                                  | Effect                                              |
| ------------ | -------------------------------------- | --------------------------------------------------- |
| `name`       | `repo-cloak-cli`                       | Same package as v1, so `npm i -g` upgrades in place |
| `bin`        | `repo-cloak`, `cloak` -> `dist/cli.js` | Both v1 command names keep working                  |
| `files`      | `["dist"]`                             | Only build output is published                      |
| `type`       | `module`                               | ESM package                                         |
| `engines`    | `node >= 22`                           | Requires a current Node LTS                         |
| dependencies | `commander` only                       | Minimal runtime footprint                           |

The `files` whitelist keeps `src/`, `tests/`, `docs/`, `openwiki/`, and the
v1 `archive/` out of the published tarball; npm adds `package.json`,
`README.md`, and `LICENSE` automatically.

## Publish gate

`prepublishOnly` runs before every `npm publish`:

```
npm run typecheck  ->  npm run lint  ->  npm test  ->  npm run build
```

Any failing step aborts the publish, and the final build guarantees `dist/`
matches the current source.

## Publishing rules

From `AGENTS.md`:

- Keep the package name `repo-cloak-cli` and bins `repo-cloak` / `cloak`.
- The version must be higher than the latest on npm; check with
  `npm view repo-cloak-cli version`. v2 starts at `2.0.0`, a new major,
  so users on a `^1.x` range are not moved onto the rewrite automatically.
- Agents never run `npm publish` or push tags unless the user asks.

## Related pages

- [CLI entrypoint and program](../architecture/cli-program.md)
- [Development workflow and quality gates](../workflows/development-workflow.md)
