---
type: concept
title: Profiles, rules and file patterns
description: What a repo-cloak profile contains, how literal, regex and secret rules are validated, how several global and repo profiles are combined without conflicts, the profile subcommands, and how gitignore-style exclude/include patterns decide which files can ever be copied.
tags: [profiles, rules, validation, merge, patterns, glob, exclude]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-79e86677f73a140d062ede12
    resource: repo://src/adapters/files.ts
  - id: openwiki-source-e8fa921a0fdc1ca2c286897d
    resource: repo://src/adapters/input.ts
  - id: openwiki-source-98a7bb54985da5582f9c6d4a
    resource: repo://src/adapters/profiles.ts
  - id: openwiki-source-a4677c6244efe27ac190104d
    resource: repo://src/commands/profile.ts
  - id: openwiki-source-4d7ada7763ec6750db8d31be
    resource: repo://src/commands/pull-profiles.ts
  - id: openwiki-source-d290f0db8614fd2e6dcbe9a8
    resource: repo://src/core/merge.ts
  - id: openwiki-source-a6589f8d01ee5ef79aa1345c
    resource: repo://src/core/patterns.ts
  - id: openwiki-source-0d0e7940d0b2da02b86d15e8
    resource: repo://src/core/rules.ts
  - id: openwiki-source-4b50f66f10d646fdd2890c0a
    resource: repo://src/core/schemas.ts
  - id: openwiki-source-4987c02cef8e7eece39c3195
    resource: repo://src/profile-program.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Profiles, rules and file patterns

## Profile document

```json
{
  "kind": "profile",
  "schemaVersion": 1,
  "name": "acme",
  "description": "Client names",
  "rules": [
    { "id": "company", "type": "literal", "match": "Acme Corp", "replace": "Northwind Traders" },
    { "id": "services", "type": "regex", "match": "acme-(\\w+)-svc", "flags": "i", "replace": "northwind-$1-svc" },
    { "id": "keys", "type": "secret", "detector": "aws-access-key" }
  ],
  "exclude": ["*.schema.json", "generated/"],
  "include": ["dist/types/"]
}
```

| Rule type | Key fields                                                           |
| --------- | -------------------------------------------------------------------- |
| `literal` | `match`, `replace`, `boundary`, `styles`, `forms`, `except`, `common` |
| `regex`   | `match`, `replace` (`$1`, `$<name>`), `flags` (`i`, `m`, `s`, `u`)    |
| `secret`  | `detector` (one of the built-in detector ids)                         |

Every rule also accepts `enabled` and `scope` (`content`, `paths`, or both).
How these fields drive replacement is described in the
[anonymizer engine](anonymizer-engine.md).

**Scope** is not stored in the file: a profile is global or repo-specific
depending on where it is saved (`profiles/` or `repos/<repoId>/profiles/`), and
it is sealed at rest like every other store document
([store](../architecture/store-and-encryption.md)). Names must be unique per
scope; saving takes a directory lock.

## Validation

`validateProfile` runs whenever a profile is saved, imported, loaded or
merged. It rejects:

- a blank profile name or rule id, and duplicate rule ids;
- invalid regexes or flags (`g` is implied), unknown secret detectors;
- literal rules without letters or digits, or common names without explicit
  styles;
- two identical rules, or two literal rules with different originals and the
  same replacement;
- variant collisions within the profile;
- invalid file patterns (below).

Errors name the source, profile and rule, for example
`profile: acme/company: duplicate rule id`.

## Combining profiles

A run can use several profiles. `mergeProfiles` validates each, skips
disabled rules, and fails on:

- the same profile selected twice;
- the same literal original with different replacements;
- different literal originals with the same replacement (restore could not
  reverse it);
- the same regex and flags with different replacements;
- variant collisions across the combined set.

Identical rules from different profiles are kept once. The error names both
profiles and rules (`global:common/a conflicts with repo:<id>:acme/b: ...`).

On the command line, `--profile` accepts a name or id, optionally prefixed
`global:` or `repo:`. An ambiguous name fails under `--yes`, and is otherwise
asked interactively. A refresh without `--profile` reuses the profiles
recorded in the workspace manifest.

## Profile commands

```
repo-cloak profile list                 global + this repository's profiles
repo-cloak profile show <name>          decrypted JSON
repo-cloak profile create <name>        opens a validated editor; --global for a global profile
repo-cloak profile edit <name>
repo-cloak profile delete <name>
repo-cloak profile export <name>        decrypted JSON, for review or an LLM
repo-cloak profile import <file|->      validate and save (stdin with -)
repo-cloak profile check <names...>     validate profiles together
```

`--global` and `--repo` pick the scope when a name exists in both.

## File patterns

`exclude` and `include` are `.gitignore`-style patterns relative to the
repository root (`core/patterns.ts`):

| Pattern            | Matches                                              |
| ------------------ | ---------------------------------------------------- |
| `*.schema.json`    | no `/`: that name in every folder                    |
| `generated/`       | trailing `/`: a folder and everything in it          |
| `/config/local.yml`| leading `/`: only at the repository root             |
| `src/**/*.gen.ts`  | contains `/`: matched from the repository root       |
| `fixtures`         | also covers the contents of a folder with that name  |

Matching ignores case and includes dotfiles. Patterns are compiled once into
matchers. `patternProblem` rejects blank patterns, surrounding spaces, `!`
negation, backslashes, absolute or drive paths, `..`, patterns that name no
file or folder, and invalid globs. Duplicates, and a pattern in both lists,
are also errors.

### How files are filtered

```
candidate path
  metadata (.git, .repo-cloak)?          -> never copied
  matches any profile exclude?           -> skipped (exclude always wins)
  matches a default exclusion?           -> skipped unless a profile include matches
  otherwise                              -> eligible
```

Default exclusions: `node_modules/`, `dist/`, `build/`, `coverage/`,
`vendor/`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock*`
and `*.snap`. `filterPaths` applies to every selection source (picked files,
commits, working changes, typed paths); `expandPaths` uses the same matchers
to skip excluded folders while scanning a directory. Files a workspace
already tracks stay tracked when patterns change.

## Related pages

- [Anonymizer engine](anonymizer-engine.md)
- [Machine store, encryption and repository identity](../architecture/store-and-encryption.md)
- [Cloak: extracting into a workspace](../workflows/cloak-extraction.md)
