import * as fs   from 'fs';
import * as path from 'path';
import { Signal } from './draftScriptTypes';
import { AnalysisStore } from './analysisStore';
import { readBundledDsmAnalysisPromptFile, readDsmPromptResource, stripPromptFrontmatter } from './promptResources';

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

function builtInPrompt(): string {
  return readDsmPromptResource('analysis.md');
}

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

  /** Creates dsm-analysis.md from the built-in template if the file does not yet exist. */
  ensurePromptFile(): void {
    if (!fs.existsSync(this.promptFile)) {
      const dir = path.dirname(this.promptFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.promptFile, readBundledDsmAnalysisPromptFile(), 'utf-8');
    }
  }

  readPromptTemplate(): string {
    try {
      return stripPromptFrontmatter(fs.readFileSync(this.promptFile, 'utf-8'));
    } catch {
      return builtInPrompt();
    }
  }
}
