import * as fs   from 'fs';
import * as path from 'path';
import { CanonEntry, CanonOverride } from './draftScriptTypes';
export { CanonEntry } from './draftScriptTypes';

const CANON_DIR = path.join('.draft-script', 'canon');

export class CanonManager {
  private readonly canonDir: string;

  constructor(private readonly rootFolder: string) {
    this.canonDir = path.join(rootFolder, CANON_DIR);
  }

  read(category: string): CanonEntry[] {
    const file = path.join(this.canonDir, `${category}.json`);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as CanonEntry[]) : [];
    } catch {
      return [];
    }
  }

  readEffective(category: string, overrides: Record<string, CanonOverride> = {}): CanonEntry[] {
    const seen = new Set<string>();
    const entries = this.read(category).map(entry => {
      seen.add(entry.id);
      return composeEffectiveEntry(entry, overrides[entry.id]);
    });

    for (const [id, override] of Object.entries(overrides)) {
      if (seen.has(id) || !override.userCreated || !override.title) continue;
      entries.push({
        id,
        name:        override.title,
        aliases:     override.aliases ?? [],
        description: override.description ?? '',
        approvedAt:  '',
      });
    }

    return entries;
  }

  write(category: string, entries: CanonEntry[]): void {
    fs.mkdirSync(this.canonDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.canonDir, `${category}.json`),
      JSON.stringify(entries, null, 2),
      'utf-8'
    );
  }

  addEntry(category: string, entry: Omit<CanonEntry, 'approvedAt'>): CanonEntry {
    const existing = this.read(category);
    // Avoid duplicates by id
    if (existing.some(e => e.id === entry.id)) {
      return existing.find(e => e.id === entry.id)!;
    }
    const full: CanonEntry = { ...entry, approvedAt: new Date().toISOString() };
    this.write(category, [...existing, full]);
    return full;
  }

  updateEntry(
    category: string,
    id:       string,
    updates:  { name?: string; aliases?: string[]; description?: string },
  ): void {
    const entries = this.read(category);
    const idx     = entries.findIndex(e => e.id === id);
    if (idx === -1) return;
    entries[idx] = { ...entries[idx], ...updates, modifiedAt: new Date().toISOString() };
    this.write(category, entries);
  }

  removeEntry(category: string, id: string): void {
    this.write(category, this.read(category).filter(e => e.id !== id));
  }

  /** Returns the canon entry that matches the given name or any of its aliases.
   *  Matching is done on normalized IDs (lowercase, no diacritics). */
  findMatch(name: string, aliases: string[]): CanonEntry | undefined {
    const allNames = [name, ...aliases].map(normalizeId);
    for (const category of ENTITY_CATEGORIES) {
      const entries = this.read(category);
      for (const entry of entries) {
        const entryIds = [entry.name, ...entry.aliases].map(normalizeId);
        if (allNames.some(n => entryIds.includes(n))) return entry;
      }
    }
    return undefined;
  }

  /** Find a canon entry within a specific category. */
  findInCategory(category: string, name: string, aliases: string[]): CanonEntry | undefined {
    const allNames = [name, ...aliases].map(normalizeId);
    for (const entry of this.read(category)) {
      const entryIds = [entry.name, ...entry.aliases].map(normalizeId);
      if (allNames.some(n => entryIds.includes(n))) return entry;
    }
    return undefined;
  }

  findEffectiveInCategory(
    category: string,
    name: string,
    aliases: string[],
    overrides: Record<string, CanonOverride> = {},
  ): CanonEntry | undefined {
    const allNames = [name, ...aliases].map(normalizeId);
    for (const entry of this.readEffective(category, overrides)) {
      const entryIds = [entry.name, ...entry.aliases].map(normalizeId);
      if (allNames.some(n => entryIds.includes(n))) return entry;
    }
    return undefined;
  }
}

export const ENTITY_CATEGORIES = ['characters', 'locations', 'objects', 'groups'] as const;
export type EntityCategory = typeof ENTITY_CATEGORIES[number];

function composeEffectiveEntry(entry: CanonEntry, override?: CanonOverride): CanonEntry {
  if (!override) return entry;
  return {
    ...entry,
    name:        override.title       ?? entry.name,
    aliases:     override.aliases     ?? entry.aliases,
    description: override.description ?? entry.description,
  };
}

export function normalizeId(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
}
