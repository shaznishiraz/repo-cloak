# repo-cloak

Select files from a private repository, anonymize names and secrets in a separate
workspace, then restore changes with the original names intact.

This checkout contains **v2**, a ground-up rewrite. Both `repo-cloak` and `cloak`
run the same CLI.

> **Upgrading from v1:** use your existing v1 installation to push changes back
> from every v1 workspace before upgrading. v2 cannot restore v1 workspaces.
> Create fresh workspaces with v2 after restoring your old ones. The v1 source
> remains in [`archive/`](archive/) for reference.

## Requirements and installation

- macOS, Windows, or Linux
- Node.js 22.13 or later in the 22.x series, or Node.js 23.5 or later
- Git on your PATH

For this unreleased checkout, build and link locally:

```bash
npm ci
npm run build
npm link
repo-cloak --help
```

Without linking, use `node dist/cli.js` instead of `repo-cloak`.
Once v2 is published, install it with `npm install -g repo-cloak-cli@2`.

## Start with the guided CLI

From your source repository:

```bash
repo-cloak
```

The menu guides you through profiles, file selection, destination, and a preview.
In an existing workspace, it offers refresh, restore, status, and the dashboard.
Selection can combine files, recent commits, working changes, and extra paths.

## Use explicit commands

Create a profile from your source repository:

```bash
repo-cloak profile create company
```

This opens a validated JSON editor. A minimal profile looks like this:

```json
{
  "kind": "profile",
  "schemaVersion": 1,
  "name": "company",
  "rules": [
    {
      "id": "company-name",
      "type": "literal",
      "match": "Acme",
      "replace": "Northwind"
    }
  ]
}
```

You can also save that JSON to a file and import it with
`repo-cloak profile import company.json`. Profiles default to the current repo;
use `--global` to share one across repositories. Literal rules handle name
variants and paths. Regex and built-in secret detectors are also supported.

Preview and create a workspace:

```bash
repo-cloak push --profile repo:company --files src README.md --to ../cloak-work --dry-run
repo-cloak push --profile repo:company --files src README.md --to ../cloak-work --yes
```

Make changes inside `../cloak-work`, then inspect and restore them:

```bash
cd ../cloak-work
repo-cloak status
repo-cloak push --dry-run
repo-cloak push
```

Restore checks every affected file before writing. Source changes cause a
conflict and exit code 2. Review conflicts before choosing `--skip-conflicts`
or `--force`. Deletions require confirmation; `--yes` accepts them for scripts.
Restored changes remain uncommitted in the source repository.

### Direction depends on your location

| Run from          | `push`                                  | `pull`                                    |
| ----------------- | --------------------------------------- | ----------------------------------------- |
| Source repository | Anonymize source files into a workspace | Restore workspace changes into the source |
| Cloak workspace   | Restore changes into the source         | Refresh anonymized files from the source  |

With no selection flags, refresh uses the files and profiles recorded in the
workspace. If both sides changed the same tracked file, refresh stops with a
conflict. Use `repo-cloak workspaces` in the source to list linked workspaces.
Choose one explicitly with `push --to <workspace>` or `pull --from <workspace>`.

### Restore into a feature worktree

From a cloak workspace:

```bash
repo-cloak push --new-worktree feature/review --dry-run
repo-cloak push --new-worktree feature/review --path ../review --yes
```

The new branch defaults to the commit used during extraction. Override it with
`--base <ref>`. The full tracked workspace is restored, including captured
uncommitted source changes. Future restores and refreshes remember the target
branch, even if its Git worktree moves. To use an existing worktree, pass
`--worktree <path>` instead.

## Open the dashboard

```bash
repo-cloak ui
repo-cloak ui --port 4321
repo-cloak ui --no-open
```

One dashboard manages all registered repositories and workspaces on your machine.
It shows status and pull history, and provides profile forms, a JSON editor, and
profile conflict checks. File extraction and restore stay in the CLI.

The server binds only to `127.0.0.1`, prints an authenticated URL, and normally
opens your browser. A second invocation reuses the running dashboard. Press
Ctrl+C in the original terminal to stop it.

## Profiles, storage, and file handling

- Global and repo profiles can be combined using repeated `--profile` flags.
  Use `global:<name>` or `repo:<name>` when names overlap.
- Profile settings, original paths, and replacement pairs are encrypted using
  a machine-local key in `~/.repo-cloak/key`. Keep the key and machine store
  private and backed up; losing the key prevents restoration.
- Workspace manifests expose anonymized paths and baseline hashes. Original
  names and source details stay in the authenticated encrypted portion.
- Binary files and invalid UTF-8 are copied unchanged and reported as warnings.
  They can still contain proprietary information; exclude them when needed.
- Git/tool metadata, dependencies, common generated output, and lockfiles are
  excluded by default. Profiles can customize `include` and `exclude` globs.
- External symlinks, submodules, and nested repositories are skipped during
  extraction. Restore refuses unsafe paths and symlink destinations.
- Ordinary write failures roll back affected files. Process or power loss is
  not an atomic multi-file transaction.

Profiles support `list`, `show`, `create`, `edit`, `delete`, `export`, `import`,
and `check`. Show/export intentionally print decrypted profile JSON.

For scripts, use explicit commands with `--yes`, `--json`, or `--dry-run`.
Schemas are available with `repo-cloak schema profile` (also `repo`, `manifest`,
and `config`). Run `repo-cloak <command> --help` for command options.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:package  # after building
npm run dev
```

Tests cover the replacement engine, encrypted store, Git workflows, rollback,
CLI routing, and dashboard API. CI runs on macOS, Windows, and Linux with
Node.js 22 and 24. See [`docs/plan.md`](docs/plan.md) for progress and
[`docs/design/`](docs/design/) for the design. Coverage floors, important failure
scenarios, and the release gates are described in [`docs/testing.md`](docs/testing.md).

Dashboard browser automation: `npm ci --prefix e2e && npm run test:browser`.
See [testing requirements and coverage](docs/testing.md) for Node/WSL requirements
and the complete release checks.

Shell shortcuts: `./scripts/setup.sh` once, then `./scripts/test-all.sh` for
all checks. Use `./scripts/check.sh` or `./scripts/test-browser.sh` to run either
suite separately. On Windows use WSL; on Linux/WSL setup accepts `--with-deps`.

## License

MIT
