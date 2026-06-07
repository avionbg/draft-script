import * as fs   from 'fs';
import * as path from 'path';
import { CanonOverride, IndexOverride } from './draftScriptTypes';

const OVERRIDES_DIR = path.join('.draft-script', 'overrides');

export class OverrideStore {
  private readonly dir: string;

  constructor(private readonly rootFolder: string) {
    this.dir = path.join(rootFolder, OVERRIDES_DIR);
  }

  private read<T>(filename: string): Record<string, T> {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir, filename), 'utf-8')
      ) as Record<string, T>;
    } catch {
      return {};
    }
  }

  private write<T>(filename: string, data: Record<string, T>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      path.join(this.dir, filename),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  }

  // ---------------------------------------------------------------------------
  // Canon overrides  (.draft-script/overrides/canon.{category}.json)
  // ---------------------------------------------------------------------------

  readCanon(category: string): Record<string, CanonOverride> {
    return this.read<CanonOverride>(`canon.${category}.json`);
  }

  writeCanon(category: string, id: string, patch: Partial<CanonOverride>): void {
    const all  = this.readCanon(category);
    const prev = all[id] ?? {};
    const next: CanonOverride = { ...prev };
    if (patch.title       !== undefined) next.title       = patch.title       || undefined;
    if (patch.description !== undefined) next.description = patch.description || undefined;
    if (patch.aliases     !== undefined) next.aliases     = patch.aliases;
    if (patch.notes       !== undefined) next.notes       = patch.notes       || undefined;
    if (patch.tags        !== undefined) next.tags        = patch.tags;
    // Remove undefined keys
    (Object.keys(next) as (keyof CanonOverride)[]).forEach(k => {
      if (next[k] === undefined) delete next[k];
    });
    if (Object.keys(next).length === 0) {
      delete all[id];
    } else {
      all[id] = next;
    }
    this.write(`canon.${category}.json`, all);
  }

  clearCanon(category: string, id: string): void {
    const all = this.readCanon(category);
    delete all[id];
    this.write(`canon.${category}.json`, all);
  }

  // ---------------------------------------------------------------------------
  // Index overrides  (.draft-script/overrides/indexes.{name}.json)
  // ---------------------------------------------------------------------------

  readIndex(name: string): Record<string, IndexOverride> {
    return this.read<IndexOverride>(`indexes.${name}.json`);
  }

  writeIndex(name: string, id: string, patch: Partial<IndexOverride>): void {
    const all  = this.readIndex(name);
    const prev = all[id] ?? {};
    all[id]    = { ...prev, ...patch };
    // Remove keys explicitly set to undefined/empty-string
    (Object.keys(all[id]) as (keyof IndexOverride)[]).forEach(k => {
      if (all[id][k] === undefined) delete (all[id] as Record<string, unknown>)[k];
    });
    if (Object.keys(all[id]).length === 0) delete all[id];
    this.write(`indexes.${name}.json`, all);
  }

  clearIndex(name: string, id: string): void {
    const all = this.readIndex(name);
    delete all[id];
    this.write(`indexes.${name}.json`, all);
  }
}
