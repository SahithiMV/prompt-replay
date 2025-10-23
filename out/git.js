"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFileAtRef = getFileAtRef;
exports.getGitApi = getGitApi;
exports.primaryRepo = primaryRepo;
exports.headSha = headSha;
exports.collectWorkingDiff = collectWorkingDiff;
const vscode = require("vscode");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
async function getFileAtRef(repoRoot, ref, relPath) {
    try {
        const { stdout } = await execFileAsync('git', ['show', `${ref}:${relPath}`], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
        return stdout;
    }
    catch {
        return undefined; // not present at ref, or binary/too large/error
    }
}
async function getGitApi() {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext)
        return;
    const git = await ext.activate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return git.getAPI?.(1);
}
function primaryRepo(api) {
    if (!api || api.repositories.length === 0)
        return;
    return api.repositories[0];
}
function headSha(repo) {
    try {
        return repo?.state?.HEAD?.commit;
    }
    catch {
        return undefined;
    }
}
async function collectWorkingDiff(repo) {
    const results = [];
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws)
        return results;
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
//# sourceMappingURL=git.js.map