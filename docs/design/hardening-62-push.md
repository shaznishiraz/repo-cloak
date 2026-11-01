# Hardening 62: push

Hardens the Push review path: module split, crash safety, sealed backups, per-file push, a
post-check command, and server-enforced acknowledgements. Screens and routes as in
[Rebuilt screens](web-ui.md#rebuilt-screens).

## Modules

```
server-v2/push.ts            routes only: zod, ids, pushRoutes
server-v2/push/
  state.ts                   Pending reviews per dashboard, shared types
  diff.ts                    line diff, masking, side-by-side rows
  inspect.ts                 read one workspace, find the verified baseline
  merge.ts                   three-way merge plan and notes
  review.ts                  guard checks, opens the operation
  backup-parts.ts            sealed parts, on-disk layout, manifest copies
  backups.ts                 reading backups, retention, legacy sealing, undo
  journal.ts                 one push's backup session and write-ahead journal
  recovery.ts                recover interrupted pushes on the next run
  apply.ts                   run one push: write, stage/commit, re-pull, members
  post-check.ts              post-check routes' logic: config, one run per dashboard
adapters/post-check.ts       spawn with clean env, timeout, captured output
core/push.ts                 planPush gains `only`
core/push-recovery.ts        classifyInterrupted: pure state decision
```

## One atomic step plus a write-ahead journal

Before: engine write, then a second locked write for merge output. A crash between them left
"your version" over the upstream edits, and an unfinished backup nothing would ever undo.

Now merged bytes are part of the plan the engine writes, so there is no second write. The source
writer already rolls back on an ordinary I/O failure. A process crash skips that rollback, so a
journal is written under the same locks just before the first file changes.

```
review  ── recoverInterrupted ── plan ── merges (in memory)
apply   ── select(paths, merged, beforeWrite)
             |
source-writer, holding workspace + commonDir locks
  recheck ─ checkpoint ─ beforeWrite ─┬─ sealed pre-images  <id>/f0.json ...
                                      ├─ sealed manifest    <id>/manifest.json
                                      └─ sealed journal     <id>/journal.json   <- commit point
  unlink deletes ─ write files (merged included) ─ write manifest ─ workspace commit
             |
stage/commit ─ re-pull ─ index.json written, journal removed   <- journal's end
```

### Recovery

`recoverInterrupted` runs first in review and undo, and `runPush` refuses while a journal exists.
It does work only when a `journal.json` exists, inside `operations.exclusive` and both locks, so it
cannot race a live push. The backups list skips journalled directories; the screen reloads the list
when a review reports a recovery. (Not in the list route too: the screen loads both at once, and
the loser would see "busy" and block a review for no reason.)

`classifyInterrupted` compares current hashes with those the journal recorded:

```
manifest      files                        decision    action
------------  ---------------------------  ----------  ------------------------------------------
= after       any                          landed      finish backup, undo offered, report
neither       all = after                  landed      same; a later pull moved the manifest
= before      all = before                 nothing     drop journal and copies
= before      each = before or after       partial     restore pre-images, cloak edits pend again
otherwise     something else changed       foreign     touch nothing, keep copies as a backup
```

- `after` for a merged file is the merged hash, so "your version without upstream" cannot be
  reported as landed.
- A new-worktree push has no pre-images: `landed` drops the journal; otherwise the source is
  untouched and the report names the leftover worktree to remove by hand.
- Every outcome removes `.cloak-*.tmp` beside the journal's targets: a real SIGKILL strands
  `writeAtomic`'s temporary, which holds real bytes, in the source folder.
- `landed` unstages paths that a crash between `git add` and `git commit` left in the workspace
  index, because the next sync would otherwise refuse them.
- Every outcome writes an audit event and a `recovery:<id>` guard check. The check stays on the
  review until the next push or undo in this process.
- If locks are held, because a push is live or a dead process's lock is not stale yet (10s), the
  review is blocked with a check saying so.
- An unreadable journal, whether damaged or under a lost key, is renamed `journal.unreadable`,
  reported, and expires with the directory. It does not block pushing forever. A key that cannot
  be loaded at all fails the request and renames nothing.
- If rollback fails during an ordinary error (`AggregateError`), the journal is kept so the next
  run decides.
- Undo is restartable: a file may be at `after` or already at `before`, and the same for the
  manifest. The backup directory goes last.

Not covered: power loss. `writeAtomic` fsyncs files but not directories, here and throughout the
engine. Home bulk push and the CLI do not run recovery. They go through the same conflict rules,
so an interrupted state looks like a moved source and never overwrites silently; the next Push
review classifies it.

## Sealed backups

```
<git common dir>/repo-cloak-backups/<sha of workspace id>/<backup uuid>/
  index.json     { kind: 'push-backup', backupId, part: 'index',   sealed }   finished backup
  journal.json   { kind: 'push-backup', backupId, part: 'journal', sealed }   push in flight
  manifest.json  { ...                  part: 'manifest',  sealed: {data} }
  f<N>.json      { ...                  part: 'f<N>',      sealed: {data} }   data is base64
```

- `store.sealer()` / `store.opener()`, AES-256-GCM. `{kind, backupId, part}` is the AAD, so a part
  cannot be swapped between backups or renamed. Paths, root and timestamps are inside the seal.
- Key rotation: the envelope has the shape `rotateStoreKey` reseals. Its scan gains these files for
  each registered repo, so undo survives a rotation. A manifest's bytes change with each seal and
  rotation reseals it, so a backup stores the manifest opened, inside its own seal, compares
  manifests by what they say (`manifestFingerprint`), and seals the copy under the current key on
  undo. A damaged part stops a rotation with its path, like any other unreadable sealed file.
- Plaintext backups from before this change: the first read seals the parts, commits by rewriting
  `index.json`, then deletes the plaintext. A crash at any point is redone or cleaned up by the
  next read.
- Retention, applied on every read and before a push: expiry at 7 days; at most 20 backups and
  256 MiB per workspace, oldest first, always keeping the newest. Directories of other workspaces,
  including deleted ones, go by directory mtime after 7 days.

## Per-file push

```ts
// core
planPush(previous, workspace, source, { ...options, only?: ReadonlySet<cloakedPath> })
// application: a prepared restore can narrow itself without reading anything again
type PushSelection = {
  paths?: string[];                   // cloaked; undefined = every pending file
  merged?: Map<string, Uint8Array>;   // restored path -> merge output
  beforeWrite?(manifest, plan): Promise<void>;
};
PreparedOperation.select?(selection): PreparedOperation
```

- `only` skips an unselected path before anything is recorded, so its manifest entries stay at the
  old baseline: still `modified`/`deleted`, or still untracked if `added`. The ledger is not
  touched by a push at all.
- In a new worktree (`fullSnapshot`) files unchanged in the cloak are still written; selection
  applies to pending changes only.
- The workspace checkpoint commit leaves out unselected paths.
- The bytes written are the bytes reviewed. `select` re-plans from the files held since review, and
  the existing recheck under the locks refuses if anything moved, unselected files included.
- A refused apply keeps the full review: selection is passed to `operations.apply` and only takes
  effect once the acknowledgements pass.
- A re-pull after a subset push is safe by `planPull`'s existing rule: a cloak-edited file with an
  unchanged source is skipped, and if both changed the re-pull refuses, leaving a warning.
- A file that cannot be restored still blocks the whole review, as before: the engine plans the
  full set at review time.

## Acknowledgements

Found: `apply` passed `{ deletions: true, force: true }` unconditionally, and because the review
always plans with `policy: 'force'`, `summary.forced` was always true. The dialogs were the only
check, and `POST /api/v2/operations/:id/apply` could apply a review with default options.

```ts
PushApply += { paths?: string[]; confirmDeletes?: string[]; confirmOverwrites?: string[] }
```

- `confirmDeletes` must equal the restored paths this selection deletes.
  `confirmOverwrites` must equal the selected moved files when `mergeMode` is `overwrite`. A
  blanket "yes" or a stale list is refused with nothing written.
- The narrowed summary drives the shared check in `ui-operations`: `forced` is true only for a real
  overwrite. Merging keeps both sides, so it needs no force.
- Review operations get `owner: 'push-review'`, so the generic operations route cannot apply them.
- A selected file that needs a merge which cannot be made is refused in merge mode, before any
  write. Unselected overlaps do not block.
- Verified, unchanged: Home `applyRun` and group `apply` check per-member acknowledgements; group
  members in a push use `policy: 'block'` and skip anything that deletes.

## Post-check

```
PUT  .../post-check       save { command | null, timeoutSeconds }   sealed in the repo record
GET  .../post-check       { command, timeoutSeconds, canRun, run }
POST .../post-check/run   { confirmed: true, command }  -> run in background, poll with GET

click "Run post-check" -> dialog names the command and says it runs agent-edited code -> POST
```

- Run only by that route: `confirmed` must be literally `true`, `command` must equal what is
  configured (what the dialog showed), and this process must have completed a push for this
  workspace that was not undone since. Nothing else calls it. Cloak files are never consulted.
- `cwd` is that push's destination, rechecked as a current worktree of the repo.
- Environment is an allowlist (PATH, HOME, USER, locale, temp, Windows system variables). So no
  session token, `GIT_*`, or other inherited secrets. Toolchain variables such as `JAVA_HOME` must
  be set in the command itself.
- Not a sandbox. It runs as the user, so agent-edited code can read anything the user can,
  including a file-based store key. The dialog says so.
- Own process group; timeout (default 600s, 1-3600) sends SIGTERM, then SIGKILL after 5s. stdin is
  closed. Output is the last 256 KiB, with ledger secrets masked as in diffs, in memory only.
- Audit: `op: 'push'`, outcome, and a detail of `Post-check passed`, `failed (exit N)` or
  `timed out`. Neither output nor command.
- One run per dashboard at a time. It takes no sync lock, because a build can outlast anything
  reasonable to block on.

## Failure behaviour

| Failure                               | Result                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| Source changed after review           | `stale`, nothing written, no backup left                |
| I/O failure during the write          | writer rolls back, backup dropped                       |
| Rollback fails too                    | error names recovery copies, journal kept for next run  |
| Crash before journal                  | nothing changed; incomplete directory expires           |
| Crash during the write                | next review rolls back, or reports if files moved on    |
| Crash after the write                 | next review offers undo; reports staging may be missing |
| Store record update fails after write | error reported, undo still available                    |
| Stage or commit fails                 | warning, files stay pushed (unchanged)                  |
| Backup part tampered or key lost      | undo refused or not listed, nothing written             |
| Missing or stale acknowledgement      | refused, review stays open                              |
| Post-check fails or times out         | shown with output, audited; the push stays              |
