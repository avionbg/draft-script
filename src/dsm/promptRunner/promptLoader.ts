import * as fs   from 'fs';
import * as path  from 'path';
import { PromptDefinition, PromptScope, PromptProvider, PromptOutputFormat, PromptOutputConfig, PromptContextBlockId, PromptLimits, PromptWindowConfig, VisibilityMode } from './types';

const PROMPTS_DIR = path.join('.draft-script', 'prompts');
const BUNDLED_PROMPTS_DIR = 'prompts';
const INTERNAL_PROMPT_FIELD = 'draft-script-internal';

// ─── YAML frontmatter parser ──────────────────────────────────────────────────

function coerce(s: string): unknown {
  const t = s.trim();
  if (t === 'true')  return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~' || t === '') return null;
  const n = Number(t);
  if (!isNaN(n) && t !== '') return n;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseYamlBlock(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const rootMatch = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (!rootMatch) { i++; continue; }

    const key    = rootMatch[1];
    const inline = rootMatch[2].trim();

    if (inline) {
      result[key] = coerce(inline);
      i++;
    } else {
      // Collect indented children
      const children: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const cl = lines[j];
        if (!cl.trim()) { j++; continue; }
        if (!cl.startsWith('  ') && !cl.startsWith('\t')) break;
        children.push(cl);
        j++;
      }

      if (!children.length) {
        i = j;
        continue;
      }

      const isListItem = (l: string) => l.trimStart().startsWith('- ') || l.trimStart().startsWith('* ');
      if (isListItem(children[0])) {
        // Array — accept both "- item" and "* item"
        result[key] = children
          .filter(isListItem)
          .map(l => coerce(l.trimStart().slice(2)));
      } else {
        // Nested object
        const obj: Record<string, unknown> = {};
        for (const child of children) {
          const cm = /^\s+([a-zA-Z_][\w-]*):\s*(.*)$/.exec(child);
          if (cm) obj[cm[1]] = coerce(cm[2]);
        }
        result[key] = obj;
      }
      i = j;
    }
  }

  return result;
}

function parseFrontmatter(text: string): { fm: Record<string, unknown>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { fm: parseYamlBlock(match[1]), body: match[2].trim() };
}

// ─── Normalization helpers ────────────────────────────────────────────────────

const VALID_SCOPES      = new Set<PromptScope>(['selection', 'sentence', 'chapter', 'manuscript']);
const VALID_PROVIDERS   = new Set<PromptProvider>(['default', 'vscode-lm', 'openai', 'ollama']);
const VALID_OUTPUTS     = new Set<PromptOutputFormat>(['markdown', 'json']);
const VALID_VISIBILITY  = new Set<VisibilityMode>(['all', 'upToChapter', 'previousChapters', 'currentChapterOnly']);
const VALID_CONTEXT_IDS = new Set<PromptContextBlockId>([
  'selectedText', 'chapterText', 'chapterMeta', 'chapterSummary',
  'overview', 'previousChapterOverview', 'nextChapterOverview',
  'characters', 'locations', 'objects', 'groups',
  'activeThreads', 'dormantThreads', 'activeContinuity',
  'signals', 'timeline', 'references', 'projectInstructions',
]);

function toScope(v: unknown): PromptScope | null {
  if (v === undefined || v === null) return 'chapter'; // default when omitted
  const s = String(v).trim();
  if (VALID_SCOPES.has(s as PromptScope)) return s as PromptScope;
  return null; // unknown — caller should warn and skip
}

function toProvider(v: unknown): PromptProvider | undefined {
  return VALID_PROVIDERS.has(v as PromptProvider) ? (v as PromptProvider) : undefined;
}

function toOutput(v: unknown): PromptOutputFormat | PromptOutputConfig | undefined {
  if (typeof v === 'string') {
    return VALID_OUTPUTS.has(v as PromptOutputFormat) ? (v as PromptOutputFormat) : undefined;
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const raw = v as Record<string, unknown>;
    const p   = typeof raw['path'] === 'string' ? raw['path'].trim() : '';
    if (!p) return undefined;
    const fmt = VALID_OUTPUTS.has(raw['format'] as PromptOutputFormat)
      ? raw['format'] as PromptOutputFormat
      : undefined;
    const cfg: PromptOutputConfig = { path: p };
    if (fmt) cfg.format = fmt;
    return cfg;
  }
  return undefined;
}

function toContextIds(v: unknown): PromptContextBlockId[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const valid = (v as unknown[])
    .map(s => String(s))
    .filter(s => VALID_CONTEXT_IDS.has(s as PromptContextBlockId));
  if (valid.length === 0) return undefined;
  if (valid.length !== v.length) {
    const invalid = (v as unknown[]).map(String).filter(s => !VALID_CONTEXT_IDS.has(s as PromptContextBlockId));
    console.warn(`[PromptRunner] Unknown context block IDs will be ignored: ${invalid.join(', ')}`);
  }
  return valid as PromptContextBlockId[];
}

function toLimits(v: unknown): PromptLimits | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: PromptLimits = {};
  for (const [k, val] of Object.entries(raw)) {
    if (typeof val === 'number') (out as Record<string, number>)[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function toVisibility(v: unknown): VisibilityMode | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (VALID_VISIBILITY.has(s as VisibilityMode)) return s as VisibilityMode;
  console.warn(`[PromptRunner] Unknown visibility mode "${s}" — will default to "all"`);
  return undefined;
}

function toWindow(v: unknown): { previousChapters?: number; nextChapters?: number } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: { previousChapters?: number; nextChapters?: number } = {};
  if (typeof raw['previousChapters'] === 'number') out.previousChapters = raw['previousChapters'];
  if (typeof raw['nextChapters']     === 'number') out.nextChapters     = raw['nextChapters'];
  return (out.previousChapters != null || out.nextChapters != null) ? out : undefined;
}

// ─── File-level parse ─────────────────────────────────────────────────────────

function parsePromptFile(filePath: string): PromptDefinition | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    console.warn(`[PromptRunner] Could not read: ${filePath}`);
    return null;
  }

  const parsed = parseFrontmatter(text);
  if (!parsed) {
    // Legacy DSM analysis prompt files predate prompt frontmatter and are read
    // directly by the DSM analyzer, not by the generic Prompt Runner registry.
    if (path.basename(filePath) === 'dsm-analysis.md') return null;
    console.warn(`[PromptRunner] No frontmatter found in: ${filePath}`);
    return null;
  }

  const { fm, body } = parsed;
  if (typeof fm[INTERNAL_PROMPT_FIELD] === 'string') return null;

  const id    = typeof fm['id']    === 'string' ? fm['id'].trim()    : '';
  const title = typeof fm['title'] === 'string' ? fm['title'].trim() : '';

  if (!id || !title) {
    console.warn(`[PromptRunner] Missing required fields (id, title) in: ${filePath}`);
    return null;
  }

  if (!body.trim()) {
    console.warn(`[PromptRunner] Empty prompt body in: ${filePath}`);
    return null;
  }

  const scope = toScope(fm['scope']);
  if (scope === null) {
    console.warn(`[PromptRunner] Unknown scope "${fm['scope']}" in: ${filePath} — skipping`);
    return null;
  }

  const enabled = fm['enabled'] !== false; // default true
  if (!enabled) return null;

  return {
    id,
    title,
    scope,
    body,
    filePath,
    menuTitle:   typeof fm['menuTitle']   === 'string' ? fm['menuTitle']   : undefined,
    provider:    toProvider(fm['provider']),
    output:      toOutput(fm['output']),
    visibility:  toVisibility(fm['visibility']),
    context:     toContextIds(fm['context']),
    limits:      toLimits(fm['limits']),
    window:      toWindow(fm['window']),
    description: typeof fm['description'] === 'string' ? fm['description'] : undefined,
    enabled:     true,
    writer:      fm['writer'] === true ? true : undefined,
    lineEdit:    fm['line-edit'] === true ? true : undefined,
    lineEditType: typeof fm['line-edit-type'] === 'string' ? fm['line-edit-type'] : undefined,
  };
}

// ─── Directory scan ───────────────────────────────────────────────────────────

export function loadPrompts(rootFolder: string): Map<string, PromptDefinition> {
  const map = new Map<string, PromptDefinition>();
  loadPromptDir(path.join(rootFolder, PROMPTS_DIR), map, 'project');
  loadPromptDir(path.join(extensionRoot(), BUNDLED_PROMPTS_DIR), map, 'bundled');
  return map;
}

function extensionRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function loadPromptDir(dir: string, map: Map<string, PromptDefinition>, source: 'project' | 'bundled'): void {
  if (!fs.existsSync(dir)) {
    if (source === 'project') {
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch { /* ignore */ }
    }
    return;
  }

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const def = parsePromptFile(path.join(dir, entry.name));
    if (!def) continue;

    if (map.has(def.id)) {
      console.warn(`[PromptRunner] Duplicate prompt id "${def.id}" in ${entry.name} — skipped.`);
      continue;
    }
    map.set(def.id, def);
  }
}
