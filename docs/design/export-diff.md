# Selected commit export

```text
commit picker
  -> file list: index, anonymized path, +/-, excluded?, binary?
  -> include-excluded override (export-only) + file checkboxes
  -> request selected indexes
  -> server re-resolves commit and changed paths
  -> read only selected blobs -> anonymize content and paths
  -> per-file Git-style red/green preview -> explicit clipboard copy
```

Keep source-path exclusions authoritative for Pull and Push. Export is a separate
read-only operation: it lists every changed path in the source commit, marks
excluded paths, and requires an explicit switch before exporting those files.
The client sends file indexes rather than source paths; the server resolves each
index against the commit again and validates that it is in range. Display paths
and diff content use the saved workspace rules and ledger. No data is sent to an
AI service. Omit binary content and impose per-file and total text limits.

## Desktop-style review

```text
+----------------+---------------------+-----------------------------+
| Commits        | Changed files       | Anonymized diff             |
| [x] latest     | [x] src/file.ts +4 -2| selected file, all selected  |
| [x] earlier    | [ ] config.json     | commits in chronological    |
| [ ] older      |                     | order                       |
+----------------+---------------------+-----------------------------+
| Excluded files [toggle]                 Selected files -> Copy diff |
+------------------------------------------------------------------+
```

Commit selection unions affected paths. File checkboxes control clipboard output;
clicking a file loads its diff inline without leaving the dialog. Copy concatenates
selected commit patches oldest first, preserving each commit's own first-parent
comparison. Requests reuse the validated single-commit API; the client handles
selection races and never copies a stale preview. The exclusion override applies
only to Export. Enforce a combined 1 MiB clipboard limit.
