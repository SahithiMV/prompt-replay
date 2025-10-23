import * as vscode from 'vscode';
import * as path from 'path';
import { PromptEvent, SessionState } from './types';

export class Store {
  constructor(private ctx: vscode.ExtensionContext) {}

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

  async ensureDir() {
    const dir = this.dirPath();
    if (!dir) return;
    const dUri = vscode.Uri.file(dir);
    try {
      await vscode.workspace.fs.stat(dUri);
    } catch {
      await vscode.workspace.fs.createDirectory(dUri);
    }
  }

  async appendEvent(ev: PromptEvent, maxEvents: number) {
    await this.ensureDir();
    const file = this.fileUri('events.jsonl');
    if (!file) return;

    const line = Buffer.from(JSON.stringify(ev) + '\n');
    let content = line;

    try {
      const old = await vscode.workspace.fs.readFile(file);
      content = Buffer.concat([old, line]);
    } catch {
      // first write
    }

    // Trim if too many events
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
    const file = this.fileUri('events.jsonl');
    if (!file) return [];
    try {
      const buf = await vscode.workspace.fs.readFile(file);
      const lines = Buffer.from(buf).toString('utf8').split('\n').filter(Boolean);
      return lines.map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  get session(): SessionState {
    return this.ctx.globalState.get<SessionState>('promptReplay.session', { active: false });
  }

  set session(s: SessionState) {
    this.ctx.globalState.update('promptReplay.session', s);
  }
}
