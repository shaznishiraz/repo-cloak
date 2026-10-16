# Data model and JSON schemas

Status: **draft, not agreed**. Covers every JSON file repo-cloak reads or
writes: profiles, the store, and the workspace manifest.

## Problem

v1 had one JSON file, `.repo-cloak-map.json`. It worked, but it is hard to
extend and has real gaps:

| v1 issue                                                                               | Consequence                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `version: "1.1.0"` string, no `$schema`, no `kind`                                     | No way to validate, migrate, or tell file types apart    |
| Each value encrypted separately, key derived with `scrypt` per value from a fixed salt | Slow on many files; ciphertext lengths leak name lengths |
| No content hashes                                                                      | Push cannot tell what changed or detect conflicts        |
| Literal replacements only, no rule ids or profiles                                     | No regex, no reuse, no way to trace a rule's origin      |
| `files` is an array                                                                    | O(n) lookups, noisy diffs                                |
| Shallow-merge updates, no pull history                                                 | Re-pulls overwrite context                               |
| No key id                                                                              | Key rotation impossible                                  |

v2 goals: **validated, versioned, extendable, fast, and safe to share.**

## Principles

1. **Every file declares itself**: `$schema`, `kind`, `schemaVersion`.
2. **One schema source of truth**: schemas are written once in TypeScript
   (zod), which gives types, runtime validation, and generated JSON Schema
   files shipped in the package (`schemas/*.schema.json`). Editors and LLMs
   get autocomplete and a contract to write against.
3. **Forward compatible**: readers keep unknown fields, accept older
   `schemaVersion`s through migrations, and refuse newer ones with a clear
   message. Anything experimental goes under `extensions`.
4. **Maps, not arrays**, where items have a natural key (files by path).
5. **Seal, don't sprinkle**: sensitive data is encrypted as **one** blob per
   file instead of field by field. This applies to the workspace manifest and
   to every file in the store.

## Files at a glance

```
~/.repo-cloak/                         machine-local store (never shared)
  key                                  32 random bytes, mode 0600
  config.json                kind: config       user settings (plain, nothing sensitive)
  profiles/<profileId>.json  kind: profile      global profiles        (sealed)
  repos/<repoId>/
    repo.json                kind: repo         path, workspaces, usage (sealed)
    profiles/<profileId>.json kind: profile     repo-specific profiles (sealed)

<cloak workspace>/                     may be shared with AI agents
  .repo-cloak/manifest.json  kind: manifest     what was pulled + sealed originals
```

`repoId` = first 16 hex chars of `sha256(realpath(git common dir))`, so every worktree of a repo
shares one id (see [sync.md](sync.md)). Stable,
short, and does not reveal the path. `profileId` is a random id, so file
names never reveal a profile's name either.

## Config (`kind: config`)

Plain JSON; nothing in it is sensitive.

```json
{
  "$schema": "https://unpkg.com/repo-cloak-cli@2/schemas/config.schema.json",
  "kind": "config",
  "schemaVersion": 1,
  "workspacesRoot": "/Users/me/cloak",
  "worktreePath": "/Users/me/worktrees",
  "initGit": true,
  "concurrency": 16,
  "extensions": {}
}
```

## Sealed envelope (store files)

Profiles and repo records are encrypted at rest. On disk every one of them has
the same small shape; the document itself is inside `sealed`:

```json
{
  "kind": "profile",
  "schemaVersion": 1,
  "id": "pf_6d0c2a91",
  "sealed": {
    "alg": "A256GCM",
    "keyId": "k_9b2f4e",
    "nonce": "base64...",
    "data": "base64..."
  }
}
```

The examples below show the **decrypted** document, which is what the schema
describes and what people, the web UI, and LLMs work with.

Editing encrypted profiles:

| How                                   | What happens                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `repo-cloak profile edit <name>`      | Decrypts to a temp file (0600) and opens `$EDITOR`; validates on save, re-seals, deletes the temp file. |
| `repo-cloak profile export <name>`    | Prints the decrypted JSON, for review or to hand to an LLM.                                             |
| `repo-cloak profile import <file\|->` | Validates JSON (from a file or stdin, for example LLM output) and seals it.                             |
| Web UI                                | Edits through the local API; plaintext never touches disk.                                              |

What this protects against, honestly: the key file sits in the same store, so
encryption keeps profiles safe from backups, sync tools, accidental sharing,
and other programs reading files, but not from someone with full access to
the user's account. Moving the key into the OS keychain is a possible later
step.

## Profile (`kind: profile`)

The file people and LLMs edit most. Shown decrypted; stored sealed.

```json
{
  "$schema": "https://unpkg.com/repo-cloak-cli@2/schemas/profile.schema.json",
  "kind": "profile",
  "schemaVersion": 1,
  "name": "acme",
  "description": "Client names for the Acme engagement",
  "rules": [
    {
      "id": "company",
      "type": "literal",
      "match": "Acme",
      "replace": "Northwind",
      "boundary": "token",
      "except": ["Acmeology"]
    },
    {
      "id": "service-names",
      "type": "regex",
      "match": "acme-(\\w+)-svc",
      "flags": "i",
      "replace": "northwind-$1-svc"
    },
    {
      "id": "cloud-keys",
      "type": "secret",
      "detector": "aws-access-key"
    }
  ],
  "extensions": {}
}
```

Profiles may also set `include: string[]` and `exclude: string[]` selection
globs. Includes override ordinary default exclusions; excludes add exclusions.
Metadata paths stay excluded, and existing tracked workspace files remain
tracked when the patterns change.

Rule fields:

| Field                                   | Types          | Meaning                                                             |
| --------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `id`                                    | all            | Unique within the profile. Used in errors, UI, and manifests.       |
| `type`                                  | all            | `literal`, `regex`, or `secret`.                                    |
| `match`                                 | literal, regex | Text or pattern to find.                                            |
| `replace`                               | literal, regex | Replacement; regex supports `$1`, `$<name>`.                        |
| `flags`                                 | regex          | JS regex flags (`i`, `u`, `s`, `m`). `g` is implied.                |
| `boundary`, `styles`, `forms`, `except` | literal        | Case styles and matching edges; see [anonymizer.md](anonymizer.md). |
| `detector`                              | secret         | Built-in detector id (see Secrets below).                           |
| `scope`                                 | all, optional  | `content`, `paths`, or both (default both).                         |
| `enabled`                               | all, optional  | Default true. Lets a profile keep a rule without using it.          |

Scope (global or repo) is **not** stored in the file; it comes from where the
file lives, so moving a file changes its scope and nothing can disagree.

## Profile operations

```
CLI arguments -> commands/profile -> core/rules + core/merge
                       |
                       +-> adapters/profiles -> sealed store files
                       +-> adapters/prompts  -> Inquirer (editor, choice, confirm)
                       +-> adapters/input    -> JSON file or stdin

save -> validate -> lock scope directory -> check unique name -> seal -> atomic write
```

- `core/rules` owns the profile type and semantic validation. It checks rule
  ids, duplicate settings, literal mappings, and regex syntax. Regex flags
  are `i`, `m`, `s`, `u`; `g` is implied. Disabled rules are still validated.
- `core/merge` rejects repeated profile identities and conflicting mappings;
  identical active rules are deduplicated even when their local ids differ.
  Concrete regex/secret pairs and case-variant collisions are checked by the
  replacement engine, once actual matches are available.
- `SavedProfile` carries `{ id, scope, profile }`. Scope is either
  `{ kind: 'global' }` or `{ kind: 'repo', repoId }`, never an editable
  profile field. Names are case-sensitive and unique within their scope.
- Inquirer opens create/edit JSON in `$VISUAL` or `$EDITOR`, using a `0600`
  temporary file and removing it afterwards. Its platform defaults are Vim
  on macOS/Linux and Notepad on Windows. Invalid edits stay in the prompt
  for correction; the stored profile is unchanged until validation passes.
- `proper-lockfile` protects scope updates, including the duplicate-name
  check. Import creates a new opaque id and never overwrites an existing
  name. Edit retains the id, including when the profile is renamed.
- Create/import default to the current repo; `--global` selects global
  storage, including outside Git. Reads list both scopes unless filtered.
  Ambiguous names prompt only with a terminal and without `--yes`.
- Delete asks for confirmation unless `--yes` is given. Create/edit require
  a terminal; scripts create profiles with `profile import <file|->`.
- Runtime libraries are Commander, Zod, Inquirer, proper-lockfile,
  Lodash (word splitting), ahocorasick (literal matching), Glob/minimatch
  (selection), p-limit (I/O concurrency), and isbinaryfile v5 (Node 22 support).
  Inquirer requires Node 22.13+ on the 22.x line, or Node 23.5+.

## How regex and secrets stay reversible

Push must restore every original exactly, but a regex or a secret detector is
not reversible on its own. So pull records **what actually happened**:

```
rules (literal, regex, secret)
        |
        v  pull scans files
concrete pairs found          "Acme"            -> "Northwind"
                              "acme-billing-svc"-> "northwind-billing-svc"
                              "AKIAIOSFODNN7EX.."-> "REDACTED_AWS_ACCESS_KEY_1"
        |
        +--> validated: one-to-one, no anonymized value already in the source
        +--> stored sealed in the manifest as the "ledger"
        |
        v  push
restore uses the ledger (exact, fast literal replace)
```

The ledger also means push never has to re-run regexes.

Limit: text **newly written** in the workspace that matches a regex shape but
was never pulled (for example a new `northwind-payments-svc`) has no ledger
entry, so it is pushed as-is. Literal rules do not have this limit, because
their reverse is known up front.

## Repo record (`kind: repo`)

```json
{
  "$schema": "https://unpkg.com/repo-cloak-cli@2/schemas/repo.schema.json",
  "kind": "repo",
  "schemaVersion": 1,
  "repoId": "3f9a1c0b7d2e4a51",
  "path": "/Users/me/work/acme-platform",
  "workspaces": {
    "7c1e...uuid": {
      "path": "/Users/me/cloak/northwind",
      "createdAt": "2026-10-16T10:00:00Z",
      "lastUsedAt": "2026-10-16T12:30:00Z",
      "useCount": 4,
      "lastProfiles": ["acme", "common-secrets"]
    }
  },
  "extensions": {}
}
```

Shown decrypted; stored sealed. `workspaces` drives the smart suggestions: ranked by recency and use count,
and paths that no longer exist are hidden.

## Workspace manifest (`kind: manifest`)

Lives in the cloak workspace, so it is the one file that may be seen by an AI
agent or someone else. It has two parts:

```
manifest.json
+-- plain   (only anonymized data; enough for status without the key)
|     workspaceId, source.repoId, files{ anonymized path -> hash, size, ... },
|     pulls[] history, tool version
|
+-- sealed  (one AES-256-GCM blob; needs the key)
      source path, profiles used (with content hash), resolved rules,
      ledger of concrete pairs, files{ anonymized path -> original path,
      source hash at pull }, source commit at each pull (for a future merge)
```

```json
{
  "$schema": "https://unpkg.com/repo-cloak-cli@2/schemas/manifest.schema.json",
  "kind": "manifest",
  "schemaVersion": 2,
  "tool": { "name": "repo-cloak", "version": "2.0.0" },
  "workspaceId": "7c1e...uuid",
  "source": { "repoId": "3f9a1c0b7d2e4a51" },
  "files": {
    "src/northwind/billing.ts": {
      "hash": "sha256-...",
      "size": 2048,
      "binary": false
    }
  },
  "pulls": [
    {
      "id": "p_01",
      "at": "2026-10-16T10:00:00Z",
      "selection": { "files": 12, "commits": 2, "working": true, "extra": 1 },
      "toolVersion": "2.0.0"
    }
  ],
  "sealed": {
    "alg": "A256GCM",
    "keyId": "k_9b2f4e",
    "nonce": "base64...",
    "data": "base64..."
  },
  "extensions": {}
}
```

### Recorded automatically, so nothing is asked twice

repo-cloak fills these in itself on every pull; the user never types them into
JSON:

| Recorded                                     | Where                         | Used for                                                   |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Source repo id                               | manifest, plain               | Finding the repo record and its profiles                   |
| Source repo path                             | manifest, sealed; repo record | Push knows where to write without asking                   |
| Source commit at each pull                   | manifest, sealed              | A future merge (base version)                              |
| Profiles used: id, name, scope, content hash | manifest, sealed              | Re-pull uses the same profiles; warns if one changed since |
| Resolved rules (snapshot)                    | manifest, sealed              | Push stays correct even if a profile is edited later       |
| Ledger of concrete replacements              | manifest, sealed              | Exact restore on push                                      |
| Files: original path, hashes                 | manifest, sealed and plain    | Status, push, conflict detection                           |
| Workspace path, last profiles, use count     | repo record                   | Suggestions next time `repo-cloak` runs in that repo       |

So after the first pull:

- `repo-cloak push` in the workspace needs no answers: source, rules, and
  files all come from the manifest.
- `repo-cloak pull` in the workspace re-pulls with the same source and
  profiles.
- `repo-cloak` in the source repo suggests the last workspaces and profiles.

Snapshot vs. live profile: push always uses the **snapshot** (what was really
applied). Re-pull uses the profiles' **current** versions; if a profile's
content hash differs from the snapshot, it shows what changed and asks first.

Why it is shaped this way:

- **One sealed blob**: one encrypt per write, one decrypt per read, and nothing
  about individual names (not even their length) is visible.
- **`hash` (plain)** is the anonymized file's hash at pull time, so
  `status`/push can find workspace edits without decrypting anything.
- **`sourceHash` (sealed)** is the original file's hash at pull time, so push
  can detect that the source changed since the pull (conflict).
- **`keyId`** identifies which key sealed the data, so keys can be rotated or
  a missing key reported clearly.
- **`pulls`** keeps re-pull history instead of overwriting it.
- **`files` as a map** keyed by anonymized path: O(1) lookups, stable diffs.

## Encryption

- AES-256-GCM via `node:crypto`, a fresh random 12-byte nonce per seal, the
  manifest's plain part bound as additional authenticated data (AAD), so
  tampering with either part fails decryption.
- The key is used directly (it is already 32 random bytes); no per-value
  key derivation. `keyId` = `k_` plus the first 12 hex characters of SHA-256
  of the key.
- Wire format: `nonce` is a base64-encoded 12-byte nonce; `data` is base64 of
  ciphertext followed by the 16-byte GCM authentication tag. AAD is the plain
  JSON object with recursively sorted object keys, encoded as compact UTF-8.
  For store envelopes, all outer fields except `sealed` are authenticated.
  For manifests, pass the entire manifest except `sealed` as AAD.
- Key creation publishes a fully written key with an exclusive hard link;
  simultaneous creators load the same winning key. Reads never create keys.
  A damaged key is an error, never silently replaced.

## Platform compatibility

- macOS, Windows, and Linux use Node's home-directory and path APIs; no shell
  commands are used to read Git identity or manage files. Git must be on PATH.
- Git identity uses absolute `rev-parse` paths and `realpath` for both the
  worktree root and common directory. This requires Git 2.31 or later
  (`--path-format=absolute`).
- On POSIX, keys and temporary files have mode `0600`, store directories
  `0700`. Windows inherits filesystem ACLs; Node's mode argument cannot
  enforce a Unix-style permission boundary there. The store should live in
  the user's private home directory on a filesystem supporting hard links
  (NTFS on Windows, APFS on macOS, or a typical Linux filesystem).
- Atomic writes flush a temporary file in the destination directory, close
  its handle, then rename over the destination. Windows sharing violations
  get bounded retries; the old file is never deleted as a fallback.
- Store-relative paths use `/` internally and reject traversal, Windows
  reserved device names, and characters invalid on Windows. Host paths are
  kept in their native format.
- CI runs type checking, lint, tests, build, and package smoke checks on
  macOS, Windows, and Linux with Node 22 and 24.

## Secrets

v1's scanner is a good **pattern list** but a weak **engine**:

- it tests every pattern on every line separately (slow on big files);
- some patterns are buggy (`[M|N]` and `[h|H]` treat `|` as a literal), one
  is duplicated (GitHub OAuth), and the generic password pattern has many
  false positives;
- it only reports; it never redacts, and swallows read errors.

v2: secret detectors become **data** (id, name, regex, optional entropy
threshold) shipped as a built-in catalog, and are used through `secret` rules
like any other rule. Matches are replaced with stable placeholders such as
`REDACTED_AWS_ACCESS_KEY_1`, recorded in the ledger, and restored on push. The
v1 patterns are the starting catalog, with the bugs fixed.

## Validation

Runs on load and before every pull:

```
parse JSON  ->  schema check (zod)  ->  semantic checks  ->  ok / errors
```

Semantic checks:

- profile: unique rule ids; regexes compile; no duplicate literal rules;
- run: no profile selected twice; merged rules one-to-one (see overview);
- ledger: one-to-one; no anonymized value already present in source files.

Every error names the file, profile, and rule id involved.

## Tooling

- `zod` (v4) is the one new runtime dependency: types, validation, and
  JSON Schema output from one definition.
- `npm run build` also writes `schemas/*.schema.json`; `files` in
  `package.json` gains `schemas` so they ship.
- `repo-cloak schema <kind>` prints a schema, so an LLM can be handed it
  directly.

## Decided

- Store files (profiles, repo records) are encrypted at rest with the sealed
  envelope; `config.json` stays plain because it holds nothing sensitive.
- No v1 support: v2 does not read `.repo-cloak-map.json`. v1 workspaces must
  be pushed with v1 before upgrading.
