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

- `repo-cloak` (alias `cloak`) opens the local dashboard directly.
- Detect the exact source worktree or cloak workspace without terminal prompts.
- Outside Git, sources can be added through the dashboard folder picker.
- Keep help/version, port selection, browser suppression and the `ui` alias.
- Workflow actions live in the dashboard; terminal workflow subcommands are retired.

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

Create a workspace or choose **Pull files** in the dashboard.

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
- Every cloak workspace has its own Git repository. Successful Pull and Push
  operations checkpoint managed cloak files and the sealed manifest for rollback;
  source changes remain uncommitted. Local credentials are never checkpointed.

- Detected secrets are replaced with placeholders in the workspace and restored
  on push. The v1 pattern list is the starting point, with its bugs fixed.

## R4. Restore (cloak workspace -> source repo)

Choose **Push changes** for the selected cloak workspace in the dashboard.

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

- `repo-cloak` opens one machine-wide local dashboard, using the launch repo,
  worktree or cloak workspace as context without asking for the same location again.
- First-run setup starts at a source folder/file picker. Users can browse local
  destination folders and save a global cloak-workspaces root.
- Create, refresh and restore use the shared application services, with previews,
  explicit confirmation, conflict handling and existing/new worktree targets.
- Optional globally configured post-create commands run once in the new workspace;
  a failed command stops the sequence and leaves the workspace available.
- Manage workspace status/history, profiles, rules and workspace defaults in the browser.
- Open menus can register a cloak or group folder with Orca using its installed CLI,
  with actionable errors when the CLI or running application is unavailable.
- Local only: bound to `127.0.0.1`, protected by a per-session token.
- As light as possible, since it ships inside the npm package: no front-end
  framework, no extra runtime dependencies, fast to load.

## R8. Repository groups

- Group 1..8 registered source repositories, with one explicitly chosen workspace
  and source worktree per repository. Add the launch repository to a new or
  existing group after creating its workspace.
- Persist group names and targets encrypted locally; group removal preserves
  repositories and workspaces.
- Show grouped navigation, combined Pull all/Push all and individual member
  controls. Keep profiles, exclusions and history independent.
- Dashboard grouping moves selected cloak workspaces into one shared directory.
  Keep one workspace per member, preserving its identity, scoped credentials,
  request queue, local edits and Git history. Existing logical groups can create
  their folder through the editor. Failed moves restore original locations.
- Include root agent instructions and scoped member connections. Reveal cloak
  workspaces/group folders in the file manager or open them in VS Code or Zed.
- Preview and recheck all members before starting writes; preserve per-member
  confirmations, conflicts and existing writer safety checks.
- Queue members sequentially, report partial success and retry only unfinished
  members. No transaction is promised across independent repositories.

See [repository groups](design/repository-groups.md).

## R9. Agent file requests and workspace guidance

- Every new workspace includes managed agent guidance and a skill; preserve user
  instructions and prevent generated helper/configuration data from pushing to source.
- Offer a neutral custom workspace name while retaining automatic names and
  multiple workspaces per repository/worktree.
- Agents use workspace-scoped HTTP/MCP credentials to probe anonymized paths,
  queue necessary files and poll sanitized status. They cannot approve or sync.
- The owner previews and approves exact file subsets. Exclusions, text/size
  limits, source identity, stale approval checks and atomic writer guarantees apply.
- Provide per-workspace/group request views and reviewed MCP setup controls for
  Codex project configuration, Claude local scope and other clients via copyable
  configuration, preserving existing entries.

See [agent file requests](design/agent-file-requests.md).

## R10. Prompt library and repository packages

- Manage reusable Markdown prompts with tags, search and ordered prompt packages.
- Store the library and repository assignments encrypted in the local owner store.
- Share assignments across a main Git repository and all its linked worktrees,
  using the existing repository identity rather than individual checkout paths.
- Inherit prompts during workspace creation, allow an explicit override, and
  preview anonymized prompt content before approval and injection.
- Include the selected instructions in the cloak's agent guidance while keeping
  generated prompts out of source Push and export. Existing workspaces retain
  their selected prompt versions when library entries change.

Proposed design: [prompt library](design/prompt-library.md).

## Out of scope (for now)

- Reading v1 workspaces (`.repo-cloak-map.json`). v2 is a fresh start.
- Merging conflicting changes during push (designed so it can be added later).
- Syncing profiles between machines.
- Remote or shared servers.
