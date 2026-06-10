---
draft-script-internal: dsm-analysis
---

You are analyzing a chapter from a novel.

Extract from the provided text:
- overview (concise chapter summary, purpose, emotional/social function, setup/payoff role, human/technical focus, and editorial risk flags)
- characters (named people or beings)
- locations (named places)
- objects (named significant items)
- groups (tribes, factions, organizations)
- threads (new unresolved threads and lifecycle updates to known threads: progressed, reinforced, changed, partially resolved, resolved, reopened)
- timelineEvents (events with temporal significance, in order of occurrence)
- continuityNotes (state changes, resource tracking, construction, technology, relationships, logistics)
- timeIndex (temporal evidence: season, time references, chapter duration and gap estimates)

Rules:
- Do not invent information not present in the text.
- If unsure about an entry, set confidence below 0.7.
- Keep descriptions short (1-2 sentences max).
- roleInChapter: what this entity specifically does or represents in THIS passage.
- reference: include 1-2 short quotes or paraphrases supporting each extraction.
- aliases: list other name forms used in the text.
- overview.summary: 3-8 factual short bullets; do not rewrite the chapter.
- overview.purpose: explain the chapter's structural role in the book.
- overview.emotionalBeat: identify what changes in Marko, another character, a relationship, or the community; empty string if unclear.
- overview.chapterFunction: use exactly one of setup, development, payoff, aftermath, transition, climax, resolution, mixed.
- overview.setups/payoffs: include opened future threads and returned/resolved earlier promises when explicit in this chapter.
- overview.humanFocus: include interpersonal movement, character agency, and moments where others take over parts of Marko's system.
- overview.technicalFocus: list practical processes, technologies, materials, logistics, resources, infrastructure, or experiments.
- overview.riskFlags: include concise editorial risks; if mostly procedural/technical, say so.
- Use Serbian for overview if the manuscript is Serbian.

## Time Reference Rules

Time references are optional.

Extract explicit or implied references to the passage of time, duration, seasons, recurring cycles, or deadlines.

Time references are NOT timeline events. A timeline event is something that happens. A time reference is evidence of how much time passes.

Extract when the text contains:
- elapsed time between events
- duration of activities or states
- seasons or seasonal transitions
- approaching deadlines or time pressure
- recurring routines or cycles
- parts of the day

Good examples: three days later, for weeks, during winter, early spring, late autumn, before the first snow, that morning, the same evening, every morning, on the third day of the Moon of Fire
Bad examples: four kilometers upstream, ten people, two pickaxes, a great distance

Use exactly one of these types:
- "exact"    - specific date, named day, year, or in-world timestamp
- "elapsed"  - time that passed between events
- "duration" - how long something lasts
- "season"   - seasonal placement or transition
- "deadline" - approaching event or time pressure
- "daypart"  - time of day
- "routine"  - recurring temporal pattern

Each time reference must contain:
- type: one of the values above
- text: original text, verbatim
- description: short explanation of what this tells us about story time
- confidence: 0.0-1.0

Season fields:

A chapter may span multiple seasons. Capture seasonal progression - do NOT collapse to a single season value.

- startSeason: the season at the beginning of the chapter's story-world timeline
- endSeason: the season at the end of the chapter's story-world timeline
- chapterAnchor: the dominant story-world season/state after the chapter concludes - the season an author would say the story is "currently in". Use only present-time evidence; ignore flashbacks, memories, dreams, and historical narration. Omit if there is no present-time seasonal evidence.
- If startSeason and endSeason are the same, only populate startSeason.

Use: early_spring / mid_spring / late_spring / early_summer / mid_summer / late_summer / early_autumn / mid_autumn / late_autumn / early_winter / mid_winter / late_winter / first_snow / snow_melt - or a freeform value for non-Earth calendars.

Reference role:

Each time reference may include role when the temporal context is clear:

- current: present-time story action
- flashback: recalled memory or past event
- dream: dream or imagined sequence
- history: historical narration
- projection: future speculation or plan

Omit role when unclear. Do not guess.

Duration fields:

These are two distinct estimates - do not conflate them:

- sceneDuration: time occupied by actively dramatized scenes only - dialogue, meetings, journeys, hunts, expeditions, direct scene sequences. Does NOT include seasonal progression, montage, "months passed", narrative summaries, retrospective narration, flashbacks, dreams, or historical explanations. If the chapter is mostly summarized time, sceneDuration stays small.
- coveredTimeSpan: total story-world time covered by the entire chapter, including montage, seasonal progression, narrative summaries, and historical compression. May be dramatically larger than sceneDuration.
- estimatedGapFromPrevious: time since the end of the previous chapter. Omit for the first chapter or if there is no evidence.

All duration estimates use ranges: { "minDays": N, "likelyDays": N, "maxDays": N }

{{context}}

{{signals}}

Pre-extracted name candidates (use as hints, not gospel):
{{candidates}}

Text:
"""
{{text}}
"""

{{schema}}
