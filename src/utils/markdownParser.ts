import * as fs from 'fs';
import * as path from 'path';

export interface HeadingNode {
  title: string;
  level: number;
  /** Zero-based line index in the source file. */
  line: number;
  children: HeadingNode[];
}

// ---------------------------------------------------------------------------
// Word / character counting
// ---------------------------------------------------------------------------

/** Count prose words, ignoring Markdown syntax characters. */
export function countWords(text: string): number {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`[^`]+`/g, '')        // inline code
    .replace(/^\s*#{1,6}\s+/gm, '') // heading markers
    .replace(/[*_~\[\]()>|]/g, ''); // other md syntax
  const tokens = cleaned.trim().split(/\s+/);
  return tokens.filter(t => t.length > 0).length;
}

/** Count non-whitespace characters. */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

// ---------------------------------------------------------------------------
// Heading tree
// ---------------------------------------------------------------------------

/** Parse a markdown string into a nested heading tree. */
export function parseHeadings(content: string): HeadingNode[] {
  const lines = content.split('\n');
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (!m) continue;

    const level = m[1].length;
    const title = m[2].trim();
    const node: HeadingNode = { title, level, line: i, children: [] };

    // Pop stack until we find a parent with a lower level number
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export interface CharacterEntry {
  name: string;
  description: string;
}

export interface CharacterGroup {
  name: string;
  characters: CharacterEntry[];
}

/**
 * Parse a characters.md file into groups and characters.
 *
 * Format:
 *   # Group Name        ← group header
 *   ## Character Name   ← character
 *   Description text    ← character description (until next heading)
 *
 * ## headings that appear before any # heading are collected into a default
 * "Characters" group.
 */
export function parseCharacterGroups(content: string): CharacterGroup[] {
  const lines = content.split('\n');
  const groups: CharacterGroup[] = [];
  let currentGroupName = '';       // empty = no group header seen yet
  let currentChar: CharacterEntry | null = null;
  const descBuffer: string[] = [];

  function flushChar() {
    if (!currentChar) return;
    currentChar.description = descBuffer.join('\n').trim();
    descBuffer.length = 0;

    let g = groups.find(g => g.name === currentGroupName);
    if (!g) { g = { name: currentGroupName, characters: [] }; groups.push(g); }
    g.characters.push(currentChar);
    currentChar = null;
  }

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);

    if (h1) {
      flushChar();
      currentGroupName = h1[1].trim();
    } else if (h2) {
      flushChar();
      currentChar = { name: h2[1].trim(), description: '' };
    } else if (currentChar) {
      descBuffer.push(line);
    }
  }
  flushChar();

  return groups;
}

/**
 * Default suffix list for Serbian/Croatian inflection matching.
 * Exported so the characters provider can fall back to this when the user
 * hasn't set a custom list in settings.
 * Sorted longest-first so regex alternation always picks the greedy match.
 */
export const DEFAULT_INFLECTION_SUFFIXES: string[] = [
  'ovog','ovom','ovo','ova','ove','ovi','ovu','ov',
  'evog','evom','evo','eva','eve','evi','evu','ev',
  'om','em','im',
  'a','e','u','i','o',
];

export interface MentionOptions {
  /** Enable suffix-based inflection matching. */
  inflections?: boolean;
  /** Suffix list (order irrelevant — sorted automatically). */
  suffixes?: string[];
  /**
   * For feminine names ending in -a, also match the possessive -in paradigm:
   *   Mirjana → Mirjanin, Mirjanina, Mirjaninom, Mirjanine …
   * Rule: strip trailing 'a', append 'in' + optional short case ending.
   */
  feminineIn?: boolean;
}

/**
 * Build a RegExp that matches a character name and (optionally) its inflected
 * forms. Extracted so both countMentions and occurrence-finding can share it
 * without duplicating the construction logic.
 * The 'g' flag is always set; call with a fresh instance per use-site.
 */
export function buildMentionRegex(
  characterName: string,
  options: MentionOptions = {}
): RegExp {
  const {
    inflections = false,
    suffixes = DEFAULT_INFLECTION_SUFFIXES,
    feminineIn = false,
  } = options;

  const escaped = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (!inflections) {
    return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'giu');
  }

  const sorted = [...suffixes].sort((a, b) => b.length - a.length);
  const suffixPart = `(?:${sorted.join('|')})?`;
  let alternatives = `${escaped}${suffixPart}`;

  if (feminineIn && /a$/i.test(characterName)) {
    const stem = escaped.slice(0, -1);
    alternatives += `|${stem}in(?:om|og|oj|ih|im|a|o|e|i|u)?`;
  }

  return new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, 'giu');
}

/**
 * Count how many times a character name (and optionally its inflected forms)
 * appears in the novel content.
 */
export function countMentions(
  novelContent: string,
  characterName: string,
  options: MentionOptions = {}
): number {
  return (novelContent.match(buildMentionRegex(characterName, options)) ?? []).length;
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/**
 * Extract the text belonging to a heading section identified by level + text.
 * Returns the heading line itself through to (but not including) the next
 * heading of equal or higher rank, or the end of the file.
 * Returns an empty string when the heading is not found.
 */
export function extractSection(
  content: string,
  headingText: string,
  headingLevel: number
): string {
  const prefix = '#'.repeat(headingLevel) + ' ';
  const lines = content.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix) && lines[i].slice(prefix.length).trim() === headingText) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= headingLevel) { end = i; break; }
  }

  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under `folderPath`, sorted by directory
 * hierarchy then filename (alphabetically at each level).
 */
export function getAllMarkdownFiles(folderPath: string): string[] {
  const files: string[] = [];

  function traverse(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  traverse(folderPath);
  return files;
}
