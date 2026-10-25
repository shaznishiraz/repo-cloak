# repo-cloak

Select files from a private Git repository, anonymize names and secrets in a
separate workspace, then restore changes with the original names intact.

repo-cloak is a local dashboard with a small launcher. Both `repo-cloak` and
`cloak` open the same application. Published package name: **repo-cloak-cli**.

> **Upgrading from v1:** restore changes from every v1 workspace with your v1
> installation before upgrading. v2 cannot restore v1 workspaces. Create fresh
> workspaces afterward. `archive/` contains v1 for reference only.

## Install and launch

Requires Git and Node.js 22.13+ on the 22.x line, or 23.5+.
Supports macOS, Windows, and Linux.

For this unreleased checkout:

```bash
npm ci
npm run build
npm link
cd /path/to/your/source-repository
repo-cloak
```

Without linking, run `node /path/to/repo-cloak/dist/cli.js`.
Once v2 is published, install with `npm install -g repo-cloak-cli@2`.

The launcher detects your exact source worktree or cloak workspace and opens the
dashboard on that context. A source worktree without its own available cloak
workspace opens the file picker and setup automatically, even if other worktrees
already have workspaces. A new source is registered automatically. Outside Git,
use **Add source repository** in the dashboard to select an existing Git folder.

```bash
repo-cloak --port 4321
repo-cloak --no-open
repo-cloak --help
repo-cloak --version
```

`repo-cloak ui` remains a launcher alias. Terminal sync, profile, status,
workspaces, and schema subcommands have been removed; manage those workflows in
the dashboard. The launcher does not require an interactive terminal.

## Create and use a workspace

1. Select files from the searchable nested checklist, working changes, commits,
   or a combination. Browse older commits or find a SHA, branch, or tag.
2. Select reusable global and repository profiles. Create/edit profiles through
   forms or JSON; import a JSON file or export a validated profile locally.
3. Choose a destination folder and optional post-create commands. Save defaults
   for future workspaces.
4. Review the plan and create the anonymized workspace. Post-create commands run
   once after creation; failures leave the created workspace available.
5. Use **Pull files** to refresh source changes into the cloak workspace, and
   **Push changes** to restore workspace edits into the source repository.

Quick sync opens review when deletions, changed profiles, or conflicts need
attention. Conflicts block writes unless you explicitly choose skip or force.
The restore review also supports a new branch/worktree with an optional base
reference and target directory. Restored source changes remain uncommitted.

Every cloak workspace is a standalone Git repository. Each successful Pull and
Push creates a local checkpoint of the affected cloak files and encrypted
`.repo-cloak/manifest.json`; local credentials and generated agent helpers are
excluded. Legacy workspaces initialize Git on their next sync. Use Git history
to restore files and their matching manifest together in the same workspace.
See [workspace history](docs/design/workspace-history.md).

The dashboard includes workspace status/history, workspace deletion, theme
switching, and encrypted repository-wide exclusions. Exclusions apply regardless
of profile, disappear from the file picker, and block both Pull and Push.

**Export diff** opens a three-pane commit/file/diff review. Select one or multiple
source commits, check affected files, and copy an anonymized patch in commit order.
An explicit export-only toggle can include repository-excluded files. Pull/Push
exclusions are unaffected. Binary contents are omitted from exported patches.

**Repository groups** keep related backend/frontend workspaces together. Use the
folder icon beside Repositories to create a group, or **Add to group** from a
repository to join an existing one. Create a cloak workspace first if needed;
groups can start with one member and grow to eight. Choose each member's exact
workspace and source worktree. The group view has **Pull all / Push all** and
individual Pull/Push controls, with separate profiles, exclusions and history.
Combined sync previews every member before writing and requests any needed
confirmations. If a member fails, completed members stay synced and **Retry
unfinished** prepares only the remaining members. Removing a group preserves
all repository and workspace files.

New dashboard groups **move the selected cloak workspaces** into one real folder.
Each member keeps its workspace ID, credentials, pending requests, profiles,
mappings, edits and Git history. There is one workspace per member. Existing
logical groups can use **Create group folder**, or **Edit group → Save group**.
Moves require a destination on the same filesystem; failed saves restore the
original locations. Old duplicates from earlier versions are kept for review.
Use the **Open** menu to reveal the folder in Finder/Explorer or open it in
VS Code or Zed. Workspace cards have the same menu. Start your agent in the group
folder; root instructions and scoped MCP connections cover its members.
**Open → Add to Orca** registers that cloak or group folder using
`orca repo add --path /absolute/path --json`. Orca must be installed and running.
Its current CLI does not offer repository group/archive placement.

Hover a repository in the sidebar to reveal **Remove repository** (always visible
on touch devices). Removal takes it out of the dashboard and groups while keeping
its files, profiles, exclusions and workspace links. Add the source again, or run
`repo-cloak` from it, to restore its saved setup.

New workspaces can use a custom **Workspace name** or keep the automatic neutral
name. Multiple workspaces for the same source/worktree remain supported. Every
creation installs `AGENTS.md` / `CLAUDE.md` guidance and a repo-cloak skill,
preserving selected original instructions and stripping the added block on Push.

**Requests** lets agents probe exact anonymized paths and queue missing files.
You select files, preview, then **Approve & pull**; agents cannot approve or
trigger sync. Queues are encrypted locally. Requests inherit the workspace's
selected profile exclusions (global or repository scoped) and repository-wide
exclusions, with no separate request policy to manage. Exclusions are checked
again at approval. Requests accept text files up to 1 MiB each.

Under **Requests → Connection**, enable/disable or rotate scoped access, copy MCP
configuration, or add it directly to [Codex's project configuration](https://developers.openai.com/codex/mcp/)
or [Claude Code's local scope](https://code.claude.com/docs/en/mcp). Existing entries
are preserved. Trust/reload the client to load the new tools. Local `.codex/`
settings and credentials never sync back to source. Existing workspaces install
guidance with their next Pull. MCP tools can probe, request and poll; approval
always stays in the dashboard. HTTP usage works without MCP setup.

The broker restricts API access; it does not sandbox an agent with unrestricted
filesystem permissions. Approved workspace files can be sent to the chosen
agent's model provider during normal use.

File-tree discovery uses Git's fresh path inventory and respects Git ignore rules
by default. Turning off Git ignore does not bypass repo-cloak exclusions. Files
are loaded for syncing or diff preview when requested; there is no persistent
file-tree cache.

## Local operation and storage

The dashboard binds to `127.0.0.1` and requires a session token. A second launcher
invocation reuses the running server. Press Ctrl+C in its original terminal to
stop it. After rebuilding backend changes, restart that server; refreshing only
reloads frontend assets.

File discovery, anonymization, and sync stay on your machine. They do not upload
code to an AI service or run a remote Git push. User-configured post-create shell
commands can access the network.

Profiles, original paths, repository records, and replacement ledgers use
AES-256-GCM encryption with a local key at `~/.repo-cloak/key`. Keep the private
store and key backed up; losing the key prevents restoration. This is application
encryption with user-only file permissions, not native Keychain/DPAPI integration.
Profile JSON downloads are intentionally decrypted.

Git/tool metadata and common generated/dependency files are skipped by default.
Profiles can add `.gitignore`-style includes and excludes; repository-wide
exclusions always win during sync. Binary files are copied unchanged during sync
and reported. External symlinks, submodules, and nested repositories are skipped
on extraction; restore rejects unsafe paths. Normal write failures roll back
files; a process or power failure is not an atomic multi-file transaction.

JSON Schemas ship under `schemas/` and the dashboard uses the same validators as
the sync engine. Existing v2 stores and workspaces remain compatible.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:package
```

Shared orchestration lives in `src/application/`, pure logic in `src/core/`,
filesystem/Git/server I/O in `src/adapters/`, and browser assets in `src/ui/`.
See [design](docs/design/dashboard-first.md), [plan](docs/plan.md), and
[testing](docs/testing.md). Browser regression tooling is in `e2e/` and has its
own locked dependencies. `npm run dev` rebuilds changes; backend changes require
a server restart.

## License

MIT
