---
type: concept
title: Anonymizer engine
description: How repo-cloak replaces names, regex matches and secrets in file contents and paths, keeps every replacement reversible through a ledger, verifies each file round-trips, and restores workspace edits (including newly written code) without leaving anonymized text behind.
tags: [anonymizer, replacer, ledger, restore, secrets, aho-corasick, boundaries]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-20T12:02:39.628Z
sources:
  - id: openwiki-source-7b9920531cd8d953e189f265
    resource: repo://src/core/boundaries.ts
  - id: openwiki-source-f32ceae3cfa502189b22e5d5
    resource: repo://src/core/compile.ts
  - id: openwiki-source-bae3ccb57229d8062a355e41
    resource: repo://src/core/dynamic.ts
  - id: openwiki-source-0ca81a67cb82798ff6714d27
    resource: repo://src/core/ledger.ts
  - id: openwiki-source-30f5b2506128e38be2f66fcb
    resource: repo://src/core/matcher.ts
  - id: openwiki-source-925566863b154480fb1dd9ff
    resource: repo://src/core/paths.ts
  - id: openwiki-source-acf764cf6fb5ed2346495cce
    resource: repo://src/core/replacer.ts
  - id: openwiki-source-a56282b274cccf28af626595
    resource: repo://src/core/restore.ts
  - id: openwiki-source-91a4eb778e6a578d3099f224
    resource: repo://src/core/secrets.ts
  - id: openwiki-source-302220dbcba1722d7066e509
    resource: repo://src/core/variants.ts
generated: { by: "claude-code", at: "2026-10-20T12:02:39.628Z" }
---

# Anonymizer engine

All of this is pure code in `src/core/`; it never touches the disk.
`createReplacer(rules)` compiles rules once and returns `anonymize`,
`restore` and rule `warnings`.

```
rules ──compileScope──> per scope (content, paths):
                          forward matcher   original variants  -> anonymized
                          reverse matcher   anonymized variants -> original
                          dynamic rules     regex + secret detectors
                          residue terms     anonymized words to watch for

anonymize(text)                                   restore(text, ledger)
  1 refuse text that already contains             1 ledger pairs + reverse literal
    anonymized values or REDACTED_ placeholders     variants, boundary-checked
  2 literal matches -> boundary / except check    2 leftmost-longest selection
  3 leftmost-longest selection                    3 any REDACTED_ left?  -> error
  4 regex + secret matches outside literals       4 any anonymized word left
  5 apply, add concrete pairs to the ledger         (case-insensitive)? -> error
  6 restore in memory; must equal the input
```

## Literal rules and case-style variants

A literal rule's `match` and `replace` are split into words (lodash `words`,
NFC-normalized), then rendered in every combination of casing (lower, UPPER,
Title, camel) and separator (none, `_`, `-`, `.`, space, `/`). The rule
`Acme Corp -> Northwind Traders` therefore also maps `AcmeCorp`, `acmeCorp`,
`ACME_CORP`, `acme-corp`, `acmecorp` and so on, each to the same style of the
replacement.

- `styles` limits the set to named styles (`pascal`, `snake`, `screaming`, ...).
- `forms` adds irregular spellings with an exact pair.
- When two styles render the same original (word counts differ), the first
  rendering wins forward; every reverse spelling stays available.
- Common words (`apple`, `meta`, `data`, `client`, ...) require explicit
  `styles` or `common: false`.
- `compileVariants` rejects two rules producing the same original or the same
  anonymized spelling, and a rule whose original equals its replacement.

Warnings (not errors) flag short names and weak replacements, such as a
replacement under four characters or a common word, which would also catch
unrelated code on restore.

## Matching

All variants of all literal rules go into one Aho-Corasick automaton per scope
(`core/matcher.ts`), so each file is scanned once regardless of rule count.
Overlapping candidates are resolved leftmost-first, then longest, then input
order (`selectMatches`).

## Boundaries

Every literal candidate passes `hasBoundary` (`core/boundaries.ts`):

| Mode       | Edge is a boundary when                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `token`    | a neighbour is not a letter/digit, a letter/digit switch, a lower→Upper hump, or an `ABc` acronym edge (default) |
| `word`     | only a non-letter/digit neighbour                                           |
| `anywhere` | always                                                                      |

A trailing `s`, `es` or `'s` followed by a boundary also counts in `token`
mode. So `getAcmeToken` and `ACME_API` match `Acme`, while `Acmeology` does
not. `except` lists spellings that always stay unchanged. Skipped candidates
are kept in the preview with a reason: `boundary`, `except` or `overlap`.

## Regex and secret rules

Regex and secret rules run after literals, only outside literal matches.

- **Regex:** the pattern runs with `d` and `g` flags; `$1` and `$<name>`
  expand in `replace`. Empty matches, empty replacements, and a replacement
  that already appears in the text are errors.
- **Secrets:** a built-in catalog of 17 detectors (AWS keys, private keys,
  API keys and passwords, JWTs, GitHub/Slack/Stripe/Google/Discord/Mailgun
  tokens, webhook URLs, database URLs, Heroku keys). Detectors with a
  `secret` group replace only the value; some apply a Shannon-entropy
  minimum. A secret becomes a stable placeholder such as
  `REDACTED_AWS_ACCESS_KEY_1`, reused for the same value. A secret that
  overlaps a literal or another replacement is an error, not a silent skip.
- Secret values are masked in preview output.

## The ledger

Every accepted replacement adds a concrete pair to the ledger:
`{ ruleId, kind, scope, boundary, original, anonymized }`. `validateLedger`
requires pairs to be one-to-one per scope, in both directions. The ledger is
what makes regex and secret replacements reversible, and it is stored sealed
in the workspace manifest.

## Round-trip verification

After anonymizing, `anonymize` immediately restores the result in memory. If
the restored text differs from the input in any byte, it throws
`round-trip verification failed; replacements are ambiguous` with the line.
A file that could not be restored exactly is never written.

Anonymizing also refuses source text that already contains an anonymized
spelling, a ledger value, or (with secret rules) a `REDACTED_` placeholder,
because restore would later turn it into a proprietary name.

## Restoring workspace edits

`restore` combines ledger pairs with reverse literal variants, so code the
agent writes new (`NorthwindTradersClient`) is restored too
(`AcmeCorpClient`), not only text that was extracted. Two safety nets run on
the result:

- any remaining `REDACTED_...` placeholder (unknown or altered) is an error;
- a case-insensitive scan for any anonymized word, or non-secret ledger
  value, that is still present is an error ("anonymized text remains").

Preview entries from restore mark replacements that did not come from the
ledger as new.

## Paths

Paths are transformed one segment at a time with scope `paths`
(`core/paths.ts`). Each path must be relative and portable, and may not
contain `.git` or `.repo-cloak` segments. A replacement that introduces a
separator is rejected. `checkPathCollisions` compares NFC-normalized,
lowercased prefixes, so two paths that would map onto one output (including
case-only differences on case-insensitive file systems), or a file that
would collide with a folder, are refused.

## Related pages

- [Profiles, rules and file patterns](profiles-and-file-patterns.md)
- [Cloak: extracting into a workspace](../workflows/cloak-extraction.md)
- [Restore and Git worktrees](../workflows/restore-and-worktrees.md)
