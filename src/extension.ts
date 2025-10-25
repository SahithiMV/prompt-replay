import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { Store } from './store';
import { TimelinePanel } from './timelinePanel';
import { getGitApi, primaryRepo, headSha, collectWorkingDiff, getFileAtRef } from './git';
import { PromptEvent } from './types';

console.log('[Prompt Replay] activate()');

// Track files edited since last checkpoint
const touchedSinceCheckpoint = new Set<string>();
function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
}

async function exists(uri: vscode.Uri | undefined): Promise<boolean> {
  if (!uri) return false;
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new Store(context);

  // Track edits between checkpoint and logPrompt
  const editListener = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!store.session.lastCheckpointSha) return;   // only while a checkpoint is active
    if (e.document.uri.scheme !== 'file') return;   // ignore virtual docs
    const rp = relPath(e.document.uri);
    if (rp) touchedSinceCheckpoint.add(rp);
  });
  context.subscriptions.push(editListener);

  // --- Commands ---

  const startSession = vscode.commands.registerCommand('promptReplay.startSession', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('Open a folder/workspace first.');
      return;
    }
    await store.ensureDir();
    store.session = { active: true, repoRoot: ws.uri.fsPath, lastCheckpointSha: undefined };
    vscode.window.showInformationMessage('Prompt Replay: session started.');
  });

  const createCheckpoint = vscode.commands.registerCommand('promptReplay.createCheckpoint', async () => {
    const api = await getGitApi();
    const repo = primaryRepo(api);
    const sha = headSha(repo) ?? `:working:${Date.now()}`;
    if (!store.session.active) {
      await vscode.commands.executeCommand('promptReplay.startSession');
    }
    store.session = { ...store.session, lastCheckpointSha: sha };
    touchedSinceCheckpoint.clear();
    vscode.window.showInformationMessage(`Prompt Replay: checkpoint created (${sha.slice(0, 8)})`);
  });

  const logPrompt = vscode.commands.registerCommand('promptReplay.logPrompt', async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Enter the AI prompt you used',
      validateInput: v => (v ? undefined : 'Prompt required')
    });
    if (!prompt) return;

    const responsePreview = await vscode.window.showInputBox({ prompt: 'Optional: short response preview (or leave empty)' });
    const tagsStr = await vscode.window.showInputBox({ prompt: 'Optional: tags (comma-separated, e.g. bug fix, refactor)' });
    const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const cfg = vscode.workspace.getConfiguration('promptReplay');
    const maxEvents = cfg.get<number>('maxEvents', 2000);

    const api = await getGitApi();
    const repo = primaryRepo(api);
    let diffs = await collectWorkingDiff(repo);

    const repoRoot = store.session.repoRoot ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
    const checkpointRef = store.session.lastCheckpointSha;

    // --- Decide what to include ---
    if (checkpointRef) {
      if (touchedSinceCheckpoint.size === 0) {
        vscode.window.showInformationMessage('Prompt Replay: no edits detected since checkpoint — nothing to log.');
        return;
      }
      const touched = new Set(Array.from(touchedSinceCheckpoint));
      diffs = diffs.filter(d => touched.has(d.path.replace(/\\/g, '/')));
      if (diffs.length === 0) {
        vscode.window.showInformationMessage('Prompt Replay: no changes detected in touched files — nothing to log.');
        return;
      }
    } else {
      if (diffs.length === 0) {
        vscode.window.showInformationMessage('Prompt Replay: no changes in the working tree — nothing to log.');
        return;
      }
    }

    // Build event scaffold first (id needed for snapshot path)
    const ev: PromptEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      prompt,
      responsePreview: responsePreview || undefined,
      repoRoot,
      beforeRef: checkpointRef,
      afterRef: 'WORKING',
      filesChanged: diffs.map(d => d.path),
      diffUris: [],   // fill below
      tags
    };

    // --- Create stable snapshots for BOTH sides so diffs/restores are reliable later ---
    // LEFT = content at checkpoint (or empty if NEW)
    // RIGHT = content at log time (or empty + mark deleted)
    const snapshotsDir = vscode.Uri.file(path.join(repoRoot, '.promptreplay', 'snapshots', ev.id));
    try { await vscode.workspace.fs.createDirectory(snapshotsDir); } catch {}

    const beforeDir = vscode.Uri.file(path.join(snapshotsDir.fsPath, '__before__'));
    const afterDir  = vscode.Uri.file(path.join(snapshotsDir.fsPath, '__after__'));
    try { await vscode.workspace.fs.createDirectory(beforeDir); } catch {}
    try { await vscode.workspace.fs.createDirectory(afterDir); } catch {}

    const leftSnapUris: Record<string, vscode.Uri> = {};
    const rightSnapUris: Record<string, vscode.Uri> = {};
    const ops: Record<string, 'added' | 'modified' | 'deleted'> = {};

    for (const d of diffs) {
      const rel = d.path.replace(/\\/g, '/');

      // LEFT snapshot (checkpoint ref)
      const leftText = checkpointRef ? await getFileAtRef(repoRoot, checkpointRef, rel) : undefined;
      const leftSnap = vscode.Uri.file(path.join(beforeDir.fsPath, rel));
      try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(leftSnap.fsPath))); } catch {}
      if (leftText !== undefined) {
        await vscode.workspace.fs.writeFile(leftSnap, Buffer.from(leftText, 'utf8'));
      } else {
        await vscode.workspace.fs.writeFile(leftSnap, Buffer.alloc(0)); // NEW file => empty left
      }
      leftSnapUris[rel] = leftSnap;

      // RIGHT snapshot (current working content or deleted)
      const target = vscode.Uri.file(path.join(repoRoot, rel));
      const rightSnap = vscode.Uri.file(path.join(afterDir.fsPath, rel));
      try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(rightSnap.fsPath))); } catch {}

      const targetExists = await exists(target);
      if (targetExists) {
        const buf = await vscode.workspace.fs.readFile(target);
        await vscode.workspace.fs.writeFile(rightSnap, buf);
        ops[rel] = leftText === undefined ? 'added' : 'modified';
      } else {
        await vscode.workspace.fs.writeFile(rightSnap, Buffer.alloc(0));
        ops[rel] = 'deleted';
      }
      rightSnapUris[rel] = rightSnap;
    }

    // Use our snapshots for diff URIs so they're stable for later restore
    ev.diffUris = diffs.map(d => {
      const rel = d.path.replace(/\\/g, '/');
      return {
        path: rel,
        left: leftSnapUris[rel]?.toString(),
        right: rightSnapUris[rel]?.toString(),
        op: ops[rel] as any
      } as any;
    });

    // Persist event
    await store.appendEvent(ev, maxEvents);

    // Reset checkpoint & touched set so the next one is explicit
    touchedSinceCheckpoint.clear();
    store.session = { ...store.session, lastCheckpointSha: undefined };

    vscode.window.showInformationMessage(`Prompt Replay: logged prompt with ${ev.filesChanged.length} changed file(s).`);
  });

  const openTimeline = vscode.commands.registerCommand('promptReplay.openTimeline', async () => {
    const panel = TimelinePanel.createOrShow(context);
    let eventsAll = await store.readEvents();
    panel.setEvents(eventsAll);

    panel.onMessage(async (message) => {
      try {
        if (message.type === 'openDiff') {
          const left = message.left ? vscode.Uri.parse(message.left) : undefined;
          const right = message.right ? vscode.Uri.parse(message.right) : undefined;
          if (left && right) {
            vscode.commands.executeCommand('vscode.diff', left, right, message.title || 'Diff');
          } else if (right) {
            vscode.window.showTextDocument(right);
          } else if (left) {
            vscode.window.showTextDocument(left);
          } else {
            vscode.window.showWarningMessage('No diff to open for this item.');
          }
          return;
        }

        if (message.type === 'search') {
          const q: string = (message.q || '').toLowerCase().trim();
          eventsAll = await store.readEvents(); // refresh in case of recent logs
          const filtered = !q ? eventsAll : eventsAll.filter(ev =>
            ev.prompt.toLowerCase().includes(q) ||
            ev.filesChanged.some(f => f.toLowerCase().includes(q)) ||
            (ev.tags ?? []).some(t => t.toLowerCase().includes(q))
          );
          TimelinePanel.current?.setEvents(filtered);
          return;
        }

        if (message.type === 'restoreEvent') {
          const id = String(message.id || '');
          const side: 'after' | 'before' = (message.side === 'before' ? 'before' : 'after'); // default AFTER
          if (!id) { vscode.window.showWarningMessage('Missing event id.'); return; }

          // find the event
          const all = await store.readEvents();
          const ev = all.find(e => e.id === id);
          if (!ev) { vscode.window.showWarningMessage('Event not found.'); return; }

          const prettySide = side === 'after' ? 'AFTER (state at log time)' : 'BEFORE (state at checkpoint)';
          const confirm = await vscode.window.showWarningMessage(
            `Restore ${ev.filesChanged.length} file(s) to ${prettySide}? This will overwrite your working copies.`,
            { modal: true },
            'Restore'
          );
          if (confirm !== 'Restore') return;

          const root = ev.repoRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          if (!root) { vscode.window.showWarningMessage('Workspace root not found.'); return; }

          // --- Pre-restore backup so we can Undo ---
          const backupId = `backup-${Date.now()}`;
          const backupDir = vscode.Uri.file(path.join(root, '.promptreplay', 'restore_backups', backupId));
          const backupBeforeDir = vscode.Uri.file(path.join(backupDir.fsPath, 'before'));
          try { await vscode.workspace.fs.createDirectory(backupBeforeDir); } catch {}

          type BackupEntry = { path: string; existed: boolean; };
          const manifest: BackupEntry[] = [];

          // Record and copy current file state for all target files
          for (const d of ev.diffUris || []) {
            const rel = d.path;
            const target = vscode.Uri.file(path.join(root, rel));
            const entry: BackupEntry = { path: rel, existed: false };
            try {
              let stat: vscode.FileStat | undefined;
                try {
                  stat = await vscode.workspace.fs.stat(target);
                } catch {
                  stat = undefined;
                }
              if (stat) {
                entry.existed = true;
                const backupTarget = vscode.Uri.file(path.join(backupBeforeDir.fsPath, rel));
                try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(backupTarget.fsPath))); } catch {}
                const buf = await vscode.workspace.fs.readFile(target);
                await vscode.workspace.fs.writeFile(backupTarget, buf);
              }
            } catch {
              // ignore, leave existed=false
            }
            manifest.push(entry);
          }

          // Save manifest
          const manifestUri = vscode.Uri.file(path.join(backupDir.fsPath, 'manifest.json'));
          await vscode.workspace.fs.writeFile(manifestUri, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

          // --- Apply snapshot from the chosen side ---
          let restored = 0, deleted = 0, skipped = 0, errors = 0;

          for (const d of ev.diffUris || []) {
            const rel = d.path;
            const target = vscode.Uri.file(path.join(root, rel));

            try {
              const leftStr = d.left || '';
              const rightStr = d.right || '';
              const leftUri  = leftStr  ? vscode.Uri.parse(leftStr)  : undefined;
              const rightUri = rightStr ? vscode.Uri.parse(rightStr) : undefined;
              const op = (d as any).op as string | undefined;

              // choose which snapshot to apply
              // AFTER: write right (except when op=deleted => delete)
              // BEFORE: write left (except when op=added   => delete)
              let snapshotToWrite: vscode.Uri | undefined;
              let shouldDelete = false;

              if (side === 'after') {
                shouldDelete = (op === 'deleted');
                snapshotToWrite = shouldDelete ? undefined : rightUri;
              } else { // 'before'
                shouldDelete = (op === 'added');
                snapshotToWrite = shouldDelete ? undefined : leftUri;
              }

              // Ensure we are using our on-disk snapshots
              const expectedBase = path.join(root, '.promptreplay', 'snapshots', id);
              if (!shouldDelete && (!snapshotToWrite || snapshotToWrite.scheme !== 'file' || !snapshotToWrite.fsPath.startsWith(expectedBase))) {
                skipped++;
                continue;
              }

              if (shouldDelete) {
                try {
                  await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
                  deleted++;
                } catch {
                  skipped++;
                }
              } else {
                const buf = await vscode.workspace.fs.readFile(snapshotToWrite!);
                try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath))); } catch {}
                await vscode.workspace.fs.writeFile(target, buf);
                restored++;
              }
            } catch {
              errors++;
            }
          }

          // Offer Undo right away
          const undoAction = 'Undo';
          const summary = `Prompt Replay: restore (${side.toUpperCase()}) — ${restored} restored, ${deleted} deleted, ${skipped} skipped${errors ? `, ${errors} errors` : ''}.`;
          const choice = await vscode.window.showInformationMessage(summary, undoAction);

          // lightweight, inline undo
          if (choice === undoAction) {
            let uRestored = 0, uDeleted = 0, uErrors = 0;
            try {
              const raw = await vscode.workspace.fs.readFile(manifestUri);
              const manifestParsed = JSON.parse(Buffer.from(raw).toString('utf8')) as BackupEntry[];
              for (const entry of manifestParsed) {
                const rel = entry.path;
                const target = vscode.Uri.file(path.join(root, rel));
                const backupFile = vscode.Uri.file(path.join(backupBeforeDir.fsPath, rel));
                try {
                  if (entry.existed) {
                    const buf = await vscode.workspace.fs.readFile(backupFile);
                    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath))); } catch {}
                    await vscode.workspace.fs.writeFile(target, buf);
                    uRestored++;
                  } else {
                    await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
                    uDeleted++;
                  }
                } catch {
                  uErrors++;
                }
              }
              vscode.window.showInformationMessage(`Prompt Replay: undo complete — ${uRestored} restored, ${uDeleted} deleted${uErrors ? `, ${uErrors} errors` : ''}.`);
            } catch {
              vscode.window.showErrorMessage('Prompt Replay: undo failed (could not read backup).');
            }
          }

          return;
        }
      } catch (e) {
        console.error('[Prompt Replay] onMessage error:', e);
        vscode.window.showErrorMessage('Prompt Replay: action failed (see Debug Console).');
      }
    });
  });

  // Optional: nudge on large edits
  const nudges = vscode.workspace.getConfiguration('promptReplay').get<boolean>('autoNudgeLargeEdit', true);
  const lineThreshold = vscode.workspace.getConfiguration('promptReplay').get<number>('largeEditLineThreshold', 20);

  let changeAccumulator = 0;
  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!nudges) return;
    changeAccumulator += e.contentChanges.reduce((acc, c) => acc + (c.text.split('\n').length - 1), 0);
    if (changeAccumulator >= (lineThreshold ?? 20)) {
      changeAccumulator = 0;
      vscode.window.showInformationMessage('Large edit detected. Log your prompt with: “Prompt Replay: Log Prompt…”.');
    }
  });

  context.subscriptions.push(startSession, createCheckpoint, logPrompt, openTimeline, changeSub);
}

export function deactivate() {}
