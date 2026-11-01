# Rebuild design reference

Static design screens for the new dashboard. They are the visual and behavioural
spec, not code to ship. Each `*.dc.html` file is one screen: markup with inline
styles plus a small `renderVals()` block holding the sample data. Read them as
source; they need the design tool's runtime (`support.js`) to render, so don't
expect them to open cleanly in a browser.

Live canvas (owner only): https://claude.ai/artifact/2c1BxL251pFZtmiMgZvsgx

| Screen                | File                    | Work package |
| --------------------- | ----------------------- | ------------ |
| Workspaces home       | `Main.dc.html`          | 10-home      |
| Group sync            | `GroupSync.dc.html`     | 10-home      |
| New cloak (one sheet) | `NewCloak.dc.html`      | 20-new-cloak |
| First run             | `FirstRun.dc.html`      | 20-new-cloak |
| Push review           | `PushReview.dc.html`    | 30-push      |
| Profiles & rules      | `Profiles.dc.html`      | 40-profiles  |
| Profile JSON editor   | `ProfilesJson.dc.html`  | 40-profiles  |
| Known repos           | `KnownRepos.dc.html`    | 50-admin     |
| Agent requests        | `AgentRequests.dc.html` | 50-admin     |
| History & audit       | `History.dc.html`       | 50-admin     |
| Settings              | `Settings.dc.html`      | 50-admin     |
| ⌘K palette            | `Palette.dc.html`       | 00-foundation (shell) |

## Design tokens (lift these into `src/web/tokens.css`)

```
fonts      IBM Plex Sans (UI) · JetBrains Mono (paths, shas, counts)
           ship as system-font fallbacks or bundled woff2, never a CDN
ground     #0D0E10   rail/aside #0F1013   topbar #111215
panel      #121316   raised #1A1C20       selected row #1A1C20 + 2px accent left border
line       #25282E   line-strong #30343B  row divider #1D1F24
text       #E8E9EC   text-2 #A4AAB5       text-3 #7F8794   faint #4A4F58
accent     #A992FF   accent-soft #C7B8FF  accent-bg #2A2340 / #1B1826 border #3A3352
to push    #F0B455   bg #2A2215
source moved / pull  #6CB6FF  bg #152233 / banner #111925 border #253247
clean/ok   #5CC98E   bg #12201A
blocked    #F2777A   bg #2A1517
radius     5px controls · 6px buttons · 8px panels · 10–12px dialogs
type       13px base, 12–12.5px rows, 11–11.5px meta, 10.5px uppercase labels (0.06–0.08em)
density    rows 6–9px vertical padding; buttons 24–30px tall
```

Status is never colour alone: every badge carries text (`↑4 to push`, `↓2 source moved`, `clean`).
