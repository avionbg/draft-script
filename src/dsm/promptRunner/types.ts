import type { IncludeNode, IncludeError } from './includeResolver';
export type  { IncludeNode, IncludeError };

// ─── Scope ────────────────────────────────────────────────────────────────────

export type PromptScope        = 'selection' | 'sentence' | 'chapter' | 'manuscript';
export type PromptProvider     = 'default' | 'vscode-lm' | 'openai' | 'ollama';
export type PromptOutputFormat = 'markdown' | 'json';

export interface PromptOutputConfig {
  path:    string;             // template — may contain {{chapterId}}, {{chapterNumber}}, {{chapterTitle}}, {{promptId}}
  format?: PromptOutputFormat;
}

// ─── Visibility ───────────────────────────────────────────────────────────────

/**
 * Controls which indexed data is visible to context blocks.
 *
 * - all                — no filtering (default)
 * - upToChapter        — items first seen <= currentChapter
 * - previousChapters   — items first seen < currentChapter
 * - currentChapterOnly — items first seen === currentChapter
 *
 * Signals, chapterText, selectedText, chapterMeta, and projectInstructions
 * are always unfiltered regardless of mode.
 */
export type VisibilityMode =
  | 'all'
  | 'upToChapter'
  | 'previousChapters'
  | 'currentChapterOnly';

// ─── Context block IDs ────────────────────────────────────────────────────────

export type PromptContextBlockId =
  | 'selectedText'
  | 'chapterText'
  | 'chapterMeta'
  | 'chapterSummary'
  | 'overview'
  | 'previousChapterOverview'
  | 'nextChapterOverview'
  | 'characters'
  | 'locations'
  | 'objects'
  | 'groups'
  | 'activeThreads'
  | 'dormantThreads'
  | 'activeContinuity'
  | 'signals'
  | 'timeline'
  | 'references'
  | 'projectInstructions';

// ─── Config sub-types ─────────────────────────────────────────────────────────

export interface PromptLimits {
  characters?:       number;
  locations?:        number;
  objects?:          number;
  groups?:           number;
  threads?:          number;
  continuity?:       number;
  timeline?:         number;
  references?:       number;
  dormantThreshold?: number;   // chapters since last seen → considered dormant (default 10)
}

export interface PromptWindowConfig {
  previousChapters?: number;
  nextChapters?:     number;
}

// ─── Prompt definition ────────────────────────────────────────────────────────

export interface PromptDefinition {
  // Required
  id:       string;
  title:    string;
  scope:    PromptScope;
  body:     string;         // prompt template with {{placeholders}}
  filePath: string;
  // Optional
  menuTitle?:   string;
  provider?:    PromptProvider;
  output?:      PromptOutputFormat | PromptOutputConfig;
  visibility?:  VisibilityMode;
  context?:     PromptContextBlockId[];
  limits?:      PromptLimits;
  window?:      PromptWindowConfig;
  description?: string;
  enabled?:     boolean;
  writer?:      boolean;
  lineEdit?:    boolean;
  lineEditType?: string;
}

// ─── Runtime context ──────────────────────────────────────────────────────────

export interface PromptRunContext {
  rootFolder:     string;
  chapterId?:     string;
  chapterPath?:   string;
  chapterNumber?: number;
  chapterTitle?:  string;
  chapterText?:   string;   // pre-extracted section text
  selectedText?:  string;
  userBrief?:     string;
  promptVariables?: Record<string, string>;
}

// ─── Rendered context block ───────────────────────────────────────────────────

export interface RenderedContextBlock {
  id:      PromptContextBlockId;
  heading: string;
  content: string;
}

// ─── Rendered prompt ─────────────────────────────────────────────────────────

export interface RenderedPromptBlockStats {
  id:     string;
  title:  string;
  chars:  number;
  words:  number;
  tokens: number;
}

export interface RenderedPrompt {
  promptId:        string;
  promptTitle:     string;
  finalPrompt:     string;
  estimatedChars:  number;
  estimatedWords:  number;
  estimatedTokens: number;
  contextBlocks:   RenderedPromptBlockStats[];
  // ─── Include resolution ───
  includeTree:   IncludeNode[];
  includeErrors: IncludeError[];
  includeTokens: number;
  generatedAt:     string;
}
