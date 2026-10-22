---
type: architecture
title: Machine store, encryption and repository identity
description: Where repo-cloak keeps its machine-local data, how profiles, repo records and workspace manifests are sealed with AES-256-GCM, how document versions are checked and migrated, how writes stay atomic, and how a repository is identified across worktrees.
tags: [store, encryption, aes-gcm, schemas, identity, security]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-2d080df9d2143f50c89edc07
    resource: repo://src/adapters/atomic.ts
  - id: openwiki-source-cb18ab697ec0652692572d05
    resource: repo://src/adapters/crypto.ts
  - id: openwiki-source-8ceff43a85f185d7d17dedb7
    resource: repo://src/adapters/git.ts
  - id: openwiki-source-5d7b519843831622d3be6690
    resource: repo://src/adapters/store.ts
  - id: openwiki-source-6c54eae54af6ba31298b3e0a
    resource: repo://src/adapters/sync-store.ts
  - id: openwiki-source-f0d127584c822fb2710632f3
    resource: repo://src/core/identity.ts
  - id: openwiki-source-6b07dbe542a43b1cfcd99637
    resource: repo://src/core/manifest.ts
  - id: openwiki-source-4b50f66f10d646fdd2890c0a
    resource: repo://src/core/schemas.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Machine store, encryption and repository identity

## Layout

```
~/.repo-cloak/                      createStore(); every path segment must be a portable name
  key                               32 random bytes, mode 0600 (created on first seal)
  config.json                       kind: config   (plain: workspacesRoot, worktreePath, initGit, concurrency)
  profiles/pf_<uuid>.json           kind: profile  (sealed) global profiles
  repos/<repoId>/
    repo.json                       kind: repo     (sealed) source path, commonDir, linked workspaces
    profiles/pf_<uuid>.json         kind: profile  (sealed) repo-specific profiles
    manifests/<hash>.json           copy of each workspace's last manifest
  ui.lock / ui.guard                dashboard session (see dashboard page)

<cloak workspace>/.repo-cloak/manifest.json   kind: manifest  plain part + one sealed blob
```

Only `config` may be written in plain text; `writePlain` refuses every other
kind. Profile files are named by random ids, so file names reveal nothing.

## Sealing

```
seal(value, key, plain)
  nonce  = 12 random bytes
  AAD    = canonical JSON of the plain metadata (sorted keys)
  data   = AES-256-GCM(JSON(value)) || 16-byte auth tag
  -> { alg: "A256GCM", keyId: "k_<sha256(key)[0..12]>", nonce, data }
```

- The plain metadata stored next to a blob (for example `kind`,
  `schemaVersion` and `id` of a profile envelope, or the whole public part of
  a manifest) is authenticated as additional data. Editing either the blob or
  the plain part makes `open` fail with "data or plain metadata was altered".
- `keyId` lets `open` say exactly which key a blob needs.
- The key is created once with an exclusive temp file plus a hard link, so two
  processes racing to create it end up sharing one complete key.

The key lives next to the data it protects. Sealing protects the store from
backups, sync tools and accidental sharing; it does not protect against
someone with full access to the user account. Losing the key makes every
workspace impossible to restore.

## Documents and versions

Every document declares `kind` and `schemaVersion`, validated with zod
(`core/schemas.ts`):

| Kind     | Version | Stored as        |
| -------- | ------- | ---------------- |
| profile  | 1       | sealed envelope  |
| repo     | 1       | sealed envelope  |
| config   | 1       | plain JSON       |
| manifest | 2       | plain + sealed   |

`checkVersion` runs before decryption and refuses a newer `schemaVersion`
("upgrade repo-cloak"). `parseDocument` applies registered migrations one
version at a time and requires each to advance the version. Objects are
`looseObject`s, so unknown fields survive a load-and-save. `jsonSchema(kind)`
turns the same zod definitions into the published JSON Schemas.

## Repository identity

A source repository is identified by `repoId = sha256(realpath(git common
dir))[0..16]`. Every worktree of a repository shares one common directory, so
all of them share profiles, workspace links and suggestions.
`resolveRepo` asks Git for absolute `--show-toplevel` and `--git-common-dir`
paths and canonicalizes both; `repoState` adds the current branch (or `null`
when detached) and HEAD commit.

## Repo record and workspace links

`registerRepo` creates `repos/<repoId>/repo.json` the first time a repository
is used. After every successful extraction or restore, `record` updates it
under a directory lock:

- the workspace entry (`path`, `createdAt`, `lastUsedAt`, `useCount`,
  `lastProfiles`, `origin`, `target` branch), which drives suggestions and
  choosing a workspace by branch;
- a copy of the sealed workspace manifest under `manifests/`.

`findWorkspace` walks up from a directory to the nearest
`.repo-cloak/manifest.json`; `readSnapshot` refuses a manifest reached through
a symlink, opens the sealed part with the manifest's plain part as AAD, and
cross-checks both file maps.

## Atomic writes and locks

`writeAtomic` writes a flushed temp file with mode 0600 and renames it over
the target, retrying briefly on Windows where indexers hold files. Profile
directories, repo records, workspaces and source repositories are guarded
with `proper-lockfile` locks so concurrent runs fail or wait instead of
interleaving.

## Related pages

- [Profiles, rules and file patterns](../concepts/profiles-and-file-patterns.md)
- [Cloak: extracting into a workspace](../workflows/cloak-extraction.md)
- [Restore and Git worktrees](../workflows/restore-and-worktrees.md)
