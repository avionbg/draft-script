import { Candidate } from './localExtractor';
import { ChapterAnalysis, Signal, ThreadIndexItem, ThreadUpdate } from './draftScriptTypes';

const MAX_CONTEXT_ITEMS = 20;

function buildSchema(signals: Signal[]): string {
  const signalsField = signals.length
    ? '\n      "signals": ["signal_id_here"],'
    : '';

  return `Return STRICT JSON ONLY — no markdown, no code fences, no explanation.
Use exactly these field names (English, as shown):

{
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
      "relatedEntities": ["string"],${signalsField}
      "reference": []
    }
  ],
  "timelineEvents": [
    {
      "title": "string",
      "description": "string",
      "order": 1,
      "confidence": 0.0,${signalsField}
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
      "relatedEntities": ["string"],${signalsField}
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
        "normalized": "optional — e.g. late_autumn, 3 days",
        "role": "current|flashback|dream|history|projection",
        "description": "one sentence — what this tells us about story time",
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
Do NOT include status for characters/locations/objects/groups — the system resolves that separately.
For timeIndex.startSeason / endSeason: season at the start and end of the chapter's story-world timeline. If a chapter spans late spring to late autumn, both must be captured — do NOT collapse to a single season. Omit if unknown.
For timeIndex.chapterAnchor: the dominant story-world season/state after the chapter concludes. Use the latest present-time seasonal evidence only. Ignore flashbacks, memories, dreams, historical narration, and future projections. Omit if no present-time seasonal evidence exists.
For season values use: early_spring / mid_spring / late_spring / early_summer / mid_summer / late_summer / early_autumn / mid_autumn / late_autumn / early_winter / mid_winter / late_winter / first_snow / snow_melt — or a freeform value for non-Earth calendars.
For timeIndex.references: extract ALL temporal evidence phrases (seasons, time gaps, durations, deadlines, times of day, recurring patterns). Do NOT extract distances, quantities, or resource counts unless they explicitly describe time.
For timeIndex.references[].role: include only when the temporal context is clear — "current" = present story action; "flashback" = memory or recalled past; "dream" = imagined or dream sequence; "history" = historical narration; "projection" = future speculation. Omit role when unclear.
For timeIndex.sceneDuration: measures only actively dramatized scenes — dialogue, meetings, journeys, hunts, expeditions. Do NOT include seasonal progression, montage, narrative summaries, retrospective narration, flashbacks, dreams, or historical explanations. If most of the chapter is summarized time, sceneDuration remains small while coveredTimeSpan may be much larger.
For timeIndex.coveredTimeSpan: total story-world time covered by the chapter including montage, summaries, seasonal progression, and compressed narration — may be dramatically larger than sceneDuration.
For timeIndex.estimatedGapFromPrevious: time since the end of the previous chapter (omit for the first chapter or if unknown).
timeIndex.references.type: "exact" = specific date/time; "elapsed" = time since an event; "duration" = how long something lasts; "season" = seasonal placement; "deadline" = approaching event/pressure; "daypart" = time of day; "routine" = recurring pattern.`;
}

function buildSignalsBlock(signals: Signal[]): string {
  if (!signals.length) return '';
  const list = signals.map(s => `- ${s.id}\n  ${s.description}`).join('\n');
  return `Available Signals

Signals are semantic labels for recurring narrative patterns, themes, or behaviors.
You MUST only assign signals from the list below — never invent, modify, or abbreviate an ID.
Assign zero or more signals to threads, timelineEvents, and continuityNotes when applicable.
If no signal from the list fits, omit the signals field entirely.

Available signals (use ONLY these exact IDs):
${list}`;
}

export function buildPrompt(
  text:              string,
  candidates:        Candidate[],
  customTemplate?:   string,
  existingAnalyses?: Pick<ChapterAnalysis, 'threads' | 'timelineEvents'>[],
  signals:           Signal[] = [],
  knownThreads:      ThreadIndexItem[] = [],
): string {
  const hints = candidates.length
    ? candidates
        .map(c => `  - "${c.candidate}" (${c.mentions}x) — e.g.: "${c.contexts[0] ?? ''}"`)
        .join('\n')
    : '  (none detected)';

  const contextBlock  = buildContextBlock(existingAnalyses, knownThreads);
  const schema        = buildSchema(signals);
  const signalsBlock  = buildSignalsBlock(signals);

  if (customTemplate) {
    let result = customTemplate;
    if (result.includes('{{candidates}}')) {
      result = result.replace('{{candidates}}', hints);
    } else {
      result += `\n\nPre-extracted name candidates:\n${hints}`;
    }
    if (result.includes('{{context}}')) {
      result = result.replace('{{context}}', contextBlock);
    } else if (contextBlock) {
      result += `\n\n${contextBlock}`;
    }
    if (result.includes('{{signals}}')) {
      result = result.replace('{{signals}}', signalsBlock);
    } else if (signalsBlock) {
      result += `\n\n${signalsBlock}`;
    }
    if (result.includes('{{text}}')) {
      result = result.replace('{{text}}', text);
    } else {
      result += `\n\nText:\n"""\n${text}\n"""`;
    }
    if (result.includes('{{schema}}')) {
      result = result.replace('{{schema}}', schema);
    } else {
      result += `\n\n${schema}`;
    }
    return result;
  }

  return `You are analyzing a chapter from a novel.

Extract from the provided text:
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
- Keep descriptions short (1–2 sentences max).
- roleInChapter: what this entity specifically does or represents in THIS passage.
- reference: include 1–2 short quotes or paraphrases supporting each extraction.
- aliases: list other name forms used in the text.
${contextBlock ? `\n${contextBlock}\n` : ''}${signalsBlock ? `\n${signalsBlock}\n` : ''}
Pre-extracted name candidates (use as hints, not gospel):
${hints}

Text:
"""
${text}
"""

${schema}`;
}

function buildContextBlock(
  analyses?: Pick<ChapterAnalysis, 'threads' | 'timelineEvents'>[],
  knownThreads: ThreadIndexItem[] = [],
): string {
  if (!analyses?.length && !knownThreads.length) return '';
  const lines: string[] = [];

  const allThreads = knownThreads.length
    ? knownThreads
        .filter(t => t.status === 'open' || t.status === 'active' || t.needsReview)
        .slice(0, MAX_CONTEXT_ITEMS)
    : analyses
        ?.flatMap(a => a.threads)
        .filter(t => t.status === 'open' || t.status === 'active')
        .slice(0, MAX_CONTEXT_ITEMS) ?? [];

  if (allThreads.length) {
    lines.push('Known active/open threads (already indexed - reference by exact title if relevant, and return lifecycle updates when this chapter changes them):');
    for (const t of allThreads) {
      lines.push(renderKnownThread(t));
    }
  }

  const allEvents = (analyses?.flatMap(a => a.timelineEvents) ?? [])
    .slice(0, MAX_CONTEXT_ITEMS);

  if (allEvents.length) {
    lines.push('Known timeline events (already indexed):');
    for (const e of allEvents) {
      lines.push(`  - "${e.title}"`);
    }
  }

  return lines.join('\n');
}

function renderKnownThread(t: ThreadIndexItem | ThreadUpdate): string {
  if ('appearances' in t) {
    const lines = [`  - "${t.title}" [${t.type}, ${t.status}]`];
    lines.push(`    Description: ${t.description}`);
    if (t.lastSeenChapter != null) lines.push(`    Last seen: Ch. ${t.lastSeenChapter}`);
    if (t.lastKnownState) lines.push(`    Last known state: ${t.lastKnownState}`);
    if (t.unresolvedQuestion) lines.push(`    Unresolved question: ${t.unresolvedQuestion}`);
    if (t.parentThread) lines.push(`    Parent thread: ${t.parentThread}`);
    const history = (t.history ?? []).slice(-3);
    if (history.length) {
      lines.push('    Recent history:');
      for (const h of history) {
        lines.push(`    - Ch. ${h.chapter}: ${h.summary}`);
      }
    }
    return lines.join('\n');
  }
  return `  - "${t.title}" [${t.type}, ${t.status}]\n    Description: ${t.description}`;
}
