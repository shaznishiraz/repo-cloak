# Anonymizer

Status: **implemented**. Refines the replacement engine in
[overview.md](overview.md) and literal rules in [data-model.md](data-model.md).

## Problem

A name like `Microsoft` appears in code in many shapes, and sometimes inside
other words:

```
Microsoft            prose, comments
microsoft            package names, URLs        com.microsoft.graph
MICROSOFT            constants                  MICROSOFT_API_KEY
MicrosoftClient      PascalCase type            class MicrosoftClient
getMicrosoftToken    camelCase function
microsoft_graph      snake_case
microsoft-graph      kebab-case, npm packages
microsoftgraph       smushed lowercase          (ambiguous)
Microsofts / Microsoft's   plural, possessive
```

Multi-word names make it worse: `Acme Corp` can appear as `AcmeCorp`,
`acmeCorp`, `acme_corp`, `ACME_CORP`, `acme-corp`, `acmecorp`.

And some matches are wrong: a rule for `Ion` must not touch `Function`, and
`Acme` must not touch `Acmeology` (an unrelated word).

The anonymizer must catch every real use, skip false ones, and **restore every
replaced form exactly** on the way back, including names the agent writes new.

## Principle: predictable, not clever

The anonymizer never guesses from context. Every replacement follows from the
rule by fixed, mechanical steps (split words, render case styles, check
edges), so the same input always gives the same output, and the preview shows
all of it before anything is written. Where text is ambiguous, the rule says
what to do; repo-cloak does not decide.

It remembers in two places, both persistent:

| What                   | Where                         | Example                                                   |
| ---------------------- | ----------------------------- | --------------------------------------------------------- |
| What you asked for     | the profile's rules           | `Acme Corp -> Northwind Traders`, `except: ["Acmeology"]` |
| What actually happened | the workspace ledger (sealed) | `ACME_CORP -> NORTHWIND_TRADERS`, 40 times                |

Decisions made in the preview (skip this occurrence, also replace that one)
are saved back into the profile as `except` or `forms`, so the next run
already knows them.

### Common words need explicit styles

For a distinctive name (`Acme Corp`) every style is safe, so `styles` defaults
to `all`. For a word that is also ordinary English (`Meta`, `Apple`, `Square`),
lowercase uses are usually not the company. Such rules must list their styles
explicitly; the rule is refused until they do. Styles apply to how the word
itself is cased, wherever it sits, so a Title-cased `Meta` inside
`getMetaData` still counts as Title:

```json
{
  "id": "meta",
  "match": "Meta",
  "replace": "Northwind",
  "styles": ["title", "pascal", "upper"],
  "boundary": "token"
}
```

```
MetaClient   -> NorthwindClient     (pascal: listed)
META_TOKEN   -> NORTHWIND_TOKEN     (upper: listed)
metadata     -> unchanged           (lower: not listed)
metaTags     -> unchanged           (lower start: not listed)
getMetaData  -> getNorthwindData   (Title-cased "Meta" inside an identifier)
```

"Common word" is decided by a small built-in word list plus a length check,
and the rule can be marked `"common": false` to override it.

## Design

```
rule "Acme Corp" -> "Northwind Traders"
        |
        v  1. split into words           [acme, corp] -> [northwind, traders]
        |
        v  2. generate variants           AcmeCorp      -> NorthwindTraders
        |     (every case style x         acmeCorp      -> northwindTraders
        |      separator, both sides)     acme_corp     -> northwind_traders
        |                                 ACME_CORP     -> NORTHWIND_TRADERS
        |                                 acme-corp     -> northwind-traders
        |                                 Acme Corp     -> Northwind Traders
        |                                 acmecorp      -> northwindtraders
        |                                 ...
        v  3. compile ALL variants of ALL rules into one matcher
        |     (Aho-Corasick: one scan for all literal terms)
        |
file text --scan--> candidate matches --boundary check--> accepted / rejected
                                                              |
        4. replace accepted, longest match wins               |
        5. record each concrete pair in the ledger            |
        6. verify: restore(anonymize(file)) == file  ---------+--> abort if not
```

### 1. Words and case styles

A rule's `match` and `replace` are split into words, whatever form they were
typed in (`Acme Corp`, `AcmeCorp`, and `acme-corp` all give `[acme, corp]`).
Every variant renders the anonymized words in the **same style** as the
original form, so the mapping is one-to-one per style:

| Style     | Original    | Anonymized          |
| --------- | ----------- | ------------------- |
| lower     | `acme`      | `northwind`         |
| UPPER     | `ACME`      | `NORTHWIND`         |
| Title     | `Acme`      | `Northwind`         |
| Pascal    | `AcmeCorp`  | `NorthwindTraders`  |
| camel     | `acmeCorp`  | `northwindTraders`  |
| snake     | `acme_corp` | `northwind_traders` |
| SCREAMING | `ACME_CORP` | `NORTHWIND_TRADERS` |
| kebab     | `acme-corp` | `northwind-traders` |
| dot       | `acme.corp` | `northwind.traders` |
| spaced    | `Acme Corp` | `Northwind Traders` |
| smushed   | `acmecorp`  | `northwindtraders`  |

The style set is every combination of word casing (lower, UPPER, Title,
camel) and separator (none, `_`, `-`, `.`, space, `/`), so `Acme_Corp` and
`Acme-Corp` are covered too.

The word counts do not have to match (`Acme` -> `Northwind Traders` works),
but **equal word counts are recommended**. With one original word, `acme`
could be lower, camel, snake, or smushed, so the anonymized style has to be
picked by a fixed rule (smushed: `northwindtraders`). Restore is still exact.

Irregular casing (`MicroSoft`, `ACMEcorp`) is not a generated variant. Add it
as an explicit extra form on the rule (`forms`), and it gets an exact pair.

### 2. Boundaries: token-aware matching

Every candidate match is checked at both edges. The default mode, `token`,
understands identifiers:

```
                       left edge ok?          right edge ok?     result
getAcmeToken           t|A  lower->Upper hump  e|T  hump          match
ACME_API_KEY           start                   E|_  separator     match
com.acme.graph         .|a  separator          e|.  separator     match
Acmeology              start                   e|o  lower->lower  REJECT
myacmeclient           y|a  lower->lower       e|c  lower->lower  REJECT
Acme's / Acmes         start                   's / s suffix      match (suffix kept)
Function  (rule Ion)   t|i  lower->lower       end                REJECT
```

Rules for `token` mode:

- An edge is a boundary when the neighbour is not a letter or digit, or at a
  case hump (lower -> Upper), or at a letter/digit change.
- A lowercase letter touching a lowercase letter is **not** a boundary, which
  is what keeps `Acmeology` and `Function` safe.
- Allowed suffixes `s`, `es`, `'s` count as a boundary and stay unchanged.

Per-rule `boundary` option:

| Mode       | Matches                                  | Use for                           |
| ---------- | ---------------------------------------- | --------------------------------- |
| `token`    | Identifier-aware, as above (default)     | Almost everything                 |
| `word`     | Only between non-letter/digit characters | Short or common words             |
| `anywhere` | Any substring                            | Smushed names like `myacmeclient` |

Plus `except`: a list of words to always leave alone
(`"except": ["Acmeology"]`).

### 3. One matcher for everything

All variants of all literal rules go into **one Aho-Corasick automaton**
(case-sensitive, because the variants already cover the cases). One pass per
file finds every candidate in linear time, no matter how many rules there are.
At each position the **longest** match wins, so `AcmeCorp` beats `Acme`.

Regex and secret rules run as a second pass over the same text, on what the
literal pass did not replace.

### 4. Ledger and restore

Every accepted replacement records its exact pair (`ACME_CORP ->
NORTHWIND_TRADERS`). Restore builds the same kind of matcher from the
**anonymized** side:

- Forms that were replaced restore exactly from the ledger.
- Forms the agent writes new (`NorthwindTradersClient`, `NORTHWIND_TRADERS_V2`)
  are still variants of the anonymized words, so they restore to
  `AcmeCorpClient` and `ACME_CORP_V2`. Literal rules therefore restore new code
  too, not just what was pulled.

### 5. Verify before writing

After anonymizing each file, the engine immediately restores it in memory and
compares with the original. Any difference aborts the cloak and names the file
and position. This catches every ambiguity before it can break a later
restore, and costs one extra in-memory pass.

## Guarantees and edge cases

### What is guaranteed

Everything that was **pulled** round-trips exactly. The ledger records every
replacement, and the verify pass proves `restore(anonymize(file)) == file`
for every file before anything is written. A word inside a bigger word is
either replaced as a whole token (and restored exactly) or skipped (and left
untouched); either way the round trip is byte-for-byte.

### Where it can still go wrong

The risk is not pulled code; it is what changes in the workspace afterwards,
and what the workspace looks like to the agent.

| #   | Case                                      | Example                                                                          | Effect                                                                              | Handling                                                                     |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | **Weak replacement word**                 | `Acme` -> `Data`; agent writes `DataLoader` (a real library class)               | Restore turns it into `AcmeLoader`: **broken code**                                 | Warn on common words; codename suggestions; restore preview (below)          |
| 2   | **Third-party names contain the term**    | Rule `Microsoft`; code uses `Microsoft.Extensions.Logging`, `@microsoft/signalr` | Workspace no longer builds, so the agent cannot run tests. Restore is still correct | Detect imports and package names in the preview and suggest `except` entries |
| 3   | **Agent writes a form no rule generates** | `NORTHWINDtraders`                                                               | Not restored; the source gets an anonymized name                                    | Residue scan (below)                                                         |
| 4   | **Agent invents a secret placeholder**    | `REDACTED_AWS_ACCESS_KEY_7` with no ledger entry                                 | Cannot be restored                                                                  | Residue scan; restore stops                                                  |
| 5   | **Skipped part-words leak**               | `Acmeology` skipped                                                              | Not a break, but `Acme` is visible                                                  | Listed under "skipped" in the preview                                        |
| 6   | **Length or order changes**               | Sorted imports, fixed-width output, test snapshots, checksums of file contents   | Linters or snapshot tests fail in the workspace; restore is still exact             | Generated and snapshot files excluded by default                             |
| 7   | **Generic term also used generically**    | Company `Meta`; code has `getMetaData`                                           | Replaced as `getNorthwindData`; odd to read, round trip fine                        | Preview shows it; `except` or `boundary: "word"`                             |

### Safety nets on restore

```
workspace file --restore--> restored text
                                |
       1. restore preview:  new occurrences not in the ledger, per file
                            "NorthwindTradersClient -> AcmeCorpClient (new, 3x)"
                                |
       2. residue scan:     search restored text, case-insensitive, for any
                            anonymized word or placeholder still present
                            -> found? stop, name file and line
                                |
                                v
                            write (all or nothing)
```

- **Restore preview** lists every replacement that comes from new agent code
  rather than the ledger, so you can see exactly what is being turned back
  into proprietary names before it is written.
- **Residue scan** catches anything that slipped through (cases 3 and 4): if
  `northwind` in any casing, or a `REDACTED_` placeholder, would end up in the
  source, the restore stops.

Together with the verify pass on the way in, both directions have a check
before any file is written.

## Validation (on top of [overview.md](overview.md))

- **Variant collisions**: two rules whose variants produce the same string on
  either side (for example `Acme Corp` and `AcmeCorp` as separate rules) are
  rejected, naming both.
- **Anonymized value already in the source**, in any variant: refused with
  the files listed (restore would turn it into the original).
- **Weak anonymized names**: a common word (`Data`, `Client`) or very short
  value as `replace` is a warning, because restore would also catch the
  agent's ordinary uses of it. Distinctive codenames (`Northwind`) are safe.
- **Short or common `match` terms** (under 4 characters, or a dictionary word)
  are a warning suggesting `boundary: "word"`.

## Preview

Before writing, the preview shows per rule what matched and what was skipped,
so boundaries can be tuned with real data:

```
rule acme/company  "Acme Corp" -> "Northwind Traders"
  replaced  312  in 41 files   AcmeCorp (180)  acme_corp (64)  ACME_CORP (40) ...
  skipped     3                Acmeology (2)  src/legal/terms.md:14
                               myacmecorp (1) build/config.json:8
  hint      use "boundary": "anywhere" or add a form to also replace "myacmecorp"
```

## Rule shape (literal)

```json
{
  "id": "company",
  "type": "literal",
  "match": "Acme Corp",
  "replace": "Northwind Traders",
  "boundary": "token",
  "styles": "all",
  "forms": ["ACMEcorp"],
  "except": ["Acmeology"]
}
```

| Field      | Default | Meaning                                                 |
| ---------- | ------- | ------------------------------------------------------- |
| `boundary` | `token` | `token`, `word`, or `anywhere`                          |
| `styles`   | `all`   | `all`, or a list such as `["pascal", "camel", "snake"]` |
| `forms`    | `[]`    | Irregular forms to match exactly, each mapped by style  |
| `except`   | `[]`    | Words never replaced                                    |

This replaces `caseVariants` and `wholeWord` from the earlier draft.

## Paths

Paths go through the same engine, one segment at a time
(`src/AcmeCorp/acme-corp.config.ts` -> `src/NorthwindTraders/northwind-traders.config.ts`).
Extra checks for paths:

- two original paths that end up with the same anonymized path are rejected;
- on case-insensitive file systems (macOS, Windows default), paths that differ
  only by case are treated as the same path;
- replaced segments must still be valid file names on all three platforms.

## Key types

```ts
type CaseStyle =
  | 'lower'
  | 'upper'
  | 'title'
  | 'pascal'
  | 'camel'
  | 'snake'
  | 'screaming'
  | 'kebab'
  | 'dot'
  | 'spaced'
  | 'smushed';

type Boundary = 'token' | 'word' | 'anywhere';

interface Variant {
  ruleId: string;
  style: CaseStyle | 'form';
  original: string; // e.g. "ACME_CORP"
  anonymized: string; // e.g. "NORTHWIND_TRADERS"
}

interface Match {
  variant: Variant;
  start: number;
  end: number;
  accepted: boolean;
  reason?: 'boundary' | 'except' | 'overlap';
}
```

## Implementation contract

```
createReplacer(rules)             compile once; no filesystem access
  anonymize(text, context, ledger = [])
      -> { text, ledger, preview }   fresh result; input ledger is unchanged
  restore(text, ledger, context)
      -> { text, preview }           exact pairs first; new literal forms second

context = { file, scope: content | paths }
ledger entry = { ruleId, kind, scope, boundary, original, anonymized }

anonymizePaths / restorePaths     validate each segment, check all collisions
      -> { paths: [{ original, anonymized }], ledger, preview }
```

- Use `ahocorasick` for the compiled matcher and Lodash `words` for Unicode
  word splitting. This replaces the earlier custom-matcher plan, following
  the preference for established libraries. Boundary rules, ledgers, and
  validation remain small domain-specific modules.
- Match literal names through an NFC view, with offsets back to the original
  string. Never normalize an entire file on output. Ledger entries keep the
  exact original bytes represented by the input string, including NFD names,
  line endings, and BOM. An ambiguous pair is refused instead of guessed.
- Generate lower, upper, title, and camel casing with each separator (none,
  `_`, `-`, `.`, space, `/`). Restrict named styles to their documented
  renderings. For a single input word, choose the no-separator rendering
  first; lowercase `Acme` maps to smushed `northwindtraders` when needed.
  Explicit irregular forms map to the closest casing of the replacement.
- Only common dictionary words require explicit styles; short names produce
  warnings so distinctive names such as `Ion` remain usable. Warnings also
  identify weak replacement names. `common: false` overrides the common-word
  requirement. Plural endings are fixed: `s`, `es`, `'s`.
- Literal matches win before regex/secret matches. Dynamic matches only use
  untouched spans; a secret overlapping a literal replacement or a regex
  aborts unless a selected secret replacement covers it completely. Empty regex matches/replacements abort.
  Regex replacements support numbered/named captures, `$$`, and `$&`.
  Prefix/suffix-copy tokens (``$` `` and `$'`) are not supported.
- Validate concrete pairs per scope across the complete ledger. Reuse the
  same secret placeholder for repeated values; allocate numbered placeholders
  from the supplied ledger so several files share one stable namespace.
  Known secret patterns are catalog data; private keys redact whole blocks,
  and assignment patterns redact their captured value, keeping the label.
- Preview events include rule, scope, file, line, UTF-16 column, and skipped/new status.
  Secret values, overlapping skipped fragments, and secret-bearing filenames
  are masked in previews; originals live only in the ledger. Error messages identify locations without printing secret values.
- Restore stops on remaining anonymized terms in any casing, or unknown or
  altered `REDACTED_` placeholders. Shared words on both sides of a literal
  rule (for example `Corp`) are excluded from the individual-word scan;
  complete anonymized forms are still checked.
- Internal paths are repo-relative and use `/`; Windows separators are
  accepted at the boundary. Reject absolute/traversal paths, metadata paths,
  Windows device names, invalid characters, trailing dots/spaces, and path
  collisions under NFC plus case folding. Reject file/directory collisions
  and distinct source directories that collapse into one output directory.

## Deferred UI detail

Codename suggestions belong to the profile-creation flow, not the replacement
engine; the engine always requires a replacement.

## Resolved defaults

- Suffixes are fixed: `s`, `es`, `'s`.
- Literal matching is Unicode-aware through NFC views; original file text is
  preserved exactly. If different original spellings would require the same
  concrete reverse pair, the ledger rejects them as ambiguous.
- Codename suggestions remain a profile-creation enhancement; this step
  requires explicit replacements.

## Secret catalog

The built-in detector ids are `aws-access-key`, `aws-secret-key`, `private-key`,
`api-key`, `password`, `jwt`, `github-token`, `slack-token`, `slack-webhook`,
`stripe-key`, `google-api-key`, `google-oauth-token`, `discord-token`,
`discord-webhook`, `database-url`, `heroku-key`, and `mailgun-key`.

These are pattern detectors, not a guarantee that every secret will be found.
Generic API-key and password detectors use entropy thresholds to reduce
false positives. The catalog is independent of the replacement engine so
patterns can be maintained without changing matching or ledger behavior.

## Modules

```
replacer        orchestrate scans, ledger recording, and round-trip check
  compile       build forward/reverse matchers and dynamic patterns
  variants      split/render names and validate variant collisions
  matcher       wrap ahocorasick, select non-overlapping longest matches
  boundaries    token/word edges, plural suffixes, exceptions
  dynamic       regex and secret candidates, overlap checks
  regex         numbered/named capture substitutions
  secrets       detector catalog and entropy checks
  ledger        concrete-pair validation and placeholder allocation
  restore       ledger-first restore and residue scan
  replacement   apply spans and build masked previews
  text          Unicode offset mapping and source locations
paths           transform portable relative paths and reject collisions
  path-names    shared filename validation for paths and the local store
```
