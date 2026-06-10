// ---------------------------------------------------------------------------
// Chapter analysis — primary source of truth (.draft-script/analysis/chapters/)
// ---------------------------------------------------------------------------

export interface ChapterAnalysis {
  schemaVersion: 3;
  chapter: ChapterMeta;
  overview: ChapterOverview;
  characters:      ChapterEntity[];
  locations:       ChapterEntity[];
  objects:         ChapterEntity[];
  groups:          ChapterEntity[];
  timelineEvents:  TimelineEvent[];
  /** Thread lifecycle updates found in this chapter, not only newly opened unresolved threads. */
  threads:         ThreadUpdate[];
  continuityNotes: ContinuityNote[];
  timeIndex?:      ChapterTimeIndex;
}

export type ChapterFunction =
  | 'setup'
  | 'development'
  | 'payoff'
  | 'aftermath'
  | 'transition'
  | 'climax'
  | 'resolution'
  | 'mixed';

export interface ChapterOverview {
  summary:        string[];
  purpose:        string;
  emotionalBeat:  string;
  chapterFunction: ChapterFunction;
  setups:         string[];
  payoffs:        string[];
  humanFocus:     string[];
  technicalFocus: string[];
  riskFlags:      string[];
  bookImpact:     string;
}

export interface ChapterMeta {
  id:          string;           // "chapter-0071"
  number:      number | undefined;
  title:       string;
  filePath:    string;
  contentHash: string;           // sha256 first 16 chars
  analyzedAt:  string;           // ISO
  model:       string;           // provider.id
}

export interface ChapterEntity {
  id:              string;
  name:            string;
  aliases:         string[];
  status:          'new' | 'already_indexed' | 'uncertain';
  canonId?:        string;   // set when status === 'already_indexed'
  possibleCanonId?: string;  // set when status === 'uncertain'
  description?:    string;
  roleInChapter?:  string;
  confidence:      number;
  reference?:      Reference[];
}

export type ThreadStatus =
  | 'open' | 'active' | 'resolved' | 'changed' | 'uncertain';

export type ThreadType =
  | 'promise' | 'risk' | 'mystery' | 'task' | 'question' | 'conflict' | 'system' | 'uncertain';

export type ThreadUpdateType =
  | 'new' | 'progressed' | 'reinforced' | 'changed' | 'partially_resolved' | 'resolved' | 'reopened';

export type ThreadResolutionType =
  | 'none' | 'explicit' | 'implicit' | 'partial';

export interface ThreadUpdate {
  id:               string;
  title:            string;
  description:      string;
  type:             ThreadType;
  status:           ThreadStatus;
  updateType:       ThreadUpdateType;
  resolutionType:   ThreadResolutionType;
  confidence:       number;
  reference?:       Reference[];
  relatedEntities?: string[];
  parentThread?:    string;
  signals?:         string[];
}

export interface TimelineEvent {
  id:          string;
  title:       string;
  description?: string;
  order?:      number;
  confidence:  number;
  reference?:  Reference[];
  signals?:    string[];
}

export interface ContinuityNote {
  id:               string;
  title:            string;
  description:      string;
  type:             'state' | 'resource' | 'construction' | 'technology' | 'relationship' | 'promise' | 'risk' | 'population' | 'logistics';
  status:           'active' | 'resolved' | 'changed' | 'uncertain';
  confidence:       number;
  reference?:       Reference[];
  relatedEntities?: string[];
  signals?:         string[];
}

export interface Reference {
  text: string;
  kind: 'quote' | 'paraphrase';
}

// ---------------------------------------------------------------------------
// Time Index — temporal evidence extracted per chapter
// ---------------------------------------------------------------------------

export type TimeRefType =
  | 'exact' | 'elapsed' | 'duration' | 'season' | 'deadline' | 'daypart' | 'routine';

export type TimeReferenceRole =
  | 'current' | 'flashback' | 'dream' | 'history' | 'projection';

export interface TimeReference {
  type:         TimeRefType;
  text:         string;        // verbatim phrase from chapter
  normalized?:  string;        // e.g. "late_autumn", "3 days"
  role?:        TimeReferenceRole;  // temporal context — omit when unclear
  description?: string;        // one sentence — what this tells us about story time
  confidence:   number;
}

export interface DayEstimate {
  minDays:    number;
  likelyDays: number;
  maxDays:    number;
}

export interface ChapterTimeIndex {
  startSeason?: {
    value:      string;   // season at the start of the chapter's story-world timeline
    confidence: number;
  };
  endSeason?: {
    value:      string;   // season at the end of the chapter's story-world timeline
    confidence: number;
  };
  chapterAnchor?: {
    value:      string;   // dominant story-world season/state after the chapter concludes
    confidence: number;
  };
  references:               TimeReference[];
  sceneDuration?:           DayEstimate;   // time occupied by active narrated scenes only
  coveredTimeSpan?:         DayEstimate;   // total story-world time covered, incl. montage/summaries
  estimatedGapFromPrevious?: DayEstimate;
}

// ---------------------------------------------------------------------------
// Canon — manually curated (.draft-script/canon/)
// ---------------------------------------------------------------------------

export interface CanonEntry {
  id:          string;
  name:        string;
  aliases:     string[];
  description: string;
  approvedAt:  string;
  modifiedAt?: string;
}

// ---------------------------------------------------------------------------
// Derived indexes — rebuildable (.draft-script/indexes/)
// ---------------------------------------------------------------------------

export interface CharacterIndexItem {
  id:                  string;
  name:                string;
  aliases:             string[];
  canonDescription?:   string;
  appearances: {
    chapterId:      string;
    chapterNumber:  number;
    roleInChapter?: string;
    confidence:     number;
  }[];
  generatedDescriptions: {
    chapterId:   string;
    description: string;
    confidence:  number;
  }[];
}

export interface ThreadIndexItem {
  id:          string;
  title:       string;
  type:        ThreadType;
  status:      ThreadStatus;
  description: string;
  firstSeenChapter?: number;
  lastSeenChapter?:  number;
  resolvedChapter?:  number;
  parentThread?:     string;
  lastKnownState?:   string;
  unresolvedQuestion?: string;
  history?:          ThreadHistoryItem[];
  lastUpdateType?:       ThreadUpdateType;
  lastResolutionType?:   ThreadResolutionType;
  suggestedStatus?:         ThreadStatus;
  suggestedUpdateType?:     ThreadUpdateType;
  suggestedResolutionType?: ThreadResolutionType;
  needsReview?:      boolean;
  confidence?:       number;
  references?:       Reference[];
  signals?:          string[];
  relatedEntities?:  string[];
  appearances: {
    chapterId:   string;
    chapterNumber: number;
    description: string;
    confidence:  number;
    status:      ThreadStatus;
    updateType:  ThreadUpdateType;
    resolutionType: ThreadResolutionType;
    reference?:  Reference[];
  }[];
  possibleDuplicates?: string[];
}

export interface ThreadHistoryItem {
  chapter: number;
  chapterTitle?: string;
  status?: ThreadStatus;
  updateType?: ThreadUpdateType;
  resolutionType?: ThreadResolutionType;
  summary: string;
  evidence?: Reference[];
}

export interface TimelineIndexItem {
  id:            string;
  title:         string;
  chapterId:     string;
  chapterNumber: number;
  order?:        number;
  description?:  string;
  confidence:    number;
  signals?:      string[];
}

// ---------------------------------------------------------------------------
// Signals — author-defined narrative pattern labels (.draft-script/canon/signals.json)
// ---------------------------------------------------------------------------

export interface Signal {
  id:          string;
  description: string;
}

export interface SignalIndexEntry {
  chapterNumber: number;
  sourceType:    'thread' | 'continuity' | 'timeline';
  sourceId:      string;
}

export interface ContinuityIndexItem {
  id:     string;
  title:  string;
  type:   ContinuityNote['type'];
  status: ContinuityNote['status'];
  firstSeen: { chapterId: string; chapterNumber: number };
  lastSeen:  { chapterId: string; chapterNumber: number };
  mentions: {
    chapterId:     string;
    chapterNumber: number;
    description:   string;
    confidence:    number;
    reference?:    Reference[];
  }[];
}

export interface ChapterMapItem {
  id:       string;
  number:   number;
  title:    string;
  filePath: string;
}

export interface ReferenceIndexItem {
  sourceType:    'timeline' | 'thread' | 'continuity' | 'character' | 'location' | 'object' | 'group';
  sourceId:      string;
  chapterId:     string;
  chapterNumber: number;
  text:          string;
  kind:          'quote' | 'paraphrase';
}

export interface TimeIndexItem extends ChapterTimeIndex {
  chapterId:     string;
  chapterNumber: number;
}

// ---------------------------------------------------------------------------
// Overrides — user assertions stored in .draft-script/overrides/
// ---------------------------------------------------------------------------

export interface CanonOverride {
  title?:       string;
  description?: string;
  aliases?:     string[];
  notes?:       string;
  tags?:        string[];
  userCreated?: boolean;
}

export interface IndexOverride {
  canonId?: string;
  title?:   string;
  status?:  string;
  suggestedStatus?: string | null;
  suggestedUpdateType?: string | null;
  suggestedResolutionType?: string | null;
  needsReview?: boolean | null;
  resolvedChapter?: number | null;
  parentThread?: string | null;
  lastKnownState?: string | null;
  unresolvedQuestion?: string | null;
  notes?:   string;
  hidden?:  boolean;
  tags?:    string[];
}
