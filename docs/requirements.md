# repo-cloak v2 requirements

What v2 must do, and why. Design lives in `docs/design/`.

## Purpose

Let a developer take files out of a proprietary repository, anonymize them
(names, paths, secrets), work on the anonymized copy (for example with an AI
agent), and bring the changes back with the original names restored.

## Terms

| Term                | Meaning                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Source repo**     | The proprietary repository files are pulled from and pushed back to.                                                      |
| **Cloak workspace** | The anonymized copy that files are pulled into.                                                                           |
| **Rule**            | One replacement: `original -> anonymized` (e.g. `Acme -> Northwind`).                                                     |
| **Profile**         | A named set of rules. Either **global** or **repo-specific**.                                                             |
| **Manifest**        | The JSON in a cloak workspace that records what was pulled, from where, with which rules. Sensitive values are encrypted. |

## Invocation

- `repo-cloak` (alias `cloak`). Running it with no arguments starts
  **interactive mode**.
- Every interactive choice can also be given as a flag, so the same flows work
  non-interactively (scripts, agents).

## R1. Machine-local store

- repo-cloak keeps a private store on the machine (in the user's home dir).
- Each source repo is registered by its path; that identity is the key for its
  repo-specific profiles, its past cloak workspaces, and its suggestions.
- Everything sensitive in the store (profiles, repo paths, workspace history)
  is encrypted at rest, and the store is readable only by the user.

## R2. Profiles

- Two scopes: **global** (reusable across repos, for common things) and
  **repo-specific**.
- A run can use **several profiles at once**, mixing global and repo-specific.
- When starting in a known source repo, repo-cloak offers that repo's profiles
  and global profiles. The user can pick existing ones or create a new one.
- Rules can be **literal text**, **regex** (with capture groups), or **secret
  detectors** (built-in patterns for keys, tokens, passwords).
- Every configurable thing (profiles, settings) is a JSON file with a published
  **JSON Schema**, so it can be edited by hand, by the web UI, or by an LLM.
- Validation, on create, edit, and whenever profiles are combined:
  - no duplicate profile names within a scope;
  - the same profile cannot be selected twice in one run;
  - no duplicate rules within a profile;
  - **no conflicts** when combining: the same original mapped to two different
    anonymized values, or two originals mapped to the same anonymized value;
  - errors explain exactly which profiles and rules conflict.

## R3. Cloak (source repo -> cloak workspace)

Run as `repo-cloak push` in a source worktree or `repo-cloak pull` in a cloak
workspace (see `docs/design/cli.md`, Direction).

- Choose what to pull, in any combination:
  - files picked from the repo (tree selector);
  - files changed in one or more **commits** (by commit id);
  - **current working changes** (staged, unstaged, untracked);
  - extra file paths given explicitly.
- Choose the destination cloak workspace. Previous destinations for this source
  repo are suggested, most relevant first.
- Apply all selected profiles to file **contents and paths/names**.
- Write a manifest that records, per file, the anonymized path (readable) and
  the original path (encrypted), plus the rules used (encrypted), so push can
  reverse everything.
- Pulling again into an existing workspace updates it rather than starting over.

- Detected secrets are replaced with placeholders in the workspace and restored
  on push. The v1 pattern list is the starting point, with its bugs fixed.

## R4. Restore (cloak workspace -> source repo)

Run as `repo-cloak push` in a cloak workspace or `repo-cloak pull` in a source
worktree.

- `repo-cloak push` from a **cloak workspace** writes its changes back to the
  source repo, restoring original names in contents and paths.
- `repo-cloak pull` from a **source worktree** brings in changes from the
  workspace linked to its branch, or asks which one when there are several.
- Only changed, added, or deleted files are processed.
- Never silently overwrite source files that changed since the last cloak. If
  any have, the restore stops without writing anything, lists them, and explains how to
  resolve it (commit or stash the source changes, skip those files, or force).
- A restore is all or nothing: the source repo is never left half updated.

## R5. Security

- Encryption uses a strong, standard scheme (authenticated encryption, random
  nonces, a per-machine key with owner-only permissions).
- Original names and paths never appear in plaintext inside a cloak workspace.

## R6. Performance

- Fast on large repos: a single pass per file for all rules, parallel file I/O
  with a bounded limit, binary files skipped, and change detection by content
  hash so unchanged files are not re-processed.

## R7. Web UI

- `repo-cloak` can start a local web server (from a cloak workspace) to manage
  ongoing workspaces, profiles, and rules in a browser.
- Local only: bound to `127.0.0.1`, protected by a per-session token.
- As light as possible, since it ships inside the npm package: no front-end
  framework, no extra runtime dependencies, fast to load.

## Out of scope (for now)

- Reading v1 workspaces (`.repo-cloak-map.json`). v2 is a fresh start.
- Merging conflicting changes during push (designed so it can be added later).
- Syncing profiles between machines.
- Remote or shared servers.
