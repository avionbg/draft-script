Return STRICT JSON ONLY - no markdown, no code fences, no explanation.
Use exactly these field names (English, as shown):

{
  "overview": {
    "summary": ["3-8 short factual bullet strings"],
    "purpose": "short structural reason this chapter exists in the book",
    "emotionalBeat": "short emotional/social/relational change, or empty string",
    "chapterFunction": "setup|development|payoff|aftermath|transition|climax|resolution|mixed",
    "setups": ["future threads, questions, conflicts, technologies, relationships, or world details opened here"],
    "payoffs": ["earlier threads, objects, problems, or promises returned to or resolved here"],
    "humanFocus": ["interpersonal moments, social changes, relationship movement, character agency"],
    "technicalFocus": ["technologies, processes, tools, logistics, resources, infrastructure, experiments, materials"],
    "riskFlags": ["possible editorial risks such as too technical, summary-heavy, weak emotional beat"],
    "bookImpact": "short statement of how this chapter moves the larger book arc"
  },
  "characters": [
    {
      "name": "string",
      "aliases": ["string"],
      "description": "string",
      "roleInChapter": "string (what this character does in this specific passage)",
      "confidence": 0.0,
      "reference": [{ "text": "string", "kind": "quote" }]
    }
  ],
  "locations": [
    { "name": "string", "aliases": ["string"], "description": "string", "roleInChapter": "string", "confidence": 0.0, "reference": [] }
  ],
  "objects": [
    { "name": "string", "aliases": ["string"], "description": "string", "roleInChapter": "string", "confidence": 0.0, "reference": [] }
  ],
  "groups": [
    { "name": "string", "aliases": ["string"], "description": "string", "roleInChapter": "string", "confidence": 0.0, "reference": [] }
  ],
  "threads": [
    {
      "title": "string",
      "description": "string",
      "type": "promise|risk|mystery|task|question|conflict|system|uncertain",
      "status": "open|active|resolved|changed|uncertain",
      "updateType": "new|progressed|reinforced|changed|partially_resolved|resolved|reopened",
      "resolutionType": "none|explicit|implicit|partial",
      "confidence": 0.0,
      "parentThread": "string",
      "relatedEntities": ["string"],{{signalsField}}
      "reference": []
    }
  ],
  "timelineEvents": [
    {
      "title": "string",
      "description": "string",
      "order": 1,
      "confidence": 0.0,{{signalsField}}
      "reference": []
    }
  ],
  "continuityNotes": [
    {
      "title": "string",
      "description": "string",
      "type": "state|resource|construction|technology|relationship|promise|risk|population|logistics",
      "status": "active|resolved|changed|uncertain",
      "confidence": 0.0,
      "relatedEntities": ["string"],{{signalsField}}
      "reference": []
    }
  ],
  "timeIndex": {
    "startSeason":   { "value": "late_spring",  "confidence": 0.9  },
    "endSeason":     { "value": "late_autumn",  "confidence": 0.95 },
    "chapterAnchor": { "value": "late_autumn",  "confidence": 0.95 },
    "references": [
      {
        "type": "exact|elapsed|duration|season|deadline|daypart|routine",
        "text": "verbatim phrase from chapter",
        "normalized": "optional - e.g. late_autumn, 3 days",
        "role": "current|flashback|dream|history|projection",
        "description": "one sentence - what this tells us about story time",
        "confidence": 0.0
      }
    ],
    "sceneDuration":            { "minDays": 1,   "likelyDays": 2,   "maxDays": 4   },
    "coveredTimeSpan":          { "minDays": 180, "likelyDays": 210, "maxDays": 240 },
    "estimatedGapFromPrevious": { "minDays": 0,   "likelyDays": 1,   "maxDays": 7   }
  }
}

For threads.status: "open" = unresolved/new, "active" = ongoing and currently reinforced or progressed, "resolved" = resolved in this text, "changed" = scope/nature changed, "uncertain" = unclear.
threads includes both new unresolved threads and lifecycle updates to known indexed threads. Resolved and changed known threads are allowed and expected.
Use threads.updateType to describe what happened in this chapter.
Use threads.resolutionType to describe how resolution is proven. Use "none" when the thread is not resolved.
Use threads.parentThread when this thread is a sub-task of a broader system/thread.
Use known thread lastKnownState and unresolvedQuestion when deciding whether a thread progressed, changed, or resolved.
If the chapter shows the unresolvedQuestion has been answered, return that known thread with status "resolved" or "changed".
If the chapter only reinforces the same unresolvedQuestion, return updateType "reinforced".
For continuityNotes.status: "active" = ongoing concern, "resolved" = resolved in this text.
For reference.kind: "quote" = direct text, "paraphrase" = your summary.
Do NOT include status for characters/locations/objects/groups - the system resolves that separately.
For timeIndex.startSeason / endSeason: season at the start and end of the chapter's story-world timeline. If a chapter spans late spring to late autumn, both must be captured - do NOT collapse to a single season. Omit if unknown.
For timeIndex.chapterAnchor: the dominant story-world season/state after the chapter concludes. Use the latest present-time seasonal evidence only. Ignore flashbacks, memories, dreams, historical narration, and future projections. Omit if no present-time seasonal evidence exists.
For season values use: early_spring / mid_spring / late_spring / early_summer / mid_summer / late_summer / early_autumn / mid_autumn / late_autumn / early_winter / mid_winter / late_winter / first_snow / snow_melt - or a freeform value for non-Earth calendars.
For timeIndex.references: extract ALL temporal evidence phrases (seasons, time gaps, durations, deadlines, times of day, recurring patterns). Do NOT extract distances, quantities, or resource counts unless they explicitly describe time.
For timeIndex.references[].role: include only when the temporal context is clear - "current" = present story action; "flashback" = memory or recalled past; "dream" = imagined or dream sequence; "history" = historical narration; "projection" = future speculation. Omit role when unclear.
For timeIndex.sceneDuration: measures only actively dramatized scenes - dialogue, meetings, journeys, hunts, expeditions. Do NOT include seasonal progression, montage, narrative summaries, retrospective narration, flashbacks, dreams, or historical explanations. If most of the chapter is summarized time, sceneDuration remains small while coveredTimeSpan may be much larger.
For timeIndex.coveredTimeSpan: total story-world time covered by the chapter including montage, summaries, seasonal progression, and compressed narration - may be dramatically larger than sceneDuration.
For timeIndex.estimatedGapFromPrevious: time since the end of the previous chapter (omit for the first chapter or if unknown).
timeIndex.references.type: "exact" = specific date/time; "elapsed" = time since an event; "duration" = how long something lasts; "season" = seasonal placement; "deadline" = approaching event/pressure; "daypart" = time of day; "routine" = recurring pattern.
