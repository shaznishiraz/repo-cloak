# Hardening 63: profiles

Bounds user regexes, adds `profile@2` (`extends`, `allowRoots`), splits the scanner out of
`server-v2/profiles.ts` and keeps exclusion presets in one module.

## User regexes

```
 save / validate / pull                       every anonymize
 -----------------------                      ----------------
 validateProfile (strict)                     core/replacer + core/dynamic
   readProfile  (shape, ids, conflicts)         |  regex rules only; built-in secret
   regexSafetyProblem  <- core/regex-safety     |  detectors stay in-process
   profile@2 field checks                       v
        |                                     RegexEngine (core/regex-engine.ts)
        | rejects (a+)+$ with a named rule      |  default: direct, used by pure core tests
        v                                       |  installed by createSyncServices:
 store, merge, /check, pull                     v
                                              adapters/regex-worker.ts
 readProfile (lenient) is what the store         |
 lists with, so a saved profile that now         +-- blocking: Atomics.wait, runMs per run,
 fails still opens and can be fixed.             |   sessionMs per replacer (pull, review)
                                                 +-- async: scans and the preview tester;
 createReplacer never applies the safety            the event loop keeps serving
 check: restoring runs no user regex, and           worker.terminate() on timeout
 a sealed manifest must keep restoring.
```

### Static check

`regexSafetyProblem(source, flags)` parses the pattern into a small tree, with no I/O. A
quantifier counts as a loop when it has no upper bound or its bound is at least 100.

| Rule     | Rejects                                                            | Example                |
| -------- | ------------------------------------------------------------------ | ---------------------- |
| Nested   | A loop whose body holds another loop                               | `(a+)+$` `(\w+\.)+`    |
| Overlap  | In a loop, a variable-width item that can run into what follows it | `(a?a)+` `(a{1,3})+`   |
| Overlap  | In a loop, alternatives that can start with the same character     | `(a\|ab)*` `(\w\|\d)+` |
| Adjacent | Two loops in a row (optional items between) sharing characters     | `\d+\d*` `.*.*`        |
| Size     | Over 2,000 characters or nested over 64 groups deep                |                        |

The nested rule is deliberately stricter than necessary: `(\w+\.)+` is safe but rejected.
The check cannot be complete. `^(.*?,){11}P` passes and is polynomial of a high degree,
which is why the worker exists. Anything the parser cannot follow is rejected.

### Worker

The worker is an inline CommonJS string (`eval: true`) with no imports, so it runs the same
from `tsup` output and under Vitest. It only runs `matchAll`; core receives plain captures.

Core stays synchronous, so most callers use the blocking mode: the main thread parks in
`Atomics.wait` while the worker runs the regex. A run stalls the server for at most `runMs`
(2 s) and the first timeout ends the job. `sessionMs` (60 s) caps the total per replacer.
Scans and the tester get off-thread matches first (`createRegexScan`), then hand them to
the synchronous replacer, so those requests do not block the event loop for a regex.
Hit counting also has a 10 s deadline per scan.

| Where a user regex can run                     | Bound                                 |
| ---------------------------------------------- | ------------------------------------- |
| `POST /profiles/test`, hit counting            | async worker, `runMs`, scan deadline  |
| Pull, refresh, `/new/review`, repo folder name | blocking worker, `runMs`, `sessionMs` |
| Commit export, commit file list, agent preview | blocking worker, `runMs`, `sessionMs` |
| Agent file probe (`anonymizePaths`)            | blocking worker, `runMs`, `sessionMs` |
| `new RegExp` in validation and `compileScope`  | compiled, never executed              |
| Restore, push, `status`                        | run no user regex                     |

Not user regexes, so not moved: built-in secret detectors and the Minimatch globs from
`exclude`/`include`, which only ever see repository paths.

### Failure behaviour

| Case                                     | Result                                                 |
| ---------------------------------------- | ------------------------------------------------------ |
| Save or validate an unsafe regex         | 400 or a problem at `rules.N.match`, naming the reason |
| Saved profile that now fails             | Listed with `problem`; opens; hits show the reason     |
| Pull, review, `/check` with that profile | Error naming profile and rule; nothing written         |
| Cloak whose manifest holds that rule     | Opens and restores; anonymizing runs under the worker  |
| Regex over `runMs`                       | `RegexLimitError` naming file and rule; job stops      |
| Timeout during hit counting              | Partial hits plus `hitsError`; never silently partial  |
| Worker cannot start                      | Same error path: the regex does not run in-process     |

## profile@2

```ts
{ kind: 'profile', schemaVersion: 1 | 2, name, rules, include?, exclude?,
  extends?: string[],     // "name", "global:name" or "repo:name"; at most 16
  allowRoots?: string[] } // "src/", "tests/api/"; at most 200
```

`schemaVersions.profile` is 2, and v1 reads without a migration. **A v1 document must never
be rewritten on read**: manifests record `hashJson(profile)`, so changing a byte would make
every existing cloak report changed profiles and lose ledger continuity. A golden hash test
pins this. `new.ts` keeps writing the reserved "Never pull" profile as v1 for the same
reason. The Profiles screen creates v2.

A v1 document holding `extends` or `allowRoots` could be stored before this change, because
profiles are loose objects. It stays readable, but strict validation refuses it until the
document says `schemaVersion: 2`, so the fields are never silently ignored.

### extends

```
 selected          expandProfiles(selected, available)         mergeProfiles
 [billing]   --->  [contoso, billing]  parents first,   --->   same conflict rules as
                   deduplicated                                selecting them by hand
```

- A global profile can extend global ones; a repo profile can extend global ones or its
  own repository's. A name matching both needs `global:` or `repo:`.
- Missing parent, ambiguous parent, cycle (including itself) and depth over 8 are errors.
- A child adds to its parents and cannot remove from them. A conflict is an error.
- The expanded list is what goes into the manifest, so editing a parent counts as a profile
  change. A v1 cloak expands to the same list, in the same order, with the same hashes.
- `mergeProfiles` refuses a list missing a parent, so a caller that forgets to expand fails
  instead of quietly dropping the parent's rules.
- Deleting or renaming a profile something extends returns 409.

### allowRoots

```
 path --> filterPaths (the choke point for every selection)
            metadata --> exclude --> repo exclude --> default skip --> allowRoots
      --> planPull throws on any file outside the roots (last check, core)
```

| Input                                           | Result                                     |
| ----------------------------------------------- | ------------------------------------------ |
| `allowRoots` absent                             | No restriction                             |
| `allowRoots: []`                                | Nothing is allowed                         |
| Several profiles declare roots                  | Allowed by **all** of them                 |
| A malformed root (`../x`, `*`, `.`, absolute)   | Refused on save; matches nothing if stored |
| A malformed path, `src/../x`, other letter case | Not allowed                                |
| Exact file request outside the roots            | Error naming the path                      |
| Folder or commit partly outside                 | Outside files are held back                |
| Tracked file later outside the roots            | Refresh fails naming the path              |
| New workspace file outside the roots, on push   | Not eligible, same as excluded             |

Roots match literally, so a case or Unicode spelling difference denies. Symlinks stay with
`readSourceFiles`, which already refuses targets outside the repository; a symlink inside a
root that points elsewhere in the repository is **not** blocked by `allowRoots`, and the
target's real path is not checked against the roots.

The per-repository `allowedRoots` in Known repos is a separate setting and still returns 501.

## Modules

| Module                               | Holds                                          |
| ------------------------------------ | ---------------------------------------------- |
| `core/regex-safety.ts`               | Static check                                   |
| `core/regex-engine.ts`               | `RegexEngine` type, default, installer         |
| `core/profile-graph.ts`              | `expandProfiles`, `allowRoots` matching        |
| `core/exclusion-presets.ts`          | One preset catalog, used by server and browser |
| `adapters/regex-worker.ts`           | Worker, blocking and async modes               |
| `adapters/server-v2/profile-scan.ts` | Scanner: hits, suggestions, cache              |
