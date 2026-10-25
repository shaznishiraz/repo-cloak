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
dashboard on that context. A new source is registered automatically. Outside Git,
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

The dashboard includes workspace status/history, workspace deletion, theme
switching, and encrypted repository-wide exclusions. Exclusions apply regardless
of profile, disappear from the file picker, and block both Pull and Push.

**Export diff** opens a three-pane commit/file/diff review. Select one or multiple
source commits, check affected files, and copy an anonymized patch in commit order.
An explicit export-only toggle can include repository-excluded files. Pull/Push
exclusions are unaffected. Binary contents are omitted from exported patches.

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
