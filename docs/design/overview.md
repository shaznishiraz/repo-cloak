# Overview: repo-cloak v2

Status: **draft, not agreed**. Implements `docs/requirements.md`.

## Problem

Move files between a proprietary source repo and an anonymized cloak workspace,
both ways, with reusable rule profiles, encrypted tracking, and good
performance.

## The big picture

```
                         ~/.repo-cloak/  (machine-local store)
                  +-----------------------------------------+
                  | key            (0600, never leaves box) |
                  | config.json    settings                 |
                  | profiles/*.json            global       |
                  | repos/<repoId>/repo.json   path, history|
                  | repos/<repoId>/profiles/   repo-specific|
                  +-----------------------------------------+
                         ^  profiles, suggestions   ^
                         |                          |
  +--------------+   pull  (anonymize)      +------------------------+
  | source repo  | -----------------------> | cloak workspace        |
  | (proprietary)|                          |  anonymized files      |
  |              | <----------------------- |  .repo-cloak/manifest  |
  +--------------+   push  (restore)        +------------------------+
                                                 |
                                       repo-cloak ui (127.0.0.1)
```

## Commands

`pull`, `push`, `status`, `profile`, `workspaces`, `ui`, `schema`, plus
interactive mode with no arguments. Full list and flags: [cli.md](cli.md).

## Interactive flow

```
repo-cloak
   |
   +-- where am I?
   |     cloak workspace (has .repo-cloak/manifest) --> push / re-pull / ui
   |     registered source repo ---------------------> continue below
   |     new git repo -------------------------------> register, continue
   |
   +-- profiles:  [repo-specific] + [global]  (multi-select)  or  create new
   |       |
   |       +-- merge + validate  --(conflict)--> show conflict, fix, retry
   |
   +-- what to pull?  (any combination)
   |       files (tree) | commits | working changes | extra paths
   |
   +-- destination:   suggested past workspaces  |  new folder
   |
   +-- preview (N files, M replacements, secrets found)  --> confirm
   |
   +-- pull  --> write files + manifest  --> record history
```

## Modules

```
src/
  cli.ts                      parse args, pick command
  program.ts                  commander setup
  commands/                   orchestration, no business rules
    interactive.ts  pull.ts  push.ts  profile.ts  ui.ts
  core/                       pure logic, no I/O
    rules.ts        Rule, Profile types; validate a profile
    merge.ts        combine profiles, detect conflicts
    replacer.ts     compile rules once; apply forward / reverse
    paths.ts        anonymize / restore file paths
    manifest.ts     manifest schema, build, parse, diff
    selection.ts    union of files/commits/working/extra, dedupe
    suggest.ts      rank past destinations
  adapters/                   I/O behind small interfaces
    store.ts        ~/.repo-cloak read/write
    crypto.ts       key management, encrypt/decrypt
    git.ts          repo root, commit files, working changes
    files.ts        read/write, binary detection, hashing, concurrency
    prompts.ts      interactive questions
    server.ts       web UI server
```

Rule from `AGENTS.md`: `core/` imports nothing from `commands/` or
`adapters/`. Commands get adapters passed in, so tests use fakes.

## Data model

All JSON files (profiles, store, workspace manifest), their schemas, and how
regex and secret rules stay reversible: see [data-model.md](data-model.md).

## Profile merge and validation

Push must be able to reverse every replacement, so the merged rule set has to
be a clean one-to-one mapping.

```
profiles A, B, C  -->  concat rules  -->  checks  -->  merged rules
                                            |
     duplicate profile selected  -----------+--> error
     same original, different anonymized ---+--> conflict (names both profiles)
     different originals, same anonymized --+--> conflict (push could not reverse)
     identical rule in two profiles  -------+--> deduped, not an error
```

Two extra checks run against the actual files before pulling:

- **Overlaps**: `Acme` and `AcmeCorp` both present. Longest match wins.
- **Pre-existing anonymized values**: the source already contains `Northwind`.
  Push would wrongly turn it into `Acme`, so pull warns or refuses.

## Replacement engine

```
rules --compile once--> one matcher (longest-first alternation)
file  --single pass---> anonymized text
```

- Rule types: literal, regex, and secret detectors. Pull records the concrete
  pairs it replaced (the ledger), and push restores from that ledger.
- Case variants are handled: `acme`, `Acme`, `ACME` map to `northwind`,
  `Northwind`, `NORTHWIND` (as v1 did).
- The same compiled matcher, inverted, restores on push.

## Push

Push is **all or nothing**: it checks every file first and writes only if
nothing conflicts, so the source repo is never left half updated.

```
1. preflight (no writes)
   for each file in manifest + new files in workspace:
     workspace hash unchanged? --------------------> skip
     changed / new / deleted?  --> restore text + path (from ledger)
                                   source file changed since pull?
                                     no  -> plan: write / create / delete
                                     yes -> CONFLICT

2. any conflicts?
     no  -> 3. write all planned changes, update manifest
     yes -> stop, write nothing, report:

   ! 2 files changed in the source repo since they were pulled:
       src/billing/invoice.ts
       src/billing/tax.ts
     To push, first make these files match what was pulled:
       commit or stash your source changes (git stash), then push again,
       and re-apply them afterwards.
     Or skip them:     repo-cloak push --skip-conflicts
     Or overwrite:     repo-cloak push --force
```

Deleted files are listed in the preview and need confirmation.

From a source repo: look up linked workspaces in the store, ask which one, then
run the same push.

### Later: merge instead of stop

A real merge is less work than it sounds, because git already ships a
three-way merge for single files (`git merge-file`). It needs three versions:

```
base   = the source file as it was at pull time
ours   = the source file now
theirs = the workspace file, restored
```

`base` is free when the file was committed at pull time (`git show
<commit>:<path>`; the manifest would record the commit). For files pulled from
uncommitted working changes, the manifest would need a sealed copy. The result
is a normal file with `<<<<<<<` conflict markers for the user to resolve. Not
in 2.0; the manifest records the pull commit so it can be added without a
format change.

## Security

- Key: 32 random bytes in `~/.repo-cloak/key`, mode `0600`, created on first use.
- Encryption: AES-256-GCM, one sealed blob per manifest with a fresh 12-byte nonce, via
  `node:crypto` (no extra dependency).
- In a cloak workspace, only anonymized values are plaintext.

## Performance

- Rules compiled once per run, one pass per file.
- Files processed in parallel with a bounded limit.
- Binary files detected and copied (or skipped) without text processing.
- Content hashes make re-pull and push touch only changed files.
- Git data read with machine-readable output (`-z`) in as few calls as possible.

## Build order

Steps, tasks, and acceptance scenarios: [plan.md](../plan.md).

## Decided

- Rules support regex as well as literal text.
- Every configurable thing is JSON with a published schema.
- Secret detection is rebuilt as data-driven `secret` rules, starting from
  v1's pattern list.
- Web UI: `node:http` plus plain HTML, CSS, and JS (see [web-ui.md](web-ui.md)).
- Store files are encrypted at rest (see [data-model.md](data-model.md)).
- No v1 support. v2 is a fresh start.
- Push conflicts stop the push, write nothing, and explain how to resolve.
  Merging is a later addition.
