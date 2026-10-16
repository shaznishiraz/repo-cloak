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
| 1    | Store, crypto, repo identity, schemas | ✅ Done |
| 2    | Profiles                              | ✅ Done |
| 3    | Replacement engine                    | ✅ Done |
| 4    | Cloak: source -> workspace 🏁         | ✅ Code |
| 5    | Restore: workspace -> source 🏁       | ✅ Code |
| 6    | Interactive mode                      | ✅ Code |
| 7    | Web UI 🏁                             | ✅ Code |
| 8    | Release 2.0.0                         | ⏳ Next |

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

- [x] Add `zod`; schema module with `kind`, `schemaVersion`, `extensions`
- [x] `adapters/crypto`: create/load key (0600), `seal` / `open` with AES-256-GCM, `keyId`
- [x] `adapters/store`: resolve `~/.repo-cloak`, read/write sealed and plain files atomically
- [x] `core`: `repoId` from the canonical git common dir; schema version checks and migrations hook
- [x] `adapters/git`: find the repo top-level
- [x] Build writes `schemas/*.schema.json`; `package.json` `files` includes `schemas`
- [x] `repo-cloak schema <kind>`

**Acceptance**

- **WHEN** no key exists **THEN** one is created with 32 random bytes and mode 0600.
- **WHEN** data is sealed then opened **THEN** the original is returned exactly.
- **WHEN** a sealed blob or its plain part is altered **THEN** opening fails.
- **WHEN** a file was sealed with a different key **THEN** the error names the `keyId`.
- **WHEN** the same repo is reached through a symlink **THEN** its `repoId` is the same.
- **WHEN** two worktrees of one repo are resolved **THEN** they share one `repoId`.
- **WHEN** a file has a newer `schemaVersion` than supported **THEN** loading fails with a clear message.
- **WHEN** a file has unknown fields **THEN** they are kept on save.
- **WHEN** the user runs `repo-cloak schema profile` **THEN** it prints valid JSON Schema.

## Step 2. Profiles

Design: [data-model.md](design/data-model.md) (profile), [overview.md](design/overview.md)
(profile merge and validation), [cli.md](design/cli.md) (`profile`).

- [x] `core/rules`: literal, regex, secret rule types; validate a profile
- [x] `core/merge`: combine profiles, dedupe, detect conflicts
- [x] Profile storage in the store (global and per repo), sealed
- [x] `profile list | show | create | edit | delete | export | import | check`

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

Design: [anonymizer.md](design/anonymizer.md),
[data-model.md](design/data-model.md) (reversibility, secrets).

- [x] Word splitting and case-style variants (both sides)
- [x] Aho-Corasick matcher via `ahocorasick` in `core/`; longest match wins
- [x] Boundary modes `token`, `word`, `anywhere`; `forms`, `except`, suffixes
- [x] Verify pass: restore(anonymize(file)) == file, else abort
- [x] Preview data: replaced and skipped matches per rule
- [x] Regex rules with capture groups; secret detectors from a built-in catalog
- [x] Ledger of concrete pairs; restore from the ledger
- [x] `core/paths`: anonymize and restore file paths

**Acceptance**

- **WHEN** text is anonymized then restored **THEN** it equals the original (round trip).
- **WHEN** `Acme` and `AcmeCorp` are both rules **THEN** `AcmeCorp` is replaced as a whole.
- **WHEN** a rule is `Acme Corp` -> `Northwind Traders` **THEN** `AcmeCorp`, `acmeCorp`, `acme_corp`, `ACME_CORP`, `acme-corp` each become the same style of `Northwind Traders`.
- **WHEN** the rule is `Acme` in `token` mode **THEN** `getAcmeToken` and `ACME_API` match and `Acmeology` does not.
- **WHEN** the rule is `Ion` **THEN** `Function` is unchanged.
- **WHEN** the agent writes `NorthwindTradersClient` in the workspace **THEN** restore gives `AcmeCorpClient`.
- **WHEN** two rules produce the same variant **THEN** validation fails naming both.
- **WHEN** restored text still contains an anonymized word or placeholder in any casing **THEN** the restore stops and names the file and line.
- **WHEN** a restore replaces forms not in the ledger **THEN** the preview lists them as new.
- **WHEN** two original paths would map to one anonymized path (including case-only differences) **THEN** the cloak is refused.
- **WHEN** a regex rule matches `acme-billing-svc` **THEN** the ledger records the concrete pair.
- **WHEN** a secret is detected **THEN** it becomes a stable placeholder and is restored on push.
- **WHEN** the source already contains an anonymized value **THEN** pull is refused with the files listed.

## Step 4. Cloak: source -> workspace 🏁

Design: [overview.md](design/overview.md), [data-model.md](design/data-model.md)
(manifest, recorded automatically), [cli.md](design/cli.md) (`pull`).

- [x] `core/selection`: union of files, commits, working changes, extra paths
- [x] `adapters/git`: files in commits, working changes (`-z` output)
- [x] `adapters/files`: bounded parallel I/O, binary detection, hashing
- [x] `core/manifest`: build plain + sealed parts
- [x] Repo record: workspaces, last profiles, suggestions
- [x] CLOAK flags on `push` (source) and `pull` (workspace), `--dry-run`, `--yes`
- [x] First `push` in a worktree creates the workspace in `workspacesRoot` or `--to`

**Acceptance**

- **WHEN** `--commit a --working --files x` are combined **THEN** the union is pulled once per file.
- **WHEN** a pull completes **THEN** no original name or path appears in plaintext in the workspace.
- **WHEN** `--dry-run` is used **THEN** nothing is written.
- **WHEN** pull runs again in a workspace **THEN** it reuses the recorded source and profiles.
- **WHEN** a recorded profile changed since the last pull **THEN** the user is shown the change and asked.
- **WHEN** a binary file is pulled **THEN** it is copied unchanged.

**Milestone documentation:** OpenWiki regeneration is pending. The local
`openwiki code --update --print` command requires `OPENAI_API_KEY`, which is
not available in this session. Generated pages were left untouched; rerun the
generator with credentials or use the scheduled workflow after committing.

## Step 5. Restore: workspace -> source, and status 🏁

Design: [overview.md](design/overview.md) (push), [cli.md](design/cli.md)
(`push`, `status`, `workspaces`).

- [x] `repo-cloak status` from plain manifest hashes
- [x] Preflight: plan writes, detect conflicts; all or nothing
- [x] Restore contents and paths from the ledger; create, update, delete
- [x] Push from the source repo with `--from` or a prompt
- [x] `--skip-conflicts`, `--force`, `--dry-run`, `--yes`; exit code 2 on conflicts
- [x] `repo-cloak workspaces`
- [x] Restore into a new worktree with `--new-worktree`, `--base`, and `--path`

**Acceptance**

- **WHEN** a workspace file is unchanged **THEN** push skips it.
- **WHEN** a source file changed since the pull **THEN** push writes nothing, lists it, and exits 2.
- **WHEN** `--skip-conflicts` is used **THEN** all other files are pushed.
- **WHEN** a new file is created in the workspace **THEN** push creates it at the restored path.
- **WHEN** a file is deleted in the workspace **THEN** push asks before deleting it in the source.
- **WHEN** push runs in a source repo with two linked workspaces **THEN** it asks which one.
- **WHEN** a new worktree is requested **THEN** its base defaults to the extracted commit, and all tracked workspace files are restored.
- **WHEN** a new-worktree restore is dry-run or cancelled **THEN** no worktree or branch is created.
- **WHEN** a new-worktree restore fails during a file or manifest write **THEN** files and manifest are rolled back and the new worktree and unchanged branch are removed.
- **WHEN** `--base` and `--path` are supplied **THEN** the new target uses that commit and directory.

**Milestone documentation:** OpenWiki regeneration has the same credential
limitation recorded under step 4; generated pages remain untouched.
Restore supports existing and newly created worktrees. New-worktree planning
reads commit data directly and leaves the source worktree unchanged.

## Step 6. Interactive mode

Design: [overview.md](design/overview.md) (interactive flow).

- [x] Detect location: cloak workspace, known source repo, new repo
- [x] Profile multi-select with create-new, validated live
- [x] Selection (tree, commits, working changes, extra paths), destination suggestions, preview

**Acceptance**

- **WHEN** `repo-cloak` runs in a cloak workspace **THEN** it offers push, re-pull, and UI.
- **WHEN** it runs in a known source repo **THEN** the last-used profiles and workspaces are suggested first.
- **WHEN** it runs in a new git repo **THEN** the repo is registered before continuing.

The UI entry starts the machine-wide dashboard. Other actions route through
the existing sync/status commands. The file picker is
a tree-shaped list of eligible file paths. Non-terminal bare invocation shows
help, and scripts use explicit commands.

## Step 7. Web UI 🏁

Design: [web-ui.md](design/web-ui.md).

- [x] `node:http` server, static assets, JSON API over existing commands
- [x] Session token, `127.0.0.1` only, `Host` / `Origin` checks
- [x] Screens: workspaces, profile list and editor, pull history

**Acceptance**

- **WHEN** an API call has no valid token **THEN** it is rejected.
- **WHEN** a request has a foreign `Origin` **THEN** it is rejected.
- **WHEN** a profile is saved in the UI **THEN** it passes the same validation as the CLI.
- **WHEN** the UI assets are built **THEN** they total under 50 KB.

**Milestone documentation:** OpenWiki regeneration remains pending the
credentials described under step 4. Generated pages were left untouched.

## Step 8. Release 2.0.0

- [ ] README rewritten for v2, with a note that v1 workspaces must be pushed with v1 first
- [ ] `npm view repo-cloak-cli version` is below `2.0.0`
- [ ] `npm pack --dry-run` contents reviewed
- [ ] Publish only when the user asks
