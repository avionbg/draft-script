import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AnalysisStore } from '../dsm/analysisStore';
import { CanonManager } from '../dsm/canonManager';
import { IndexBuilder } from '../dsm/indexBuilder';
import { OverrideStore } from '../dsm/overrideStore';
import { ThreadIndexItem } from '../dsm/draftScriptTypes';

type ThreadAction =
  | 'confirmSuggestedResolution'
  | 'rejectSuggestedResolution'
  | 'markResolved'
  | 'reopen'
  | 'markActive'
  | 'linkParent';

export async function runThreadAction(action: ThreadAction, getRootFolder: () => string): Promise<void> {
  const root = getRootFolder();
  const thread = await pickThread(root, action);
  if (!thread) return;

  const overrides = new OverrideStore(root);
  const patch: Parameters<OverrideStore['writeIndex']>[2] = {};

  if (action === 'confirmSuggestedResolution') {
    if (!thread.suggestedStatus) {
      vscode.window.showWarningMessage('DSM: This thread has no suggested status to confirm.');
      return;
    }
    patch.status = thread.suggestedStatus;
    patch.suggestedStatus = null;
    patch.suggestedUpdateType = null;
    patch.suggestedResolutionType = null;
    patch.needsReview = false;
    if (thread.suggestedStatus === 'resolved') {
      patch.resolvedChapter = thread.lastSeenChapter ?? thread.resolvedChapter ?? null;
      patch.unresolvedQuestion = null;
    }
  } else if (action === 'rejectSuggestedResolution') {
    patch.suggestedStatus = null;
    patch.suggestedUpdateType = null;
    patch.suggestedResolutionType = null;
    patch.needsReview = false;
  } else if (action === 'markResolved') {
    patch.status = 'resolved';
    patch.resolvedChapter = thread.lastSeenChapter ?? thread.resolvedChapter ?? null;
    patch.unresolvedQuestion = null;
    patch.needsReview = false;
  } else if (action === 'reopen') {
    patch.status = 'open';
    patch.resolvedChapter = null;
    patch.needsReview = false;
  } else if (action === 'markActive') {
    patch.status = 'active';
    patch.needsReview = false;
  } else if (action === 'linkParent') {
    const parent = await pickThread(root, action, thread.id);
    if (!parent) return;
    patch.parentThread = parent.id;
  }

  overrides.writeIndex('threads', thread.id, patch);
  rebuild(root);
  vscode.window.showInformationMessage(`DSM: Updated thread "${thread.title}".`);
}

function readThreads(root: string): ThreadIndexItem[] {
  const file = path.join(root, '.draft-script', 'indexes', 'threads.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(raw) ? raw as ThreadIndexItem[] : [];
  } catch {
    return [];
  }
}

async function pickThread(root: string, action: ThreadAction, excludeId?: string): Promise<ThreadIndexItem | undefined> {
  const threads = readThreads(root).filter(t => t.id !== excludeId);
  if (!threads.length) {
    vscode.window.showWarningMessage('DSM: No indexed threads found.');
    return undefined;
  }
  const items = threads.map(t => ({
    label: t.title,
    description: describeThread(t),
    thread: t,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: action === 'linkParent' ? 'DSM: Select Parent Thread' : 'DSM: Select Thread',
    placeHolder: 'Choose a thread',
  });
  return picked?.thread;
}

function describeThread(t: ThreadIndexItem): string {
  const bits: string[] = [t.status];
  if (t.suggestedStatus) bits.push(`suggested: ${t.suggestedStatus}`);
  if (t.lastSeenChapter != null) bits.push(`Ch. ${t.lastSeenChapter}`);
  return bits.join(' | ');
}

function rebuild(root: string): void {
  const store = new AnalysisStore(root);
  const canon = new CanonManager(root);
  const overrides = new OverrideStore(root);
  new IndexBuilder(root, store, canon, overrides).buildAll();
}
