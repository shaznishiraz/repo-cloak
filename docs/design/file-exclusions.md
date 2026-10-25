# Repository-wide file exclusions

```text
repo-cloak dashboard / CLI
  -> load registered repository's exclusions (sealed repo record)
  -> compile .gitignore-style patterns once per operation
  -> hide paths from tree and selection sources
  -> filter again before Pull planning
  -> filter anonymized workspace paths through their original-path manifest mapping
  -> omit excluded paths from Push reads and writes
```

The patterns belong to a source repository, not a workspace or profile, and apply
regardless of selected profiles. Store them in the existing encrypted
`~/.repo-cloak/repos/<repoId>/repo.json` record (`exclude: string[]`), using the
repo lock when updating it. This uses repo-cloak's AES-256-GCM sealed storage and
0600 key file; it is app-level encryption at rest, not native Keychain/DPAPI
integration.

Patterns follow the existing profile exclusion rules: repository-relative,
case-insensitive globs; `*.secret` matches any directory, `generated/` includes
its descendants, `/config.yml` anchors to the root. Negation and parent traversal
are invalid. Exclusions always win over profile includes and defaults.

All selection entry points share the matcher. Pull drops excluded source paths
before reading or planning. Push resolves tracked cloak paths to original source
paths from the sealed workspace manifest and resolves newly added paths through
the workspace ledger before reading/restoring. Excluded paths are omitted from
the push plan and its next manifest, so existing excluded source files are not
deleted. Existing workspace copies are left untouched on disk; they cannot be
pushed and are no longer tracked after a sync.
