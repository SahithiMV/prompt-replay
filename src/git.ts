import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);


export type GitAPI = {
  repositories: any[];
};

export async function getFileAtRef(repoRoot: string, ref: string, relPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${relPath}`], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined; // not present at ref, or binary/too large/error
  }
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return;
  const git = await ext.activate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (git as any).getAPI?.(1);
}

export function primaryRepo(api?: GitAPI): any | undefined {
  if (!api || api.repositories.length === 0) return;
  return api.repositories[0];
}

export function headSha(repo: any): string | undefined {
  try {
    return repo?.state?.HEAD?.commit;
  } catch {
    return undefined;
  }
}

export async function collectWorkingDiff(repo: any): Promise<{ path: string; left?: vscode.Uri; right?: vscode.Uri }[]> {
  const results: { path: string; left?: vscode.Uri; right?: vscode.Uri }[] = [];
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return results;

  // Combine un-staged + staged
  const changes = [
    ...(repo?.state?.workingTreeChanges ?? []),
    ...(repo?.state?.indexChanges ?? [])
  ];

  for (const c of changes) {
    const left = c.originalUri ?? c.renameResourceUri ?? c.uri;
    const right = c.uri;
    const rel = vscode.workspace.asRelativePath(right);
    results.push({ path: rel, left, right });
  }
  return results;
}
