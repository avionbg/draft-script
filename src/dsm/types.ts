// Runtime-only types that don't belong in draftScriptTypes (which describes storage).

export interface LlmProvider {
  id: string;
  complete(prompt: string): Promise<string>;
}

/** Runtime-only chapter reference — filePath is needed for "scan next" but never persisted. */
export interface ChapterSource {
  filePath:   string;
  title:      string;
  chapterNum: number | undefined;
}

export class DsmParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'DsmParseError';
  }
}
