import * as vscode from 'vscode';
import { LlmProvider } from './types';

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes

// ---------------------------------------------------------------------------
// VS Code LM (Copilot)
// ---------------------------------------------------------------------------

export class VSCodeLmProvider implements LlmProvider {
  id: string;

  constructor(
    private readonly timeoutMs:        number = DEFAULT_TIMEOUT_MS,
    private readonly configuredModelId: string = 'first',
  ) {
    this.id = configuredModelId !== 'first' ? `vscode-lm (${configuredModelId})` : 'vscode-lm';
  }

  async complete(prompt: string): Promise<string> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
      throw new Error(
        'DSM: No VS Code language model available.\n\n' +
        'Make sure GitHub Copilot is installed, signed in, and enabled in the current VS Code profile.'
      );
    }

    let model = models[0];
    if (this.configuredModelId !== 'first') {
      const found = models.find(m => m.id === this.configuredModelId);
      if (!found) {
        void vscode.window.showWarningMessage(
          `DSM: Configured model "${this.configuredModelId}" is not available. Falling back to "${models[0].name}".`
        );
      } else {
        model = found;
      }
    }

    this.id = `vscode-lm (${model.name})`;
    const cts = new vscode.CancellationTokenSource();

    const timeoutId = setTimeout(() => {
      cts.cancel();
    }, this.timeoutMs);

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );

      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
      }
      return text;
    } finally {
      clearTimeout(timeoutId);
      cts.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LlmProvider {
  id: string;

  constructor(
    private readonly apiKey:     string,
    private readonly model:      string = 'gpt-4.1-mini',
    private readonly timeoutMs:  number = DEFAULT_TIMEOUT_MS
  ) {
    this.id = `openai (${model})`;
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        'DSM: OpenAI API key not configured. Set draftScript.dsmOpenAiApiKey in your workspace settings.'
      );
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body:   JSON.stringify({ model: this.model, input: prompt }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`DSM: OpenAI error ${res.status}: ${msg}`);
      }

      const data = await res.json() as { output_text?: string };
      return data.output_text ?? '';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`DSM: OpenAI request timed out after ${this.timeoutMs / 1000}s. Try a shorter selection or increase draftScript.dsmTimeoutSeconds.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

export class OllamaProvider implements LlmProvider {
  id: string;

  constructor(
    private readonly baseUrl:    string = 'http://localhost:11434',
    private readonly model:      string = 'llama3',
    private readonly timeoutMs:  number = DEFAULT_TIMEOUT_MS
  ) {
    this.id = `ollama (${model})`;
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: this.model, prompt, stream: false }),
        signal:  controller.signal,
      });

      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`DSM: Ollama error ${res.status}: ${msg}`);
      }

      const data = await res.json() as { response?: string };
      return data.response ?? '';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`DSM: Ollama request timed out after ${this.timeoutMs / 1000}s. Try a shorter selection or increase draftScript.dsmTimeoutSeconds.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Mock (for testing without an API)
// ---------------------------------------------------------------------------

export class MockProvider implements LlmProvider {
  id = 'mock';

  async complete(_prompt: string): Promise<string> {
    return JSON.stringify({
      characters: [
        { name: 'Elara', aliases: ['the navigator'], description: 'Navigator keeping the crew on course.', confidence: 0.95 },
        { name: 'Denn',  aliases: [],                description: 'Ship engineer, skeptical of the mission.', confidence: 0.98 },
      ],
      locations: [
        { name: 'The Crossing', aliases: [], description: 'Open-water route between Calloway Point and the destination port.', confidence: 0.85 },
      ],
      objects:         [],
      groups:          [],
      threads:         [{ title: 'The sealed hold', description: 'No one aboard has been told what the cargo actually is.', type: 'mystery', status: 'open', updateType: 'new', resolutionType: 'none', confidence: 0.75 }],
      timelineEvents:  [{ description: 'Secondary engine drive running hot since before Calloway Point.', confidence: 0.90 }],
      continuityNotes: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLlmProvider(cfg: vscode.WorkspaceConfiguration): LlmProvider {
  const id        = cfg.get<string>('dsmProvider', 'vscode-lm');
  const timeoutMs = cfg.get<number>('dsmTimeoutSeconds', 180) * 1000;

  switch (id) {
    case 'openai':
      return new OpenAIProvider(
        cfg.get<string>('dsmOpenAiApiKey', ''),
        cfg.get<string>('dsmOpenAiModel',  'gpt-4.1-mini'),
        timeoutMs
      );
    case 'ollama':
      return new OllamaProvider(
        cfg.get<string>('dsmOllamaUrl',   'http://localhost:11434'),
        cfg.get<string>('dsmOllamaModel', 'llama3'),
        timeoutMs
      );
    case 'mock':
      return new MockProvider();
    case 'vscode-lm':
    default:
      return new VSCodeLmProvider(timeoutMs, cfg.get<string>('dsmVsCodeLmModel', 'first'));
  }
}

// ---------------------------------------------------------------------------
// Model pickers
// ---------------------------------------------------------------------------

export async function pickOllamaModel(): Promise<void> {
  const cfg     = vscode.workspace.getConfiguration('draftScript');
  const baseUrl = cfg.get<string>('dsmOllamaUrl', 'http://localhost:11434').replace(/\/$/, '');

  let models: string[];
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { models?: { name: string }[] };
    models = (data.models ?? []).map(m => m.name).filter(Boolean);
  } catch (err) {
    vscode.window.showErrorMessage(
      `DSM: Could not reach Ollama at ${baseUrl}. ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!models.length) {
    vscode.window.showWarningMessage(`DSM: Ollama at ${baseUrl} returned no models.`);
    return;
  }

  const current = cfg.get<string>('dsmOllamaModel', 'llama3');
  const items   = models.map(name => ({
    label:       name,
    description: name === current ? '(current)' : undefined,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:       'DSM: Select Ollama Model',
    placeHolder: 'Choose a model for DSM analysis',
    matchOnDescription: true,
  });

  if (!picked) return;
  await cfg.update('dsmOllamaModel', picked.label, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`DSM: Ollama model set to ${picked.label}`);
}

// ---------------------------------------------------------------------------
// Model picker (QuickPick for vscode-lm)
// ---------------------------------------------------------------------------

export async function pickVsCodeLmModel(): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    vscode.window.showWarningMessage(
      'DSM: No VS Code language models available. Make sure GitHub Copilot is installed and signed in.'
    );
    return;
  }

  // Deduplicate by id (same id can appear under multiple vendors)
  const seen  = new Set<string>();
  const items: (vscode.QuickPickItem & { modelId: string })[] = [
    { label: 'First available', description: 'Use the first model returned by the API', modelId: 'first' },
  ];
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      items.push({ label: m.name, description: m.id, modelId: m.id });
    }
  }

  const cfg     = vscode.workspace.getConfiguration('draftScript');
  const current = cfg.get<string>('dsmVsCodeLmModel', 'auto');

  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { modelId: string }>();
  qp.title              = 'DSM: Select VS Code Language Model';
  qp.placeholder        = 'Choose a model for DSM analysis';
  qp.matchOnDescription = true;
  qp.items              = items;
  qp.activeItems        = items.filter(i => i.modelId === current);

  const picked = await new Promise<(vscode.QuickPickItem & { modelId: string }) | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.activeItems[0]); qp.dispose(); });
    qp.onDidHide(()    => { resolve(undefined);          qp.dispose(); });
    qp.show();
  });

  if (!picked) return;
  await cfg.update('dsmVsCodeLmModel', picked.modelId, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(
    `DSM model set to: ${picked.label}${picked.modelId !== 'first' ? ` (${picked.modelId})` : ''}`
  );
}
