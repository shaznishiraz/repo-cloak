# Launcher

The terminal is an entry point to the local dashboard. Workflow design:
[dashboard-first](dashboard-first.md).

```text
repo-cloak / cloak [--port N] [--no-open]
  -> detect source / worktree / cloak workspace
  -> register source if needed
  -> start or reuse local dashboard -> open browser
```

- Bare invocation opens the dashboard without requiring a TTY.
- `ui` remains an equivalent launcher alias.
- `--port` accepts an integer from 1 through 65535; otherwise use a free port.
- `--no-open` prints the local session URL without opening a browser.
- `--help` and `--version` exit without creating a dashboard or touching storage.
- Removed workflow subcommands are rejected without running a sync.
- Launcher failures print a concise message and exit with status 1.
- Ctrl+C / SIGTERM stops the owned server and releases the local session lock.

The package remains `repo-cloak-cli` and both executable names are preserved.
No terminal profile/sync/status/schema commands or prompt adapters remain. Schemas
are shipped as files and served to the dashboard through the authenticated API.
