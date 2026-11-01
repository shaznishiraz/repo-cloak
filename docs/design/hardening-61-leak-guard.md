# Hardening 61: leak guard

Home's leak guard only compares cloak text with ledger values, and New cloak's leftover
warning only looks for words from the repository's own name. A name no rule ever knew,
such as `ch-prod-sql01`, passes both. This adds a heuristic scan that looks for the _shape_
of proprietary names.

It is a warning aid. It finds likely leftovers; finding nothing proves nothing, and the
screens say so.

```
 home.ts  GET /workspaces/:repoId/:id        new.ts  POST /new/review, /new/create
   workspace files, as they are now            anonymized text, what the pull would write
        |                                           |
        +------------------+------------------------+
                           v
           server-v2/leak-guard.ts   (I/O: git remote, author emails; failures give less
                           |          identity, never a failed request)
                           v
           core/leak-scan.ts  (pure; the clock is passed in)
             leakIdentity(remote, paths, authors) -> { terms, domains }
             scanForLeaks(documents, { identity, masks, now, limits }) -> LeakScan
                           |
        +------------------+------------------------+
        v                                           v
 GuardCheck 'leak-heuristics'                NewCloakReview.leftovers + .leakScan
   state warning | info, plus findings[]       same Ignore gate as other leftovers
        |                                           |
        v                                           v
 Home guard panel                            New cloak review aside

 Never reached by findings: audit log, agent/MCP responses, operation summaries and
 warnings, error messages (a count only), anything written to the cloak workspace.
```

## Key types

```ts
type LeakKind = 'identity' | 'server' | 'domain' | 'email' | 'connection' | 'url';
type LeakFinding = { path: string; name: string; kind: LeakKind }; // name is at most 80 chars
type LeakDocument = { path: string; texts: string[] }; // a cloaked path and its text
type LeakScan = {
  findings: LeakFinding[];
  filesScanned: number;
  filesTotal: number;
  partial: boolean; // any limit was hit, so more could be there
};
```

`contracts.ts` gets its own copies, because it stays free of imports from the server side:
`LeakFinding`, an optional `GuardCheck.findings`, an optional `leftovers[].kind` and an
optional `NewCloakReview.leakScan`.

## What is flagged

| Kind         | Shape                                                               | Reported as                |
| ------------ | ------------------------------------------------------------------- | -------------------------- |
| `connection` | `Server=x;Database=y`, `postgres://`, `jdbc:sqlserver://`           | `Server=x`, `postgres://x` |
| `url`        | web, git and storage URLs on a host not on the public list          | `https://host`             |
| `email`      | an address at a domain not on the public list                       | the address                |
| `domain`     | `*.internal .corp .local .lan .intranet`; bare `.com .net .org .io` | the name                   |
| `server`     | `ch-prod-sql01`, `db01`, `acme-prod-db`, `app-uat-02`               | the token                  |
| `identity`   | remote org/repo, path segments, author and remote domains           | the whole token            |

Reported names never hold URL credentials, paths or queries, or the other fields of a
connection string, so a password in one is not repeated on screen.

## Keeping false positives low

- Public hosts: `localhost`, loopback, reserved names (`example.com`, `*.test`, `*.invalid`),
  package registries and well-known public sites. Cloud suffixes such as `*.amazonaws.com`
  and `*.windows.net` are deliberately not listed, because the customer name is in the host.
- Replaced values are blanked first, whatever their case, so `Northwind-prod-sql01` from a
  rule is not flagged, while `foo.Zed.acme.com` still reports `acme.com`.
- Code shapes: `this.net`, `.env.local`, `com.acme.internal`, `--web-prod-01`, `#db01`, UUIDs,
  `node-18`, `mysql8`, `dev-server`, `pkg@1.2.3`, and placeholders such as `${DB_HOST}`.
- Identity words use whole words only: `health` from `acme-health` is not flagged, nor is
  `macmeal` for `acme`. A repository's first distinctive word and whole name are the terms.

Bare country-code domains (`acme.se`) and bare private IP addresses are not flagged because
they look too much like code and version numbers. They are found in a URL or email, and an
author's own domain is always found.

## Limits and failure behaviour

| Limit           | Default | When hit                                      |
| --------------- | ------- | --------------------------------------------- |
| files           | 2000    | the rest are unscanned, `partial`             |
| bytes per file  | 256 KiB | the rest of that file is unscanned, `partial` |
| bytes in total  | 16 MiB  | the rest are unscanned, `partial`             |
| characters/line | 4000    | the rest of that line is unscanned, `partial` |
| findings        | 200     | scan stops, `partial`                         |
| time            | 1 s     | checked between files; scan stops, `partial`  |

- A partial scan says so on both screens, with the number of files covered.
- Git failing (no remote, empty history) only means fewer identity terms.
- The scan runs inside the existing guard or review; an exception from it is not expected,
  and Home's existing catch turns any failure into a blocked guard rather than a false clean.
- Binary files only have their path scanned.
- Home loads the detail when the workspace changes rather than on each poll, so no cache. The
  guard panel says "checked on load", and a file edited without the overview changing shows up
  on the next load.

## Decisions

- **New cloak requires an acknowledgement.** Findings join `leftovers`, so Create stays blocked
  until the user clicks Ignore or adds a rule. A name cannot be recalled once it reaches an
  agent, so this is the safer choice, and it is one click. To make it advisory, stop adding
  scan findings to the check in `createOperation` and the `blocker` in `screens/new/index.tsx`.
- **Home only warns.** The heuristic guard never blocks; the ledger guard still does.
- **No separate dismiss.** New cloak already has Ignore and an Add rule link. A lasting dismiss
  on Home would have to store real names, so it is left out.
- **Adding to an existing cloak** still hides leftovers, as it did: the review runs with the
  selected profiles, not the ones the cloak keeps. Home's guard covers those files once added.
