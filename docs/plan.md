# Build plan

The order v2 is built in. Each step lists its tasks and the **acceptance
scenarios** that must pass; every scenario becomes at least one Vitest test.
Tick boxes as work lands. 🏁 marks a milestone: update the OpenWiki there.

Designs: [overview](design/overview.md) ·
[data model](design/data-model.md) · [CLI](design/cli.md) ·
[web UI](design/web-ui.md)

## Progress

| Step | What                                  | Status  |
| ---- | ------------------------------------- | ------- |
| 0    | Scaffold                              | ✅ Done |
| 1    | Store, crypto, repo identity, schemas | ⏳ Next |
| 2    | Profiles                              |         |
| 3    | Replacement engine                    |         |
| 4    | Pull 🏁                               |         |
| 5    | Push and status 🏁                    |         |
| 6    | Interactive mode                      |         |
| 7    | Web UI 🏁                             |         |
| 8    | Release 2.0.0                         |         |

---

## Step 0. Scaffold ✅

- [x] TypeScript, tsup, Vitest, ESLint, Prettier
- [x] `repo-cloak` / `cloak` bins, version and description from `package.json`

**Acceptance**

- **WHEN** the user runs `cloak --help` **THEN** the output matches
  `repo-cloak --help` and names the program `repo-cloak`.
- **WHEN** the user runs `repo-cloak -v` or `--version` **THEN** it prints the
  `version` from `package.json` and exits 0.
- **WHEN** the user runs `repo-cloak --help` **THEN** it prints usage, the
  package description, and the version and help options.

## Step 1. Store, crypto, repo identity, schemas

Design: [data-model.md](design/data-model.md) (files at a glance, sealed
envelope, encryption, tooling).

- [ ] Add `zod`; schema module with `kind`, `schemaVersion`, `extensions`
- [ ] `adapters/crypto`: create/load key (0600), `seal` / `open` with AES-256-GCM, `keyId`
- [ ] `adapters/store`: resolve `~/.repo-cloak`, read/write sealed and plain files atomically
- [ ] `core`: `repoId` from a repo's real path; schema version checks and migrations hook
- [ ] `adapters/git`: find the repo top-level
- [ ] Build writes `schemas/*.schema.json`; `package.json` `files` includes `schemas`
- [ ] `repo-cloak schema <kind>`

**Acceptance**

- **WHEN** no key exists **THEN** one is created with 32 random bytes and mode 0600.
- **WHEN** data is sealed then opened **THEN** the original is returned exactly.
- **WHEN** a sealed blob or its plain part is altered **THEN** opening fails.
- **WHEN** a file was sealed with a different key **THEN** the error names the `keyId`.
- **WHEN** the same repo is reached through a symlink **THEN** its `repoId` is the same.
- **WHEN** a file has a newer `schemaVersion` than supported **THEN** loading fails with a clear message.
- **WHEN** a file has unknown fields **THEN** they are kept on save.
- **WHEN** the user runs `repo-cloak schema profile` **THEN** it prints valid JSON Schema.

## Step 2. Profiles

Design: [data-model.md](design/data-model.md) (profile), [overview.md](design/overview.md)
(profile merge and validation), [cli.md](design/cli.md) (`profile`).

- [ ] `core/rules`: literal, regex, secret rule types; validate a profile
- [ ] `core/merge`: combine profiles, dedupe, detect conflicts
- [ ] Profile storage in the store (global and per repo), sealed
- [ ] `profile list | show | create | edit | delete | export | import | check`

**Acceptance**

- **WHEN** two rules in one profile share an `id` **THEN** validation fails naming the id.
- **WHEN** a regex rule does not compile **THEN** validation fails naming the rule.
- **WHEN** the same profile is selected twice **THEN** the run fails.
- **WHEN** two profiles map one original to different values **THEN** it fails naming both profiles and rules.
- **WHEN** two profiles map different originals to one value **THEN** it fails (push could not reverse it).
- **WHEN** two profiles contain an identical rule **THEN** it is deduplicated without error.
- **WHEN** a profile is imported from stdin **THEN** it is validated, sealed, and listed.
- **WHEN** a global and a repo profile share a name under `--yes` **THEN** the command fails asking for `--global` or `--repo`.

## Step 3. Replacement engine

Design: [overview.md](design/overview.md) (replacement engine),
[data-model.md](design/data-model.md) (reversibility, secrets).

- [ ] `core/replacer`: compile rules once; single pass; longest match wins
- [ ] Case variants for literal rules; whole-word option
- [ ] Regex rules with capture groups; secret detectors from a built-in catalog
- [ ] Ledger of concrete pairs; restore from the ledger
- [ ] `core/paths`: anonymize and restore file paths

**Acceptance**

- **WHEN** text is anonymized then restored **THEN** it equals the original (round trip).
- **WHEN** `Acme` and `AcmeCorp` are both rules **THEN** `AcmeCorp` is replaced as a whole.
- **WHEN** a literal rule has case variants **THEN** `acme`, `Acme`, `ACME` keep their case style.
- **WHEN** a regex rule matches `acme-billing-svc` **THEN** the ledger records the concrete pair.
- **WHEN** a secret is detected **THEN** it becomes a stable placeholder and is restored on push.
- **WHEN** the source already contains an anonymized value **THEN** pull is refused with the files listed.

## Step 4. Pull 🏁

Design: [overview.md](design/overview.md), [data-model.md](design/data-model.md)
(manifest, recorded automatically), [cli.md](design/cli.md) (`pull`).

- [ ] `core/selection`: union of files, commits, working changes, extra paths
- [ ] `adapters/git`: files in commits, working changes (`-z` output)
- [ ] `adapters/files`: bounded parallel I/O, binary detection, hashing
- [ ] `core/manifest`: build plain + sealed parts
- [ ] Repo record: workspaces, last profiles, suggestions
- [ ] `repo-cloak pull` with all flags, `--dry-run`, `--yes`

**Acceptance**

- **WHEN** `--commit a --working --files x` are combined **THEN** the union is pulled once per file.
- **WHEN** a pull completes **THEN** no original name or path appears in plaintext in the workspace.
- **WHEN** `--dry-run` is used **THEN** nothing is written.
- **WHEN** pull runs again in a workspace **THEN** it reuses the recorded source and profiles.
- **WHEN** a recorded profile changed since the last pull **THEN** the user is shown the change and asked.
- **WHEN** a binary file is pulled **THEN** it is copied unchanged.

## Step 5. Push and status 🏁

Design: [overview.md](design/overview.md) (push), [cli.md](design/cli.md)
(`push`, `status`, `workspaces`).

- [ ] `repo-cloak status` from plain manifest hashes
- [ ] Preflight: plan writes, detect conflicts; all or nothing
- [ ] Restore contents and paths from the ledger; create, update, delete
- [ ] Push from the source repo with `--from` or a prompt
- [ ] `--skip-conflicts`, `--force`, `--dry-run`, `--yes`; exit code 2 on conflicts
- [ ] `repo-cloak workspaces`

**Acceptance**

- **WHEN** a workspace file is unchanged **THEN** push skips it.
- **WHEN** a source file changed since the pull **THEN** push writes nothing, lists it, and exits 2.
- **WHEN** `--skip-conflicts` is used **THEN** all other files are pushed.
- **WHEN** a new file is created in the workspace **THEN** push creates it at the restored path.
- **WHEN** a file is deleted in the workspace **THEN** push asks before deleting it in the source.
- **WHEN** push runs in a source repo with two linked workspaces **THEN** it asks which one.

## Step 6. Interactive mode

Design: [overview.md](design/overview.md) (interactive flow).

- [ ] Detect location: cloak workspace, known source repo, new repo
- [ ] Profile multi-select with create-new, validated live
- [ ] Selection (tree, commits, working changes, extra paths), destination suggestions, preview

**Acceptance**

- **WHEN** `repo-cloak` runs in a cloak workspace **THEN** it offers push, re-pull, and UI.
- **WHEN** it runs in a known source repo **THEN** the last-used profiles and workspaces are suggested first.
- **WHEN** it runs in a new git repo **THEN** the repo is registered before continuing.

## Step 7. Web UI 🏁

Design: [web-ui.md](design/web-ui.md).

- [ ] `node:http` server, static assets, JSON API over existing commands
- [ ] Session token, `127.0.0.1` only, `Host` / `Origin` checks
- [ ] Screens: workspaces, profile list and editor, pull history

**Acceptance**

- **WHEN** an API call has no valid token **THEN** it is rejected.
- **WHEN** a request has a foreign `Origin` **THEN** it is rejected.
- **WHEN** a profile is saved in the UI **THEN** it passes the same validation as the CLI.
- **WHEN** the UI assets are built **THEN** they total under 50 KB.

## Step 8. Release 2.0.0

- [ ] README rewritten for v2, with a note that v1 workspaces must be pushed with v1 first
- [ ] `npm view repo-cloak-cli version` is below `2.0.0`
- [ ] `npm pack --dry-run` contents reviewed
- [ ] Publish only when the user asks
