import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { AnalysisStore } from '../dsm/analysisStore';
import { CanonManager, ENTITY_CATEGORIES }  from '../dsm/canonManager';
import { IndexBuilder }  from '../dsm/indexBuilder';
import { OverrideStore } from '../dsm/overrideStore';
import { ChapterAnalysis, ChapterEntity } from '../dsm/draftScriptTypes';
import { applyAutoApproval } from './dsmAnalyzeText';

const CANON_ENTITY_FILES = ['characters.json', 'locations.json', 'objects.json', 'groups.json'];

type RebuildMode = 'rebuild' | 'clear';

export async function regenerateIndexes(getRootFolder: () => string): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label:       '$(sync) Rebuild indexes',
        description: 'Rebuild all indexes, auto-approve new entities (same certainty as rescan)',
        mode:        'rebuild' as RebuildMode,
      },
      {
        label:       '$(trash) Clear canon + rebuild from scratch',
        description: 'Clear all canon entries, re-approve from analysis files — keeps signals',
        mode:        'clear' as RebuildMode,
      },
    ],
    {
      title:       'DSM: Regenerate Indexes',
      placeHolder: 'Choose what to rebuild',
    }
  );

  if (!choice) return false;

  const root = getRootFolder();
  const cfg  = vscode.workspace.getConfiguration('draftScript');
  const minCertainty   = cfg.get<number>('dsmRescanMinCertainty', 80);
  const mergeUncertain = cfg.get<boolean>('dsmRescanMergeUncertain', false);

  if (!fs.existsSync(path.join(root, '.draft-script', 'analysis', 'chapters'))) {
    vscode.window.showWarningMessage('DSM: No analysis files found — run a scan first.');
    return false;
  }

  await vscode.window.withProgress(
    {
      location:    vscode.ProgressLocation.Notification,
      title:       'DSM: Regenerating indexes…',
      cancellable: false,
    },
    async () => {
      const store = new AnalysisStore(root);
      const canon = new CanonManager(root);

      if (choice.mode === 'clear') {
        clearCanonEntries(root);
        // Reset all entity statuses to 'new' so they can be re-approved cleanly
        for (const analysis of store.readAll()) {
          resetEntityStatuses(analysis);
          store.write(analysis);
        }
      }

      // Re-apply auto-approval across all analysis files (same logic as rescan)
      // For 'clear' mode: canon is fresh so mergeUncertain has nothing to match against
      const canMerge = choice.mode === 'clear' ? false : mergeUncertain;
      for (const analysis of store.readAll()) {
        applyAutoApproval(analysis, canon, minCertainty, canMerge);
        store.write(analysis);
      }

      const builder = new IndexBuilder(root, store, canon, new OverrideStore(root));
      builder.buildAll();
    }
  );

  const label = choice.mode === 'clear'
    ? `Canon cleared and rebuilt from analysis files (certainty ≥ ${minCertainty}%).`
    : `Indexes rebuilt, new entities auto-approved (certainty ≥ ${minCertainty}%).`;
  vscode.window.showInformationMessage(`DSM: ${label}`);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearCanonEntries(root: string): void {
  const canonDir = path.join(root, '.draft-script', 'canon');
  if (!fs.existsSync(canonDir)) return;
  for (const file of CANON_ENTITY_FILES) {
    const filePath = path.join(canonDir, file);
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf-8');
    }
  }
  // signals.json is intentionally untouched
}

function resetEntityStatuses(analysis: ChapterAnalysis): void {
  for (const category of ENTITY_CATEGORIES) {
    const entities = (analysis as unknown as Record<string, ChapterEntity[]>)[category] ?? [];
    for (const entity of entities) {
      entity.status = 'new';
      delete entity.canonId;
      delete entity.possibleCanonId;
    }
  }
}
