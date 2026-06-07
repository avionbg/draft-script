import { WidgetConfig } from './types';
import { normalizeWidgetConfig } from './normalize';

const RAW_WIDGETS: unknown[] = [
  {
    id: 'metric_characters', title: 'Characters', source: 'characters',
    transform: {},
    layout: { span: 1 },
    view: { type: 'metric', metric: { type: 'count' } },
  },
  {
    id: 'metric_threads', title: 'Active Threads', source: 'threads',
    transform: { filter: { isCleanActive: true } },
    layout: { span: 1 },
    view: { type: 'metric', metric: { type: 'count' } },
  },
  {
    id: 'metric_locations', title: 'Locations', source: 'locations',
    transform: {},
    layout: { span: 1 },
    view: { type: 'metric', metric: { type: 'count' } },
  },
  {
    id: 'metric_objects', title: 'Objects', source: 'objects',
    transform: {},
    layout: { span: 1 },
    view: { type: 'metric', metric: { type: 'count' } },
  },
  {
    id: 'metric_timeline', title: 'Timeline Events', source: 'timeline',
    transform: {},
    layout: { span: 1 },
    view: { type: 'metric', metric: { type: 'count' } },
  },
  {
    id: 'threads_review',
    title: 'Threads Needing Review',
    source: 'threads',
    transform: {
      filterAny: [
        { needsReview: true },
        { suggestedStatus: ['resolved', 'changed'] },
        { status: 'uncertain' },
      ],
      sort: { field: 'lastSeenChapter', direction: 'asc' },
      limit: 20,
    },
    view: {
      type: 'status-list',
      fields: [
        { key: 'title' },
        { key: 'suggestedStatusLabel', fallback: '', className: 'dim' },
        { key: 'lastSeenChapter', format: 'Ch. {value}', className: 'dim' },
      ],
    },
  },
  {
    id: 'suggested_resolved',
    title: 'Suggested Resolved',
    source: 'threads',
    transform: {
      filter: { suggestedStatus: 'resolved' },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 20,
    },
    view: {
      type: 'status-list',
      fields: [
        { key: 'title' },
        { key: 'lastResolutionType', className: 'dim' },
      ],
    },
  },
  {
    id: 'dormant_threads',
    title: 'Dormant Threads',
    source: 'threads',
    transform: {
      filter: { isCleanActive: true, lastSeenBeforeChapters: 5 },
      sort: { field: 'lastSeenChapter', direction: 'asc' },
      limit: 20,
    },
    view: {
      type: 'status-list',
      severityField: 'dormant',
      fields: [
        { key: 'title' },
        { key: 'lastSeenChapter', format: 'Ch. {value}', className: 'dim' },
      ],
    },
  },
  {
    id: 'active_threads',
    title: 'Active Threads',
    source: 'threads',
    transform: {
      filter: { isCleanActive: true },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 30,
    },
    view: {
      type: 'list',
      fields: [
        { key: 'title' },
        { key: 'status', className: 'dim' },
      ],
    },
  },
  {
    id: 'threads_table',
    title: 'Threads',
    source: 'threads',
    transform: {
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 100,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Thread' },
        { key: 'type', label: 'Type', className: 'dim' },
        { key: 'status', label: 'Status', className: 'dim' },
        { key: 'suggestedStatusLabel', label: 'Suggested', fallback: '', className: 'dim' },
        { key: 'lastUpdateType', label: 'Update', className: 'dim' },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'timeline_events',
    title: 'Timeline',
    source: 'timeline',
    transform: { sort: { field: 'chapterNumber', direction: 'asc' } },
    view: {
      type: 'timeline',
      fields: [
        { key: 'chapterNumber', format: 'Ch. {value}', isLink: true },
        { key: 'title', label: 'Event' },
        { key: 'description', label: 'Description', fallback: '' },
      ],
    },
  },
  {
    id: 'timeline_table',
    title: 'Timeline Events',
    source: 'timeline',
    transform: { sort: { field: 'chapterNumber', direction: 'asc' }, limit: 200 },
    view: {
      type: 'table',
      fields: [
        { key: 'chapterNumber', label: 'Chapter', format: 'Ch. {value}', align: 'right', isLink: true },
        { key: 'title', label: 'Event' },
        { key: 'description', label: 'Description', fallback: '' },
      ],
    },
  },
  {
    id: 'continuity_active',
    title: 'Active Continuity',
    source: 'continuity',
    transform: { filter: { status: 'active' }, sort: { field: 'firstSeenChapter', direction: 'asc' } },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Note' },
        { key: 'type', label: 'Type', className: 'dim' },
        { key: 'firstSeenChapter', label: 'First', format: 'Ch. {value}', align: 'right', isLink: true },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
        { key: 'appearanceCount', label: 'Mentions', align: 'right' },
      ],
    },
  },
  {
    id: 'characters_table',
    title: 'Characters',
    source: 'characters',
    transform: { sort: { field: 'appearanceCount', direction: 'desc' }, limit: 100 },
    view: {
      type: 'table',
      fields: [
        { key: 'name', label: 'Name' },
        { key: 'canonDescription', label: 'Description', fallback: '', maxLength: 90 },
        { key: 'appearanceCount', label: 'Mentions', align: 'right' },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'character_appearances',
    title: 'Character Appearances',
    source: 'characters',
    transform: { sort: { field: 'appearanceCount', direction: 'desc' }, limit: 20 },
    view: { type: 'bar-list', primaryField: 'name', valueField: 'appearanceCount' },
  },
  {
    id: 'location_appearances',
    title: 'Location Appearances',
    source: 'locations',
    transform: { sort: { field: 'appearanceCount', direction: 'desc' }, limit: 20 },
    view: { type: 'bar-list', primaryField: 'name', valueField: 'appearanceCount' },
  },
  {
    id: 'duplicate_threads',
    title: 'Possible Duplicate Threads',
    source: 'threads',
    transform: { filter: { hasDuplicates: true } },
    view: {
      type: 'warning-list',
      emptyMessage: 'No duplicates detected',
      fields: [
        { key: 'title' },
        { key: 'lastSeenChapter', format: 'Ch. {value}', className: 'dim' },
      ],
    },
  },
  {
    id: 'signal_heatmap',
    title: 'Signal Heatmap',
    source: 'signals',
    transform: { sort: { field: 'count', direction: 'desc' }, limit: 12 },
    view: {
      type: 'heatmap',
      xField: 'chapterNumber',
      yField: 'id',
      labelField: 'id',
      valueField: 'count',
      maxRows: 12,
    },
  },
  {
    id: 'chapter_density_strip',
    title: 'Chapter Density',
    source: 'chapters',
    transform: {},
    view: { type: 'chapter-density-strip' },
  },
  {
    id: 'thread_lifecycle_strip',
    title: 'Thread Lifecycle',
    source: 'threads',
    transform: {},
    view: { type: 'thread-lifecycle-strip' },
  },
  {
    id: 'thread_presence_heatmap',
    title: 'Thread Presence',
    source: 'threads',
    transform: { sort: { field: 'appearanceCount', direction: 'desc' }, limit: 18 },
    view: {
      type: 'heatmap',
      xField: 'chapterNumber',
      yField: 'id',
      labelField: 'title',
      maxRows: 18,
    },
  },
  {
    id: 'character_presence_heatmap',
    title: 'Character Presence',
    source: 'characters',
    transform: { sort: { field: 'appearanceCount', direction: 'desc' }, limit: 16 },
    view: {
      type: 'heatmap',
      xField: 'chapterNumber',
      yField: 'id',
      labelField: 'name',
      maxRows: 16,
    },
  },
  {
    id: 'location_presence_heatmap',
    title: 'Location Presence',
    source: 'locations',
    transform: { sort: { field: 'appearanceCount', direction: 'desc' }, limit: 14 },
    view: {
      type: 'heatmap',
      xField: 'chapterNumber',
      yField: 'id',
      labelField: 'name',
      maxRows: 14,
    },
  },
  {
    id: 'time_gap_sparkline',
    title: 'Time Gap Trend',
    source: 'timeIndex',
    transform: { sort: { field: 'chapterNumber', direction: 'asc' } },
    view: {
      type: 'sparkline',
      xField: 'chapterNumber',
      yField: 'likelyGap',
    },
  },
  {
    id: 'timeline_density_strip',
    title: 'Timeline Density',
    source: 'timeline',
    transform: {},
    view: {
      type: 'timeline-strip',
      xField: 'chapterNumber',
    },
  },
  {
    id: 'mystery_clues',
    title: 'Clues & Evidence',
    source: 'continuity',
    transform: {
      filter: { signals: { includesAny: ['clue_planted', 'evidence_contradiction', 'witness_account'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 30,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Evidence' },
        { key: 'type', label: 'Type', className: 'dim' },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'mystery_alibis',
    title: 'Alibis & Accounts',
    source: 'continuity',
    transform: {
      filter: { signals: { includesAny: ['alibi_established', 'alibi_broken', 'witness_account', 'cover_story'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 24,
    },
    view: {
      type: 'status-list',
      fields: [
        { key: 'title' },
        { key: 'lastSeenChapter', format: 'Ch. {value}', className: 'dim' },
      ],
    },
  },
  {
    id: 'mystery_suspects',
    title: 'Suspects',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['suspect_introduced', 'motive_revealed', 'deception_detected'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 25,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Suspect thread' },
        { key: 'status', label: 'Status', className: 'dim' },
        { key: 'lastKnownState', label: 'Current read', fallback: '', maxLength: 80 },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'mystery_deceptions',
    title: 'Deceptions',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['red_herring', 'cover_story', 'deception_detected', 'false_lead_reframed'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 20,
    },
    view: {
      type: 'warning-list',
      fields: [
        { key: 'title' },
        { key: 'suggestedStatusLabel', fallback: '', className: 'dim' },
      ],
    },
  },
  {
    id: 'scifi_technology',
    title: 'Technology State',
    source: 'continuity',
    transform: {
      filter: { signals: { includesAny: ['tech_established', 'tech_failure', 'constraint_revealed', 'protocol_triggered'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 30,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'System' },
        { key: 'status', label: 'Status', className: 'dim' },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'scifi_discoveries',
    title: 'Discoveries',
    source: 'timeline',
    transform: {
      filter: { signals: { includesAny: ['discovery', 'first_contact', 'alien_ecology'] } },
      sort: { field: 'chapterNumber', direction: 'asc' },
      limit: 40,
    },
    view: {
      type: 'timeline',
      fields: [
        { key: 'chapterNumber', format: 'Ch. {value}', isLink: true },
        { key: 'title' },
        { key: 'description', fallback: '' },
      ],
    },
  },
  {
    id: 'scifi_power_systems',
    title: 'Power & Systems',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['power_shift', 'system_failure', 'resource_conflict', 'faction_conflict'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 30,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Thread' },
        { key: 'status', label: 'Status', className: 'dim' },
        { key: 'lastKnownState', label: 'State', fallback: '', maxLength: 90 },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'scifi_ethics',
    title: 'Ethical Pressure',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['ethical_dilemma', 'ai_agency', 'protocol_triggered'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 20,
    },
    view: {
      type: 'status-list',
      fields: [
        { key: 'title' },
        { key: 'lastSeenChapter', format: 'Ch. {value}', className: 'dim' },
      ],
    },
  },
  {
    id: 'fantasy_magic_lore',
    title: 'Magic & Lore',
    source: 'continuity',
    transform: {
      filter: { signals: { includesAny: ['magic_system_rule', 'lore_reveal', 'world_rule', 'realm_boundary'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 35,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Rule / Lore' },
        { key: 'type', label: 'Type', className: 'dim' },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'fantasy_power_politics',
    title: 'Power & Politics',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['faction_conflict', 'political_shift', 'power_escalation', 'oath_bound'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 30,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Thread' },
        { key: 'type', label: 'Type', className: 'dim' },
        { key: 'lastKnownState', label: 'State', fallback: '', maxLength: 90 },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'fantasy_prophecy_artifacts',
    title: 'Prophecy & Artifacts',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['prophecy_mentioned', 'prophecy_step', 'artifact_activated', 'ritual_performed'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 25,
    },
    view: {
      type: 'status-list',
      fields: [
        { key: 'title' },
        { key: 'suggestedStatusLabel', fallback: '', className: 'dim' },
      ],
    },
  },
  {
    id: 'drama_relationships',
    title: 'Relationship Shifts',
    source: 'continuity',
    transform: {
      filter: { signals: { includesAny: ['relationship_shift', 'power_dynamic', 'attachment_shift', 'boundary_crossed'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 35,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Relationship' },
        { key: 'status', label: 'Status', className: 'dim' },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'drama_secrets',
    title: 'Secrets & Subtext',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['secret_kept', 'secret_revealed', 'subtext', 'betrayal'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 25,
    },
    view: {
      type: 'status-list',
      fields: [
        { key: 'title' },
        { key: 'status', className: 'dim' },
      ],
    },
  },
  {
    id: 'drama_promises_wounds',
    title: 'Promises & Wounds',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['promise_made', 'promise_broken', 'emotional_wound', 'reconciliation'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 30,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Thread' },
        { key: 'lastUpdateType', label: 'Update', className: 'dim' },
        { key: 'unresolvedQuestion', label: 'Open question', fallback: '', maxLength: 90 },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'chronicle_turning_points',
    title: 'Turning Points',
    source: 'timeline',
    transform: {
      filter: { signals: { includesAny: ['turning_point', 'era_transition', 'status_quo_change', 'succession'] } },
      sort: { field: 'chapterNumber', direction: 'asc' },
      limit: 80,
    },
    view: {
      type: 'timeline',
      fields: [
        { key: 'chapterNumber', format: 'Ch. {value}', isLink: true },
        { key: 'title' },
        { key: 'description', fallback: '' },
      ],
    },
  },
  {
    id: 'chronicle_consequences',
    title: 'Consequences & Echoes',
    source: 'threads',
    transform: {
      filter: { signals: { includesAny: ['consequence', 'parallel', 'callback', 'legacy_inherited', 'cycle_repeated'] } },
      sort: { field: 'lastSeenChapter', direction: 'desc' },
      limit: 35,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'title', label: 'Thread' },
        { key: 'status', label: 'Status', className: 'dim' },
        { key: 'lastKnownState', label: 'State', fallback: '', maxLength: 90 },
        { key: 'lastSeenChapter', label: 'Last', format: 'Ch. {value}', align: 'right', isLink: true },
      ],
    },
  },
  {
    id: 'chronicle_time_gaps',
    title: 'Time Gaps',
    source: 'timeIndex',
    transform: {
      sort: { field: 'likelyGap', direction: 'desc' },
      limit: 25,
    },
    view: {
      type: 'table',
      fields: [
        { key: 'chapterNumber', label: 'Chapter', format: 'Ch. {value}', align: 'right' },
        { key: 'likelyGap', label: 'Gap', format: '~{value}d', align: 'right' },
        { key: 'currentSeasonValue', label: 'Season', fallback: '' },
        { key: 'refCount', label: 'Refs', align: 'right' },
      ],
    },
  },
];

const WIDGETS = RAW_WIDGETS.map(normalizeWidgetConfig);

export function getWidgetDefinitions(): WidgetConfig[] {
  return WIDGETS.map(w => ({ ...w }));
}

export function getWidgetMap(): Map<string, WidgetConfig> {
  return new Map(getWidgetDefinitions().map(w => [w.id, w]));
}
