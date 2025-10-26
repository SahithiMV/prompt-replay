import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { Store } from './store';
import { TimelinePanel } from './timelinePanel';
import { getGitApi, primaryRepo, headSha, collectWorkingDiff, getFileAtRef } from './git';
import { PromptEvent } from './types';

console.log('[Prompt Replay] activate()');

const touchedSinceCheckpoint = new Set<string>();

function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
}
async function exists(uri: vscode.Uri | undefined): Promise<boolean> {
  if (!uri) return false;
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}
async function statMaybe(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try { return await vscode.workspace.fs.stat(uri); } catch { return undefined; }
}
async function readDirMaybe(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try { return await vscode.workspace.fs.readDirectory(uri); } catch { return [] as [string, vscode.FileType][]; }
}

/** Read bytes from any URI (file:, git:, untitled:). */
async function readBytesFlexible(uriStr: string | undefined): Promise<Uint8Array | undefined> {
  if (!uriStr) return undefined;
  let uri: vscode.Uri;
  try { uri = vscode.Uri.parse(uriStr); } catch { return undefined; }

  // Try FS API first
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    // Fallback: open as text doc and convert to bytes
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      return Buffer.from(doc.getText(), 'utf8');
    } catch {
      return undefined;
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new Store(context);

  // Track edits while a checkpoint is active
  const editListener = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!store.session.lastCheckpointSha) return;
    if (e.document.uri.scheme !== 'file') return;
    const rp = relPath(e.document.uri);
    if (rp) touchedSinceCheckpoint.add(rp);
  });
  context.subscriptions.push(editListener);

  // Commands
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

    const ev: PromptEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      prompt,
      responsePreview: responsePreview || undefined,
      repoRoot,
      beforeRef: checkpointRef,
      afterRef: 'WORKING',
      filesChanged: diffs.map(d => d.path),
      diffUris: [],
      tags
    };

    // snapshot directories
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

      // left (before)
      const leftText = checkpointRef ? await getFileAtRef(repoRoot, checkpointRef, rel) : undefined;
      const leftSnap = vscode.Uri.file(path.join(beforeDir.fsPath, rel));
      try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(leftSnap.fsPath))); } catch {}
      if (leftText !== undefined) {
        await vscode.workspace.fs.writeFile(leftSnap, Buffer.from(leftText, 'utf8'));
      } else {
        // represent "no file" as empty; we'll rely on `op` to distinguish
        await vscode.workspace.fs.writeFile(leftSnap, Buffer.alloc(0));
      }
      leftSnapUris[rel] = leftSnap;

      // right (after)
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

    ev.diffUris = diffs.map(d => {
      const rel = d.path.replace(/\\/g, '/');
      return {
        path: rel,
        left: leftSnapUris[rel]?.toString(),
        right: rightSnapUris[rel]?.toString(),
        op: ops[rel] as any
      } as any;
    });

    await store.appendEvent(ev, maxEvents);

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
          eventsAll = await store.readEvents();
          const filtered = !q ? eventsAll : eventsAll.filter(ev =>
            ev.prompt.toLowerCase().includes(q) ||
            ev.filesChanged.some(f => f.toLowerCase().includes(q)) ||
            (ev.tags ?? []).some(t => t.toLowerCase().includes(q))
          );
          TimelinePanel.current?.setEvents(filtered);
          return;
        }

        if (message.type === 'exportEvent') {
          await exportEventMarkdown(String(message.id || ''), store);
          return;
        }

        if (message.type === 'restoreEvent') {
          // side: 'before' | 'after' (default 'after')
          await handleRestoreEvent({ ...message }, store);
          return;
        }

        if (message.type === 'restoreFile') {
          await handleRestoreFile({ ...message }, store);
          return;
        }

        if (message.type === 'deleteEvent') {
          await deleteEventAndAssets(String(message.id || ''), store);
          const fresh = await store.readEvents();
          TimelinePanel.current?.setEvents(fresh);
          return;
        }

        if (message.type === 'openTrash') {
          await restoreDeletedEventViaUI(store);
          const fresh = await store.readEvents();
          TimelinePanel.current?.setEvents(fresh);
          return;
        }
      } catch (e) {
        console.error('[Prompt Replay] onMessage error:', e);
        vscode.window.showErrorMessage('Prompt Replay: action failed (see Debug Console).');
      }
    });
  });

  // Optional: nudge
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

/* ---------------- Export to Markdown ---------------- */

async function exportEventMarkdown(id: string, store: Store) {
  if (!id) { vscode.window.showWarningMessage('Export failed: missing event id.'); return; }
  const events = await store.readEvents();
  const ev = events.find(e => e.id === id);
  if (!ev) { vscode.window.showWarningMessage('Export failed: event not found.'); return; }

  const root = ev.repoRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) { vscode.window.showWarningMessage('Export failed: workspace root not found.'); return; }

  const snapsDir = path.join(root, '.promptreplay', 'snapshots', id);
  const beforeDir = path.join(snapsDir, '__before__');
  const afterDir  = path.join(snapsDir, '__after__');

  const when = new Date(ev.timestamp || Date.now());
  const dateStr = `${when.toLocaleDateString()} ${when.toLocaleTimeString()}`;
  const header = [
    `# Prompt Replay — Event ${id} (${dateStr})`,
    ``,
    `**Prompt:** ${codeQuote(ev.prompt || '')}`,
    ev.tags?.length ? `**Tags:** ${ev.tags.join(', ')}` : ``,
    `**Repo:** ${root}`,
    `**Before:** ${ev.beforeRef ? truncateSha(ev.beforeRef) : '—'}  |  **After:** working tree at log time`,
    ``,
    `---`,
    ``,
  ].filter(Boolean).join('\n');

  let filesList: string[] = [];
  let fileSections: string[] = [];

  for (const d of ev.diffUris || []) {
    const rel = d.path;
    const leftText  = await readUtf8Maybe(vscode.Uri.file(path.join(beforeDir, rel)));
    const rightText = await readUtf8Maybe(vscode.Uri.file(path.join(afterDir, rel)));

    const diff = buildUnifiedDiff(leftText, rightText);
    const counts = countDiff(diff);
    const status = (d as any).op === 'added' ? 'Added' : (d as any).op === 'deleted' ? 'Deleted' : 'Modified';

    filesList.push(`- **${rel}** — ${status} (+${counts.added} / −${counts.removed})`);

    const section = [
      ``,
      `### ${rel} (${status})`,
      '```diff',
      ...diff,
      '```',
      ``
    ].join('\n');

    fileSections.push(section);
  }

  const listBlock = [`## Files changed (${filesList.length})`, ...filesList, ``, `---`, ``].join('\n');

  if ((ev as any).responsePreview) {
    fileSections.unshift(`**Response preview:**\n\n> ${(ev as any).responsePreview}\n\n`);
  }

  const md = [header, listBlock, ...fileSections].join('\n');

  const exportsDir = vscode.Uri.file(path.join(root, '.promptreplay', 'exports'));
  try { await vscode.workspace.fs.createDirectory(exportsDir); } catch {}
  const outUri = vscode.Uri.file(path.join(exportsDir.fsPath, `event-${id}.md`));
  await vscode.workspace.fs.writeFile(outUri, Buffer.from(md, 'utf8'));

  const doc = await vscode.workspace.openTextDocument(outUri);
  await vscode.window.showTextDocument(doc, { preview: false });

  vscode.window.showInformationMessage(`Prompt Replay: exported to ${outUri.fsPath}`);
}

/* ---------------- Delete event + assets ---------------- */

async function deleteEventAndAssets(id: string, store: Store) {
  if (!id) { vscode.window.showWarningMessage('Delete failed: missing event id.'); return; }

  const events = await store.readEvents();
  const ev = events.find(e => e.id === id);
  if (!ev) { vscode.window.showWarningMessage('Delete failed: event not found.'); return; }

  const root = ev.repoRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) { vscode.window.showWarningMessage('Delete failed: workspace root not found.'); return; }

  const ok = await vscode.window.showWarningMessage(
    'Delete this prompt event? Snapshots and exports will be moved to .promptreplay/trash.',
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;

  const prDir = path.join(root, '.promptreplay');
  const eventsUri = vscode.Uri.file(path.join(prDir, 'events.jsonl'));
  const snapsDir  = vscode.Uri.file(path.join(prDir, 'snapshots', id));
  const exportMd  = vscode.Uri.file(path.join(prDir, 'exports', `event-${id}.md`));

  const trashBase = vscode.Uri.file(path.join(prDir, 'trash'));
  try { await vscode.workspace.fs.createDirectory(trashBase); } catch {}

  const stamp = Date.now();
  const trashEventDir = vscode.Uri.file(path.join(trashBase.fsPath, `${stamp}-${id}`));
  try { await vscode.workspace.fs.createDirectory(trashEventDir); } catch {}

  if (await exists(snapsDir)) {
    const dest = vscode.Uri.file(path.join(trashEventDir.fsPath, 'snapshots'));
    try { await vscode.workspace.fs.rename(snapsDir, dest, { overwrite: false }); } catch {}
  }

  if (await exists(exportMd)) {
    const dest = vscode.Uri.file(path.join(trashEventDir.fsPath, `event-${id}.md`));
    try { await vscode.workspace.fs.rename(exportMd, dest, { overwrite: true }); } catch {}
  }

  try {
    const buf = await vscode.workspace.fs.readFile(eventsUri);
    const original = Buffer.from(buf);

    const backupUri = vscode.Uri.file(path.join(trashEventDir.fsPath, 'events.jsonl.bak'));
    await vscode.workspace.fs.writeFile(backupUri, original);

    const lines = original.toString('utf8').split('\n').filter(Boolean);
    const kept: string[] = [];
    let removed = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.id === id) { removed++; continue; }
      } catch {}
      kept.push(line);
    }

    await vscode.workspace.fs.writeFile(
      eventsUri,
      Buffer.from(kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
    );

    const evJsonUri = vscode.Uri.file(path.join(trashEventDir.fsPath, `event-${id}.json`));
    await vscode.workspace.fs.writeFile(evJsonUri, Buffer.from(JSON.stringify(ev, null, 2), 'utf8'));

    vscode.window.showInformationMessage(
      removed ? `Prompt Replay: deleted event ${id}. Assets moved to .promptreplay/trash/${stamp}-${id}/`
              : `Prompt Replay: event ${id} not found in events.jsonl (already removed?).`
    );
  } catch (err) {
    console.error('[Prompt Replay] deleteEvent error:', err);
    vscode.window.showErrorMessage('Prompt Replay: failed to delete event (see Debug Console).');
  }
}

/* ---------------- Restore from Trash ---------------- */

async function restoreDeletedEventViaUI(store: Store) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) { vscode.window.showWarningMessage('Open a folder/workspace first.'); return; }

  const prDir = path.join(root, '.promptreplay');
  const trashDir = vscode.Uri.file(path.join(prDir, 'trash'));
  if (!(await exists(trashDir))) {
    vscode.window.showInformationMessage('Prompt Replay: trash is empty.');
    return;
  }

  const entries = await readDirMaybe(trashDir);
  const candidates: { label: string; description: string; detail?: string; dir: vscode.Uri; id: string }[] = [];

  for (const entry of entries) {
    const name = entry[0];
    const kind = entry[1];
    if (kind !== vscode.FileType.Directory) continue;

    const dir = vscode.Uri.file(path.join(trashDir.fsPath, name));
    const inner = await readDirMaybe(dir);

    const meta = inner.find((ent) => ent[0].startsWith('event-') && ent[0].endsWith('.json'));
    if (!meta) continue;

    const id = meta[0].slice('event-'.length, -'.json'.length);
    const jsonUri = vscode.Uri.file(path.join(dir.fsPath, meta[0]));

    let prompt = '';
    let timestamp = '';
    try {
      const raw = await vscode.workspace.fs.readFile(jsonUri);
      const obj = JSON.parse(Buffer.from(raw).toString('utf8')) as PromptEvent;
      prompt = (obj.prompt || '').toString();
      timestamp = new Date(obj.timestamp || Date.now()).toLocaleString();
    } catch {}

    candidates.push({
      label: prompt ? (prompt.length > 90 ? prompt.slice(0, 87) + '…' : prompt) : `(no prompt)`,
      description: `id: ${id} • ${timestamp}`,
      detail: `Trash folder: ${name}`,
      dir,
      id
    });
  }

  if (candidates.length === 0) {
    vscode.window.showInformationMessage('Prompt Replay: no deleted events found in trash.');
    return;
  }

  const picked = await vscode.window.showQuickPick(candidates, {
    placeHolder: 'Select a deleted event to restore…',
    matchOnDetail: true,
    matchOnDescription: true
  });
  if (!picked) return;

  await restoreDeletedEventFromDir(picked.dir, picked.id, store);
}

async function restoreDeletedEventFromDir(trashEventDir: vscode.Uri, id: string, store: Store) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) { vscode.window.showWarningMessage('Workspace root not found.'); return; }

  const prDir = path.join(root, '.promptreplay');
  const jsonUri = vscode.Uri.file(path.join(trashEventDir.fsPath, `event-${id}.json`));

  let ev: PromptEvent | undefined;
  try {
    const raw = await vscode.workspace.fs.readFile(jsonUri);
    ev = JSON.parse(Buffer.from(raw).toString('utf8')) as PromptEvent;
  } catch { vscode.window.showErrorMessage('Prompt Replay: could not read trashed event JSON.'); return; }
  if (!ev) return;

  const existing = (await store.readEvents()).some(e => e.id === id);
  if (!existing) {
    const maxEvents = vscode.workspace.getConfiguration('promptReplay').get<number>('maxEvents', 2000);
    await store.appendEvent(ev, maxEvents);
  }

  const srcSnaps = vscode.Uri.file(path.join(trashEventDir.fsPath, 'snapshots'));
  const dstSnaps = vscode.Uri.file(path.join(prDir, 'snapshots', id));
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(prDir, 'snapshots')));
    if (await exists(srcSnaps)) {
      await vscode.workspace.fs.rename(srcSnaps, dstSnaps, { overwrite: true });
    }
  } catch {}

  const srcMd = vscode.Uri.file(path.join(trashEventDir.fsPath, `event-${id}.md`));
  const dstMd = vscode.Uri.file(path.join(prDir, 'exports', `event-${id}.md`));
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(prDir, 'exports')));
    if (await exists(srcMd)) {
      await vscode.workspace.fs.rename(srcMd, dstMd, { overwrite: true });
    }
  } catch {}

  vscode.window.showInformationMessage(`Prompt Replay: restored event ${id} from trash.`);
}

/* ---------------- Small helpers for export/diff ---------------- */

function codeQuote(s: string) {
  const cleaned = (s || '').replace(/\r/g, '');
  if (cleaned.includes('\n')) return `\n\n> ${cleaned.split('\n').join('\n> ')}\n`;
  return `“${cleaned}”`;
}
function truncateSha(ref: string) {
  if (!ref) return '—';
  if (ref.startsWith(':working:')) return 'working';
  return ref.length > 8 ? ref.slice(0, 8) : ref;
}
async function readUtf8Maybe(uri: vscode.Uri): Promise<string> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(buf).toString('utf8');
  } catch { return ''; }
}

type DiffOp = { t: ' ' | '+' | '-', s: string };
function buildUnifiedDiff(before: string, after: string): string[] {
  const A = (before ?? '').split('\n');
  const B = (after ?? '').split('\n');
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: ' ', s: A[i++] }); j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) ops.push({ t:'-', s: A[i++] });
    else ops.push({ t:'+', s: B[j++] });
  }
  while (i < n) ops.push({ t:'-', s: A[i++] });
  while (j < m) ops.push({ t:'+', s: B[j++] });
  const context = 3, out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t !== ' ') {
      let start = k; while (start > 0 && ops[start-1].t === ' ' && (k-(start-1)) <= context) start--;
      let end = k; while (end < ops.length && ops[end].t !== ' ') end++;
      let tail = end; while (tail < ops.length && ops[tail].t === ' ' && (tail-end) <= context) tail++;
      for (let x = start; x < tail; x++) out.push((ops[x].t === ' ' ? ' ' : ops[x].t) + ops[x].s);
      if (tail < ops.length) out.push('...');
      k = tail;
    } else k++;
  }
  if (out.length === 0 && A.length === B.length && A.every((v, idx) => v === B[idx])) return [' (no changes) '];
  return out;
}
function countDiff(lines: string[]) {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.startsWith('+')) added++; else if (l.startsWith('-')) removed++; }
  return { added, removed };
}

/* ---------------- Restore helpers (supports before/after) ---------------- */

async function handleRestoreEvent(message: { id: string; side?: 'before' | 'after' }, store: Store) {
  const id = String(message.id || '');
  const side = (message.side === 'before' || message.side === 'after') ? message.side : 'after';
  if (!id) { vscode.window.showWarningMessage('Missing event id.'); return; }

  const all = await store.readEvents();
  const ev = all.find(e => e.id === id);
  if (!ev) { vscode.window.showWarningMessage('Event not found.'); return; }

  const confirm = await vscode.window.showWarningMessage(
    `Restore ${ev.filesChanged.length} file(s) to the ${side.toUpperCase()} snapshot of this event? This will overwrite your working copies.`,
    { modal: true },
    'Restore'
  );
  if (confirm !== 'Restore') return;

  const root = ev.repoRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) { vscode.window.showWarningMessage('Workspace root not found.'); return; }

  const backupId = `backup-${Date.now()}`;
  const backupDir = vscode.Uri.file(path.join(root, '.promptreplay', 'restore_backups', backupId));
  const backupBeforeDir = vscode.Uri.file(path.join(backupDir.fsPath, 'before'));
  try { await vscode.workspace.fs.createDirectory(backupBeforeDir); } catch {}

  type BackupEntry = { path: string; existed: boolean; };
  const manifest: BackupEntry[] = [];

  for (const d of ev.diffUris || []) {
    const rel = d.path;
    const target = vscode.Uri.file(path.join(root, rel));
    const entry: BackupEntry = { path: rel, existed: false };
    const st = await statMaybe(target);
    if (st) {
      entry.existed = true;
      const backupTarget = vscode.Uri.file(path.join(backupBeforeDir.fsPath, rel));
      try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(backupTarget.fsPath))); } catch {}
      const buf = await vscode.workspace.fs.readFile(target);
      await vscode.workspace.fs.writeFile(backupTarget, buf);
    }
    manifest.push(entry);
  }

  const manifestUri = vscode.Uri.file(path.join(backupDir.fsPath, 'manifest.json'));
  await vscode.workspace.fs.writeFile(manifestUri, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  let restored = 0, deleted = 0, skipped = 0, errors = 0;

  for (const d of ev.diffUris || []) {
    const rel = d.path;
    const target = vscode.Uri.file(path.join(root, rel));
    const op = (d as any).op as ('added'|'modified'|'deleted'|undefined);

    try {
      if (side === 'after') {
        // After: if op === deleted, remove file; else write from right
        if (op === 'deleted') {
          try { await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false }); deleted++; }
          catch { skipped++; }
        } else {
          const bytes = await readBytesFlexible(d.right);
          if (bytes === undefined) { skipped++; }
          else {
            try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath))); } catch {}
            await vscode.workspace.fs.writeFile(target, bytes);
            restored++;
          }
        }
      } else { // before
        // Before: if op === added, remove file; else write from left
        if (op === 'added') {
          try { await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false }); deleted++; }
          catch { skipped++; }
        } else {
          const bytes = await readBytesFlexible(d.left);
          if (bytes === undefined) { skipped++; }
          else {
            try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath))); } catch {}
            await vscode.workspace.fs.writeFile(target, bytes);
            restored++;
          }
        }
      }
    } catch {
      errors++;
    }
  }

  const undoAction = 'Undo';
  const summary = `Prompt Replay: restore (${side}) — ${restored} restored, ${deleted} deleted, ${skipped} skipped${errors ? `, ${errors} errors` : ''}.`;
  const choice = await vscode.window.showInformationMessage(summary, undoAction);

  if (choice === 'Undo') {
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
}

async function handleRestoreFile(message: { id: string; path: string; side?: 'before' | 'after' }, store: Store) {
  const id = String(message.id || '');
  const rel = String(message.path || '');
  const side = (message.side === 'before' || message.side === 'after') ? message.side : 'after';
  if (!id || !rel) { vscode.window.showWarningMessage('Missing event id or file path.'); return; }

  const all = await store.readEvents();
  const ev = all.find(e => e.id === id);
  if (!ev) { vscode.window.showWarningMessage('Event not found.'); return; }

  const fileEntry = (ev.diffUris || []).find(d => d.path === rel);
  if (!fileEntry) { vscode.window.showWarningMessage('File not part of this event.'); return; }

  const confirm = await vscode.window.showWarningMessage(
    `Restore file “${rel}” to the ${side.toUpperCase()} snapshot of this event? This will overwrite your working copy.`,
    { modal: true },
    'Restore'
  );
  if (confirm !== 'Restore') return;

  const root = ev.repoRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) { vscode.window.showWarningMessage('Workspace root not found.'); return; }

  const backupId = `backup-${Date.now()}`;
  const backupDir = vscode.Uri.file(path.join(root, '.promptreplay', 'restore_backups', backupId));
  const backupBeforeDir = vscode.Uri.file(path.join(backupDir.fsPath, 'before'));
  try { await vscode.workspace.fs.createDirectory(backupBeforeDir); } catch {}

  type BackupEntry = { path: string; existed: boolean; };
  const entry: BackupEntry = { path: rel, existed: false };
  const target = vscode.Uri.file(path.join(root, rel));
  const st = await statMaybe(target);
  if (st) {
    entry.existed = true;
    const backupTarget = vscode.Uri.file(path.join(backupBeforeDir.fsPath, rel));
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(backupTarget.fsPath))); } catch {}
    const buf = await vscode.workspace.fs.readFile(target);
    await vscode.workspace.fs.writeFile(backupTarget, buf);
  }
  const manifestUri = vscode.Uri.file(path.join(backupDir.fsPath, 'manifest.json'));
  await vscode.workspace.fs.writeFile(manifestUri, Buffer.from(JSON.stringify([entry], null, 2), 'utf8'));

  let didRestore = 0, didDelete = 0, skipped = 0, errors = 0;
  try {
    const op = (fileEntry as any).op as ('added'|'modified'|'deleted'|undefined);
    if (side === 'after') {
      if (op === 'deleted') {
        try { await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false }); didDelete++; }
        catch { skipped++; }
      } else {
        const bytes = await readBytesFlexible(fileEntry.right);
        if (bytes === undefined) { skipped++; }
        else {
          try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath))); } catch {}
          await vscode.workspace.fs.writeFile(target, bytes);
          didRestore++;
        }
      }
    } else {
      if (op === 'added') {
        try { await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false }); didDelete++; }
        catch { skipped++; }
      } else {
        const bytes = await readBytesFlexible(fileEntry.left);
        if (bytes === undefined) { skipped++; }
        else {
          try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath))); } catch {}
          await vscode.workspace.fs.writeFile(target, bytes);
          didRestore++;
        }
      }
    }
  } catch {
    errors++;
  }

  const undoAction = 'Undo';
  const summary = `Prompt Replay: file restore (${side}) — ${didRestore ? 'restored' : didDelete ? 'deleted' : 'skipped'}${errors ? `, ${errors} errors` : ''}.`;
  const choice = await vscode.window.showInformationMessage(summary, undoAction);

  if (choice === 'Undo') {
    try {
      const raw = await vscode.workspace.fs.readFile(manifestUri);
      const [back] = JSON.parse(Buffer.from(raw).toString('utf8')) as BackupEntry[];
      const targetUri = vscode.Uri.file(path.join(root, back.path));
      try {
        if (back.existed) {
          const backupFile = vscode.Uri.file(path.join(backupBeforeDir.fsPath, back.path));
          const buf = await vscode.workspace.fs.readFile(backupFile);
          try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath))); } catch {}
          await vscode.workspace.fs.writeFile(targetUri, buf);
        } else {
          await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: false });
        }
        vscode.window.showInformationMessage('Prompt Replay: undo complete for file.');
      } catch {
        vscode.window.showErrorMessage('Prompt Replay: undo failed for file.');
      }
    } catch {
      vscode.window.showErrorMessage('Prompt Replay: undo failed (could not read backup).');
    }
  }
}
