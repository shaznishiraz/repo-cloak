# Hardening 60: sync engine

Closes two gaps listed under "Known gaps" in [plan.md](../plan.md#dashboard-rebuild-screens):
bulk group runs outside the group lock, and "Pull from commit" reading the worktree.

## 1. Bulk runs

`server-v2/home.ts` kept a second sequence beside the engine's batch. It never took the group
lock, so a group edit in another process could land mid-run. The engine's own `apply` took the
lock but released it as soon as the run was scheduled, because `operations.apply` returns before
the work finishes. There is now one sequence, in `application/dashboard-groups.ts`, and the lock
covers the run.

```
POST /groups/:id/bulk  (zod)                 home.ts: validate and map, no sequence of its own
   |
   v
groups.preview(id, { revision, intent, members?, stopOnGuardFailure?, commitMessage? })
   |  check revision, narrow to the member subset
   |  prepare each member through sync.prepareOperation
   |    stop rule on:  a member that cannot prepare rejects the preview
   |    stop rule off: it is marked unattempted and reported in warnings
   v
pending operation (owner: 'group')
   |
POST /group-operations/:id/apply
   |
   v
groups.apply  -- acknowledgements --> lock.acquire() --busy--> 409, stays pending, nothing written
                                         |
                                         v  held until the run settles
                     check revision, operations.apply (schedules the task, sets `running`)
                                         |
                     task:  revision, validate members, recheck every member
                              | any failure: all unattempted, nothing written
                              v
                            for each member:
                              lock still held?  no: this and later members unattempted
                              operation.apply()
                              commitPaths() when a commit message was given
                              failure: stop rule on  -> later members unattempted
                                       stop rule off -> carry on, report the count
                                         |
                     wait(id).finally(release)
```

### Key types

```ts
type Batch = {
  groupId: string;
  revision: string;
  intent: 'refresh' | 'restore';
  stopOnGuardFailure: boolean;
  commitMessage?: string;
  members: MemberState[];
};
type MemberState = GroupMember & {
  summary?: PreviewSummary; // absent when the member could not be prepared
  state: 'pending' | 'running' | 'completed' | 'failed' | 'unattempted';
  uncommitted?: string[]; // written by an attempt whose commit failed; a retry commits them
  error?: string;
};

// adapters/groups.ts
type GroupLock = { assertHeld(): void; release(): Promise<void> };
```

### Concurrency

| Race                                   | Result                                                 |
| -------------------------------------- | ------------------------------------------------------ |
| Group edit or delete during a run      | Same process: `busy` from `operations.exclusive`.      |
|                                        | Other process: `busy` once the lock retries run out.   |
| Second bulk apply during a run         | `busy`; it stays pending and writes nothing.           |
| Bulk apply during a group edit         | `busy`, from the lock or from `running`.               |
| Second bulk apply after a run          | Fails `stale` on the recheck; members are unattempted. |
| Group edited between preview and apply | `stale`; nothing written.                              |
| Group edited before a retry            | `stale`; the retry is refused rather than re-prepared. |
| Lock lost mid-run                      | Remaining members unattempted; the run fails.          |

Lock order is `running` then lock in `save`, and lock then `running` in `apply`. Neither waits
forever: `exclusive` fails at once and the lock gives up after its retries, so the worst case is
`busy`, not deadlock. `proper-lockfile` throws an uncaught error by default when a lock is
compromised, which would take the server down. A long hold makes that likelier, so `onCompromised`
records it for `assertHeld` instead.

Only group documents and bulk runs take this lock. Individual pulls and pushes are serialized
against a run by `running` in one process and by their workspace locks across processes.

### Commits

`git.commitPaths` uses `--literal-pathspecs`, so a file named `*.ts` cannot stage other files, and
`commit --only`, so what the user had staged stays out. Ignored files are skipped with a warning,
and a member whose paths match `HEAD` skips the commit rather than failing.

Bulk commits set `core.hooksPath` to the null device. A run holds the group lock and the sync
queue with no timeout, so a hanging hook would block every sync, and it would execute repository
code for each member from one click. This is one constant in `git.ts`. The trade-off is that
checks in hooks, such as a secret scanner, do not run for bulk commits, whereas a single push from
the push screen does run them.

### Failure behaviour

- Partial failure: earlier members stay written and committed. The failed member reports its
  error, and the run is `failed` with counts. Retry prepares only the unfinished members against
  the same revision and commits anything a failed commit left behind.
- A crash mid-run: the lock goes stale after 10 seconds and members already written stay written.
  Each member's own write is atomic under its workspace lock; the batch is not.

## 2. Pull from commit

`commits: [ref]` means "select the files this commit changed", and contents then came from the
worktree. That meaning stays for New cloak. Pull from commit is a new option, `fromCommit`, which
changes only where the bytes come from.

```
PullTarget { kind: 'commit', ref }
   |
   v
preparePull: resolve ref to a sha      unknown or not a commit: validation error
             refuse if profiles changed
             paths = git diff-tree of the sha  (the selection)
                  --> filterPaths              profile, repo and default exclusions, metadata
   |
   v
sync.ts readSource:
   fromCommit ? worktree.readCommitSource(repo, sha, paths)
              : files.readSourceFiles(repo, paths)         <-- the only difference
   |
   v
preparePullRun --> planPull                    replacer, secret redaction, binary, conflicts
   |
   v
preview bytes limit, recheck (re-reads the same blobs), sealed manifest, workspace writer, audit
```

| Entry in the commit          | Result                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| Regular file                 | Bytes from the blob; the executable bit comes from the mode. |
| Binary                       | Copied unchanged with a warning, as in a normal pull.        |
| Deleted, tracked in cloak    | Deleted from the cloak after the deletion acknowledgement.   |
| Deleted, edited in cloak     | Conflict; nothing is written.                                |
| Deleted, parent now a file   | Path is gone. A cloak folder in the way refuses the preview. |
| Symlink                      | Skipped with a warning. Nothing resolves it within a tree.   |
| Submodule                    | Skipped with a warning.                                      |
| Blob over 64 MB              | `limit` error before it is read.                             |
| Unknown ref, or not a commit | `validation` error from the preview.                         |

### What is recorded

```ts
// sealed manifest data
pulls: [{ id, commit: sha, branch, fromCommit: sha }];
```

`commit` is the sha, so source-moved counts and push baselines measure from what was actually
read. `origin` is left as it was, because the files this pull did not touch still come from there,
and push looks for a baseline in both. The plain manifest holds only `selection.commits: 1`, never
the sha. History gets an audit `detail` of `Pulled from commit <sha>`, without the subject, which
could hold a real name. The preview summary gains `sourceCommit`.

### Staleness

The sha is pinned at preview. Apply re-resolves the ref, so a branch that moved fails as `stale`,
as does a moved `HEAD`, because the plan records it. The worktree file inventory is not part of the
fingerprint for this pull: nothing is read from the worktree, so a build writing there must not
invalidate the review.

### Limits

- Blobs are read raw. Clean and smudge filters do not run, because they execute configured
  programs. An LFS file arrives as its pointer text, and a file with CRLF conversion has different
  bytes from the worktree, so a later push reports it as changed at the source.
- A pull with changed profiles is refused. It would re-read every tracked file from the commit and
  delete those the commit lacks, and the user asked for one commit's changes. Run a normal pull first.
- A file deleted by a commit pull is no longer tracked, so a later normal pull does not bring it back.
