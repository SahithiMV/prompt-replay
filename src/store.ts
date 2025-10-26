import * as vscode from 'vscode';
import * as path from 'path';
import { PromptEvent, SessionState } from './types';
import { EventSummary } from './ai';

export class Store {
  constructor(private ctx: vscode.ExtensionContext) {}

  // ---------- paths ----------
  private rootFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }
  private dirPath(): string | undefined {
    const root = this.rootFolder();
    if (!root) return;
    return path.join(root.uri.fsPath, '.promptreplay');
  }
  private fileUri(filename: string): vscode.Uri | undefined {
    const dir = this.dirPath();
    if (!dir) return;
    return vscode.Uri.file(path.join(dir, filename));
  }
  private eventsFileUri(): vscode.Uri | undefined {
    return this.fileUri('events.jsonl');
  }
  private summariesDir(): vscode.Uri | undefined {
    const dir = this.dirPath();
    if (!dir) return;
    return vscode.Uri.file(path.join(dir, 'summaries'));
  }
  private exportsDir(): vscode.Uri | undefined {
    const dir = this.dirPath();
    if (!dir) return;
    return vscode.Uri.file(path.join(dir, 'exports'));
  }
  private snapshotsDirFor(id: string): vscode.Uri | undefined {
    const dir = this.dirPath();
    if (!dir) return;
    return vscode.Uri.file(path.join(dir, 'snapshots', id));
  }
  private trashIndexUri(): vscode.Uri | undefined {
    return this.fileUri('trashIndex.json'); // array of trashed IDs
  }

  // ---------- fs helpers ----------
  async ensureDir() {
    const dir = this.dirPath();
    if (!dir) return;
    const dUri = vscode.Uri.file(dir);
    try { await vscode.workspace.fs.stat(dUri); } catch { await vscode.workspace.fs.createDirectory(dUri); }
  }
  private async ensureDirUri(u?: vscode.Uri) {
    if (!u) return;
    const d = vscode.Uri.file(path.dirname(u.fsPath));
    try { await vscode.workspace.fs.stat(d); } catch { await vscode.workspace.fs.createDirectory(d); }
  }

  // ---------- events (JSONL) ----------
  async appendEvent(ev: PromptEvent, maxEvents: number) {
    await this.ensureDir();
    const file = this.eventsFileUri();
    if (!file) return;

    const line = Buffer.from(JSON.stringify(ev) + '\n');
    let content = line;
    try {
      const old = await vscode.workspace.fs.readFile(file);
      content = Buffer.concat([old, line]);
    } catch { /* first write */ }

    const text = content.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > maxEvents) {
      const trimmed = lines.slice(lines.length - maxEvents).join('\n') + '\n';
      await vscode.workspace.fs.writeFile(file, Buffer.from(trimmed));
    } else {
      await vscode.workspace.fs.writeFile(file, content);
    }
  }

  async readEvents(): Promise<PromptEvent[]> {
    const file = this.eventsFileUri();
    if (!file) return [];
    try {
      const buf = await vscode.workspace.fs.readFile(file);
      const lines = Buffer.from(buf).toString('utf8').split('\n').filter(Boolean);
      return lines.map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ---------- summaries ----------
  async writeSummary(eventId: string, summary: EventSummary) {
    await this.ensureDir();
    const sdir = this.summariesDir();
    if (!sdir) return;
    try { await vscode.workspace.fs.stat(sdir); } catch { await vscode.workspace.fs.createDirectory(sdir); }
    const file = vscode.Uri.joinPath(sdir, `${eventId}.json`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(summary, null, 2), 'utf8'));
  }

  async readSummary(eventId: string): Promise<EventSummary | undefined> {
    const sdir = this.summariesDir();
    if (!sdir) return;
    const file = vscode.Uri.joinPath(sdir, `${eventId}.json`);
    try {
      const buf = await vscode.workspace.fs.readFile(file);
      return JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  async readAllSummaries(): Promise<Record<string, EventSummary>> {
    const out: Record<string, EventSummary> = {};
    const sdir = this.summariesDir();
    if (!sdir) return out;
    try {
      const entries = await vscode.workspace.fs.readDirectory(sdir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) continue;
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        const sum = await this.readSummary(id);
        if (sum) out[id] = sum;
      }
    } catch {}
    return out;
  }

  // ---------- trash index (soft delete) ----------
  async readTrashIds(): Promise<Set<string>> {
    const u = this.trashIndexUri();
    const set = new Set<string>();
    if (!u) return set;
    try {
      const buf = await vscode.workspace.fs.readFile(u);
      const arr = JSON.parse(Buffer.from(buf).toString('utf8')) as string[];
      for (const id of arr) set.add(id);
    } catch {}
    return set;
  }

  private async writeTrashIds(ids: Set<string>) {
    const u = this.trashIndexUri();
    if (!u) return;
    await this.ensureDirUri(u);
    const arr = Array.from(ids);
    await vscode.workspace.fs.writeFile(u, Buffer.from(JSON.stringify(arr, null, 2), 'utf8'));
  }

  async trashEvent(id: string) {
    const ids = await this.readTrashIds();
    ids.add(id);
    await this.writeTrashIds(ids);
  }

  async untrashEvent(id: string) {
    const ids = await this.readTrashIds();
    if (ids.has(id)) {
      ids.delete(id);
      await this.writeTrashIds(ids);
    }
  }

  // Permanently remove: delete snapshots, summary, exports, and rewrite events.jsonl w/o this event
  async deleteEventPermanent(id: string) {
    // 1) events.jsonl rewrite (filter out id)
    const file = this.eventsFileUri();
    if (file) {
      try {
        const buf = await vscode.workspace.fs.readFile(file);
        const lines = Buffer.from(buf).toString('utf8').split('\n').filter(Boolean);
        const kept = lines.filter(l => {
          try { const o = JSON.parse(l); return o?.id !== id; } catch { return true; }
        });
        await vscode.workspace.fs.writeFile(file, Buffer.from(kept.join('\n') + (kept.length ? '\n' : ''), 'utf8'));
      } catch {}
    }

    // 2) snapshots
    const snap = this.snapshotsDirFor(id);
    if (snap) {
      try { await vscode.workspace.fs.delete(snap, { recursive: true, useTrash: true }); } catch {}
    }

    // 3) summary
    const sdir = this.summariesDir();
    if (sdir) {
      const sumFile = vscode.Uri.joinPath(sdir, `${id}.json`);
      try { await vscode.workspace.fs.delete(sumFile, { useTrash: true }); } catch {}
    }

    // 4) exports (best-effort: delete files starting with event-<id>)
    const ex = this.exportsDir();
    if (ex) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(ex);
        for (const [name, t] of entries) {
          if (t !== vscode.FileType.File) continue;
          if (name.startsWith(`event-${id}`)) {
            try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(ex, name), { useTrash: true }); } catch {}
          }
        }
      } catch {}
    }

    // 5) ensure trash index doesn’t still reference it
    await this.untrashEvent(id);
  }

  // ---------- session ----------
  get session(): SessionState {
    return this.ctx.globalState.get<SessionState>('promptReplay.session', { active: false });
  }
  set session(s: SessionState) {
    this.ctx.globalState.update('promptReplay.session', s);
  }
}
