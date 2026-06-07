import * as fs   from 'fs';
import * as path from 'path';
import { Signal } from './draftScriptTypes';
import { AnalysisStore } from './analysisStore';

const SIGNALS_FILE = path.join('.draft-script', 'canon', 'signals.json');
const PROMPT_FILE  = path.join('.draft-script', 'prompts', 'dsm-analysis.md');

export const DEFAULT_SIGNALS: Signal[] = [
  { id: 'knowledge_transfer',    description: 'Knowledge is transferred from one character or group to another.' },
  { id: 'misunderstanding',      description: 'Knowledge is partially misunderstood or distorted.' },
  { id: 'autonomy',              description: 'A character acts independently without direct guidance.' },
  { id: 'institution_seed',      description: 'A persistent social structure begins to emerge.' },
  { id: 'dependency_on_character', description: 'A character or group depends on another for key needs.' },
  { id: 'under_the_rug',         description: 'A character notices an anomaly, mystery, or inconsistency but intentionally postpones investigation because a more urgent practical problem takes priority.' },
  { id: 'anomaly',               description: 'Something does not fit expected patterns or rules.' },
  { id: 'culture_shift',         description: 'A cultural norm, belief, or behavior begins to change.' },
];

const BUILT_IN_PROMPT = `You are analyzing a chapter from a novel.

Extract from the provided text:
- characters (named people or beings)
- locations (named places)
- objects (named significant items)
- groups (tribes, factions, organizations)
- threads (new unresolved threads and lifecycle updates to known threads: progressed, reinforced, changed, partially resolved, resolved, reopened)
- timelineEvents (events with temporal significance, in order of occurrence)
- continuityNotes (state changes, resource tracking, construction, technology, relationships, logistics)
- timeIndex (temporal evidence — see Time Reference Rules below)

Rules:
- Do not invent information not present in the text.
- If unsure about an entry, set confidence below 0.7.
- Keep descriptions short (1–2 sentences max).
- roleInChapter: what this entity specifically does or represents in THIS passage.
- reference: include 1–2 short quotes or paraphrases supporting each extraction.
- aliases: list other name forms used in the text.

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

Good examples: three days later, for weeks, during winter, early spring, late autumn (ili late fall), before the first snow, that morning, the same evening, every morning, on the third day of the Moon of Fire
Bad examples: four kilometers upstream, ten people, two pickaxes, a great distance

Use exactly one of these types:
- "exact"    — specific date, named day, year, or in-world timestamp
- "elapsed"  — time that passed between events
- "duration" — how long something lasts
- "season"   — seasonal placement or transition
- "deadline" — approaching event or time pressure
- "daypart"  — time of day
- "routine"  — recurring temporal pattern

Each time reference must contain:
- type: one of the values above
- text: original text, verbatim
- description: short explanation of what this tells us about story time
- confidence: 0.0–1.0

**Season fields**

A chapter may span multiple seasons. Capture seasonal progression — do NOT collapse to a single season value.

- startSeason: the season at the beginning of the chapter's story-world timeline
- endSeason:   the season at the end of the chapter's story-world timeline
- chapterAnchor: the dominant story-world season/state after the chapter concludes — the season an author would say the story is "currently in". Use only present-time evidence; ignore flashbacks, memories, dreams, and historical narration. Omit if there is no present-time seasonal evidence.
- If startSeason and endSeason are the same, only populate startSeason

Use: early_spring / mid_spring / late_spring / early_summer / mid_summer / late_summer / early_autumn / mid_autumn / late_autumn / early_winter / mid_winter / late_winter / first_snow / snow_melt — or a freeform value for non-Earth calendars.

**Reference role**

Each time reference may include role when the temporal context is clear:

- current:    present-time story action
- flashback:  recalled memory or past event
- dream:      dream or imagined sequence
- history:    historical narration
- projection: future speculation or plan

Omit role when unclear. Do not guess.

**Duration fields**

These are two distinct estimates — do not conflate them:

- sceneDuration: time occupied by actively dramatized scenes only — dialogue, meetings, journeys, hunts, expeditions, direct scene sequences. Does NOT include seasonal progression, montage, "months passed", narrative summaries, retrospective narration, flashbacks, dreams, or historical explanations. If the chapter is mostly summarized time, sceneDuration stays small.
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
`;

export class SignalManager {
  private readonly signalsFile: string;
  private readonly promptFile:  string;

  constructor(private readonly rootFolder: string) {
    this.signalsFile = path.join(rootFolder, SIGNALS_FILE);
    this.promptFile  = path.join(rootFolder, PROMPT_FILE);
  }

  // ---------------------------------------------------------------------------
  // Signal definitions
  // ---------------------------------------------------------------------------

  read(): Signal[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.signalsFile, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as Signal[]) : [];
    } catch {
      return [];
    }
  }

  write(signals: Signal[]): void {
    fs.mkdirSync(path.dirname(this.signalsFile), { recursive: true });
    fs.writeFileSync(this.signalsFile, JSON.stringify(signals, null, 2), 'utf-8');
  }

  /** Creates signals.json from defaults if the file does not yet exist. */
  ensureExists(): void {
    if (!fs.existsSync(this.signalsFile)) {
      this.write(DEFAULT_SIGNALS);
    }
  }

  // ---------------------------------------------------------------------------
  // Orphan discovery
  // ---------------------------------------------------------------------------

  /** Returns signal IDs found in chapter analyses that are not in the current definitions. */
  discoverOrphans(store: AnalysisStore): string[] {
    const defined = new Set(this.read().map(s => s.id));
    const found   = new Set<string>();

    for (const ch of store.readAll()) {
      for (const t of ch.threads)         (t.signals ?? []).forEach(id => found.add(id));
      for (const e of ch.timelineEvents)  (e.signals ?? []).forEach(id => found.add(id));
      for (const n of ch.continuityNotes) (n.signals ?? []).forEach(id => found.add(id));
    }

    return [...found].filter(id => !defined.has(id)).sort();
  }

  /** Appends orphan IDs to signals.json with empty descriptions. Returns how many were added. */
  importOrphans(store: AnalysisStore): number {
    const orphans = this.discoverOrphans(store);
    if (!orphans.length) return 0;
    const current = this.read();
    this.write([...current, ...orphans.map(id => ({ id, description: '' }))]);
    return orphans.length;
  }

  // ---------------------------------------------------------------------------
  // Prompt file
  // ---------------------------------------------------------------------------

  /** Creates LLM_analysis.md from the built-in template if the file does not yet exist. */
  ensurePromptFile(): void {
    if (!fs.existsSync(this.promptFile)) {
      const dir = path.dirname(this.promptFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.promptFile, BUILT_IN_PROMPT, 'utf-8');
    }
  }

  readPromptTemplate(): string {
    try {
      return fs.readFileSync(this.promptFile, 'utf-8');
    } catch {
      return BUILT_IN_PROMPT;
    }
  }
}
