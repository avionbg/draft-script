# Draft-Script Dashboard Profiles

Dashboards are first-class profile JSON files stored in:

```text
.draft-script/dashboards/
```

Each profile chooses existing widget IDs. Widget definitions live in the extension, so a new dashboard does not require TypeScript changes.

```json
{
  "id": "threads",
  "title": "Threads",
  "layout": "vertical",
  "widgets": [
    "active_threads",
    "dormant_threads",
    "threads_review"
  ]
}
```

## Profiles

| Field | Type | Description |
|---|---|---|
| `id` | string | Profile identifier shown in dashboard state |
| `title` | string | Webview title |
| `layout` | string | Currently `vertical`; future values may include `grid`, `columns`, `tabs` |
| `widgets` | string[] | Ordered widget IDs |

Default profile files created on first dashboard use:

| File | Purpose |
|---|---|
| `sidebar.json` | Sidebar dashboard profile |
| `threads.json` | Thread lifecycle dashboard |
| `timeline.json` | Timeline dashboard |
| `characters.json` | Character dashboard |
| `continuity.json` | Continuity dashboard |

## Commands

| Command | Purpose |
|---|---|
| `Draft-Script: Open Dashboard` | Pick any profile and open it in a WebviewPanel |
| `Draft-Script: Reload Dashboards` | Reload profile JSON and refresh open dashboard instances |
| `Draft-Script: Open Dashboard Folder` | Open `.draft-script/dashboards/` |

Multiple dashboard panels can be opened at the same time, including multiple instances of the same profile.

## Built-In Widgets

Profiles reference these widget IDs:

| Widget ID | Source | Purpose |
|---|---|---|
| `metric_characters` | `characters` | Character count |
| `metric_threads` | `threads` | Clean active/open thread count |
| `metric_locations` | `locations` | Location count |
| `metric_objects` | `objects` | Object count |
| `metric_timeline` | `timeline` | Timeline event count |
| `threads_review` | `threads` | Threads needing human review |
| `suggested_resolved` | `threads` | Threads with model-suggested resolution |
| `dormant_threads` | `threads` | Clean active/open threads not seen recently |
| `active_threads` | `threads` | Clean active/open threads |
| `threads_table` | `threads` | Full thread lifecycle table |
| `duplicate_threads` | `threads` | Possible duplicate thread warning list |
| `signal_heatmap` | `signals` | Signal density by chapter |
| `chapter_density_strip` | `chapters` | Thread, continuity, timeline, and signal density per chapter |
| `thread_lifecycle_strip` | `threads` | Thread update types across chapters |
| `thread_presence_heatmap` | `threads` | Thread appearances by chapter |
| `character_presence_heatmap` | `characters` | Character appearances by chapter |
| `location_presence_heatmap` | `locations` | Location appearances by chapter |
| `time_gap_sparkline` | `timeIndex` | Time gap trend across chapters |
| `timeline_density_strip` | `timeline` | Timeline event density by chapter |
| `timeline_events` | `timeline` | Timeline rendering |
| `timeline_table` | `timeline` | Timeline table |
| `continuity_active` | `continuity` | Active continuity notes |
| `characters_table` | `characters` | Character table |
| `character_appearances` | `characters` | Character appearance bar chart |
| `location_appearances` | `locations` | Location appearance bar chart |
| `mystery_clues` | `continuity` | Clues, evidence, and witness facts |
| `mystery_alibis` | `continuity` | Alibis, accounts, and cover stories |
| `mystery_suspects` | `threads` | Suspect-focused thread updates |
| `mystery_deceptions` | `threads` | Red herrings, cover stories, and reframed leads |
| `scifi_technology` | `continuity` | Technology state, constraints, failures, and protocols |
| `scifi_discoveries` | `timeline` | Discoveries, first contact, and alien ecology |
| `scifi_power_systems` | `threads` | Power shifts, resource conflicts, and system failures |
| `scifi_ethics` | `threads` | Ethical pressure, AI agency, and protocol dilemmas |
| `fantasy_magic_lore` | `continuity` | Magic rules, lore, world rules, and realm boundaries |
| `fantasy_power_politics` | `threads` | Faction conflict, power escalation, and oaths |
| `fantasy_prophecy_artifacts` | `threads` | Prophecies, rituals, and artifacts |
| `drama_relationships` | `continuity` | Relationship shifts, boundaries, and power dynamics |
| `drama_secrets` | `threads` | Secrets, subtext, and betrayal threads |
| `drama_promises_wounds` | `threads` | Promises, wounds, reconciliation, and open questions |
| `chronicle_turning_points` | `timeline` | Turning points, era transitions, and successions |
| `chronicle_consequences` | `threads` | Consequences, echoes, callbacks, and inherited legacy |
| `chronicle_time_gaps` | `timeIndex` | Largest chapter-to-chapter time gaps |

## Adding A Dashboard

Create a new file:

```text
.draft-script/dashboards/my-dashboard.json
```

Add:

```json
{
  "id": "my-dashboard",
  "title": "My Dashboard",
  "layout": "vertical",
  "widgets": [
    "metric_threads",
    "threads_review",
    "timeline_events"
  ]
}
```

Run `Draft-Script: Open Dashboard` and select it.

## Data Sources

Widget sources map to generated indexes in `.draft-script/indexes/`:

`characters`, `locations`, `objects`, `groups`, `timeline`, `threads`, `continuity`, `signals`, `timeIndex`, `chapters`.

## View Types

Built-in view types:

`metric`, `list`, `warning-list`, `status-list`, `table`, `bar-list`, `timeline`, `sparkline`, `heatmap`, `timeline-strip`, `chapter-density-strip`, `thread-lifecycle-strip`.

SVG views use compact inline SVG and are configured through `view` fields such as:

```json
{
  "type": "heatmap",
  "xField": "chapterNumber",
  "yField": "id",
  "labelField": "title",
  "maxRows": 14
}
```

Thread rows expose lifecycle helper fields:

| Field | Meaning |
|---|---|
| `isCleanActive` | `status` is `open` or `active`, without review/suggested resolved/changed |
| `suggestedStatusLabel` | Human-readable suggested status label, e.g. `suggested resolved` |
| `needsReview` | Thread needs user review |
| `suggestedStatus` | Latest model-suggested status |
| `lastSeenChapter` | Last chapter where the thread appeared |
