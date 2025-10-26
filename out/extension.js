"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const crypto_1 = require("crypto");
const store_1 = require("./store");
const timelinePanel_1 = require("./timelinePanel");
const git_1 = require("./git");
const ai_1 = require("./ai");
console.log('[Prompt Replay] activate()');
const touchedSinceCheckpoint = new Set();
function relPath(uri) {
    return vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
}
async function exists(uri) {
    if (!uri)
        return false;
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    }
    catch {
        return false;
    }
}
async function readUtf8(uri) {
    if (!uri)
        return;
    try {
        const buf = await vscode.workspace.fs.readFile(uri);
        return { text: Buffer.from(buf).toString('utf8'), size: buf.byteLength };
    }
    catch {
        return;
    }
}
async function ensureParentDir(u) {
    const dir = vscode.Uri.file(path.dirname(u.fsPath));
    try {
        await vscode.workspace.fs.stat(dir);
    }
    catch {
        await vscode.workspace.fs.createDirectory(dir);
    }
}
async function writeWorkspaceFile(repoRoot, rel, content) {
    const target = vscode.Uri.file(path.join(repoRoot, rel));
    await ensureParentDir(target);
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
}
async function deleteWorkspaceFile(repoRoot, rel) {
    const target = vscode.Uri.file(path.join(repoRoot, rel));
    try {
        await vscode.workspace.fs.delete(target, { useTrash: true });
    }
    catch { }
}
async function activate(context) {
    const store = new store_1.Store(context);
    // Track edits between checkpoint and logPrompt
    const editListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (!store.session.lastCheckpointSha)
            return;
        if (e.document.uri.scheme !== 'file')
            return;
        const rp = relPath(e.document.uri);
        if (rp)
            touchedSinceCheckpoint.add(rp);
    });
    context.subscriptions.push(editListener);
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
        const api = await (0, git_1.getGitApi)();
        const repo = (0, git_1.primaryRepo)(api);
        const sha = (0, git_1.headSha)(repo) ?? `:working:${Date.now()}`;
        if (!store.session.active)
            await vscode.commands.executeCommand('promptReplay.startSession');
        store.session = { ...store.session, lastCheckpointSha: sha };
        touchedSinceCheckpoint.clear();
        vscode.window.showInformationMessage(`Prompt Replay: checkpoint created (${sha.slice(0, 8)})`);
    });
    const logPrompt = vscode.commands.registerCommand('promptReplay.logPrompt', async () => {
        const prompt = await vscode.window.showInputBox({ prompt: 'Enter the AI prompt you used', validateInput: v => (v ? undefined : 'Prompt required') });
        if (!prompt)
            return;
        const responsePreview = await vscode.window.showInputBox({ prompt: 'Optional: short response preview (or leave empty)' });
        const tagsStr = await vscode.window.showInputBox({ prompt: 'Optional: tags (comma-separated, e.g. bug fix, refactor)' });
        const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;
        const maxEvents = vscode.workspace.getConfiguration('promptReplay').get('maxEvents', 2000);
        const api = await (0, git_1.getGitApi)();
        const repo = (0, git_1.primaryRepo)(api);
        let diffs = await (0, git_1.collectWorkingDiff)(repo);
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
        }
        else {
            if (diffs.length === 0) {
                vscode.window.showInformationMessage('Prompt Replay: no changes in the working tree — nothing to log.');
                return;
            }
        }
        const ev = {
            id: (0, crypto_1.randomUUID)(),
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
        const snapshotsDir = vscode.Uri.file(path.join(repoRoot, '.promptreplay', 'snapshots', ev.id));
        try {
            await vscode.workspace.fs.createDirectory(snapshotsDir);
        }
        catch { }
        const afterDir = vscode.Uri.file(path.join(snapshotsDir.fsPath, '__after__'));
        try {
            await vscode.workspace.fs.createDirectory(afterDir);
        }
        catch { }
        const snapshotLeftUris = {};
        const snapshotRightUrisForDeleted = {};
        if (checkpointRef) {
            for (const d of diffs) {
                try {
                    const leftText = await (0, git_1.getFileAtRef)(repoRoot, checkpointRef, d.path);
                    const leftSnap = vscode.Uri.file(path.join(snapshotsDir.fsPath, d.path));
                    const leftDirUri = vscode.Uri.file(path.dirname(leftSnap.fsPath));
                    try {
                        await vscode.workspace.fs.createDirectory(leftDirUri);
                    }
                    catch { }
                    if (leftText !== undefined) {
                        await vscode.workspace.fs.writeFile(leftSnap, Buffer.from(leftText, 'utf8'));
                    }
                    else {
                        await vscode.workspace.fs.writeFile(leftSnap, Buffer.alloc(0)); // new file then
                    }
                    snapshotLeftUris[d.path] = leftSnap;
                    const rightExists = await exists(d.right);
                    if (!rightExists) {
                        const rightSnap = vscode.Uri.file(path.join(afterDir.fsPath, d.path));
                        const rightDirUri = vscode.Uri.file(path.dirname(rightSnap.fsPath));
                        try {
                            await vscode.workspace.fs.createDirectory(rightDirUri);
                        }
                        catch { }
                        await vscode.workspace.fs.writeFile(rightSnap, Buffer.alloc(0)); // deleted in after
                        snapshotRightUrisForDeleted[d.path] = rightSnap;
                    }
                }
                catch { }
            }
        }
        ev.diffUris = diffs.map(d => ({
            path: d.path,
            left: (snapshotLeftUris[d.path] ?? d.left)?.toString(),
            right: (snapshotRightUrisForDeleted[d.path] ?? d.right)?.toString()
        }));
        await store.appendEvent(ev, maxEvents);
        touchedSinceCheckpoint.clear();
        store.session = { ...store.session, lastCheckpointSha: undefined };
        vscode.window.showInformationMessage(`Prompt Replay: logged prompt with ${ev.filesChanged.length} changed file(s).`);
    });
    const openTimeline = vscode.commands.registerCommand('promptReplay.openTimeline', async () => {
        const panel = timelinePanel_1.TimelinePanel.createOrShow(context);
        let mode = 'active';
        async function refresh() {
            const all = await store.readEvents();
            const trash = await store.readTrashIds();
            const sums = await store.readAllSummaries();
            const filtered = mode === 'trash'
                ? all.filter(ev => trash.has(ev.id))
                : all.filter(ev => !trash.has(ev.id));
            // pass the trash set so the panel knows which buttons to show
            panel.setEvents(filtered, sums, trash);
        }
        await refresh();
        panel.onMessage(async (msg) => {
            if (msg.type === 'openDiff') {
                const left = msg.left ? vscode.Uri.parse(msg.left) : undefined;
                const right = msg.right ? vscode.Uri.parse(msg.right) : undefined;
                if (left && right)
                    vscode.commands.executeCommand('vscode.diff', left, right, msg.title || 'Diff');
                else if (right)
                    vscode.window.showTextDocument(right);
                return;
            }
            if (msg.type === 'search') {
                // Extension filters on text, mode preserved
                const q = (msg.q || '').toLowerCase();
                const all = await store.readEvents();
                const trash = await store.readTrashIds();
                const sums = await store.readAllSummaries();
                const base = mode === 'trash'
                    ? all.filter(ev => trash.has(ev.id))
                    : all.filter(ev => !trash.has(ev.id));
                const filtered = !q ? base : base.filter(ev => ev.prompt.toLowerCase().includes(q) ||
                    ev.filesChanged.some(f => f.toLowerCase().includes(q)) ||
                    (ev.tags ?? []).some(t => t.toLowerCase().includes(q)));
                panel.setEvents(filtered, sums, trash);
                return;
            }
            if (msg.type === 'summarize' && msg.eventId) {
                const ev = (await store.readEvents()).find(e => e.id === msg.eventId);
                if (!ev) {
                    vscode.window.showWarningMessage('Event not found.');
                    return;
                }
                const perFile = [];
                for (const d of ev.diffUris || []) {
                    const leftUri = d.left ? vscode.Uri.parse(d.left) : undefined;
                    const rightUri = d.right ? vscode.Uri.parse(d.right) : undefined;
                    const lt = await readUtf8(leftUri);
                    const rt = await readUtf8(rightUri);
                    perFile.push({ path: d.path, before: lt?.text, after: rt?.text });
                }
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Prompt Replay: Summarizing diff…' }, async () => {
                    const summary = await (0, ai_1.summarizeWithVsCodeLM)(ev, perFile);
                    if (!summary) {
                        vscode.window.showInformationMessage('No language model available in VS Code.');
                        return;
                    }
                    await store.writeSummary(ev.id, summary);
                });
                await refresh();
                return;
            }
            // ---- TRASH / UNTRASH / DELETE PERMANENT ----
            if (msg.type === 'trashEvent' && msg.eventId) {
                await store.trashEvent(msg.eventId);
                await refresh();
                return;
            }
            if (msg.type === 'restoreFromTrash' && msg.eventId) {
                await store.untrashEvent(msg.eventId);
                await refresh();
                return;
            }
            if (msg.type === 'deletePermanent' && msg.eventId) {
                const ok = await vscode.window.showWarningMessage('Delete permanently? This removes the event, snapshots, summary, and exports (cannot be undone).', { modal: true }, 'Delete');
                if (ok === 'Delete') {
                    await store.deleteEventPermanent(msg.eventId);
                    await refresh();
                }
                return;
            }
            if (msg.type === 'switchMode' && (msg.mode === 'active' || msg.mode === 'trash')) {
                mode = msg.mode;
                await refresh();
                return;
            }
            // ---- RESTORE FILE / ALL ----
            if ((msg.type === 'restoreFile' || msg.type === 'restoreAll') && msg.eventId) {
                const ev = (await store.readEvents()).find(e => e.id === msg.eventId);
                if (!ev) {
                    vscode.window.showWarningMessage('Event not found.');
                    return;
                }
                const repoRoot = ev.repoRoot || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
                const side = msg.side === 'after' ? 'after' : 'before';
                const targets = msg.type === 'restoreFile'
                    ? (ev.diffUris || []).filter(d => d.path === msg.path)
                    : (ev.diffUris || []);
                if (!targets.length) {
                    vscode.window.showInformationMessage('No matching files to restore.');
                    return;
                }
                const title = msg.type === 'restoreFile'
                    ? `Restoring ${side} for ${msg.path}`
                    : `Restoring ${side} for ${targets.length} file(s)`;
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
                    for (const d of targets) {
                        const leftUri = d.left ? vscode.Uri.parse(d.left) : undefined;
                        const rightUri = d.right ? vscode.Uri.parse(d.right) : undefined;
                        const targetRel = d.path;
                        if (side === 'before') {
                            const left = await readUtf8(leftUri);
                            if (!left)
                                continue;
                            if ((left.size === 0) && ev.beforeRef) {
                                await deleteWorkspaceFile(repoRoot, targetRel);
                            }
                            else {
                                await writeWorkspaceFile(repoRoot, targetRel, left.text);
                            }
                        }
                        else {
                            const right = await readUtf8(rightUri);
                            if (!right)
                                continue;
                            const isSyntheticAfter = !!rightUri?.fsPath && rightUri.fsPath.includes(`${path.sep}__after__${path.sep}`);
                            if (isSyntheticAfter && right.size === 0) {
                                await deleteWorkspaceFile(repoRoot, targetRel);
                            }
                            else {
                                await writeWorkspaceFile(repoRoot, targetRel, right.text);
                            }
                        }
                    }
                });
                vscode.window.showInformationMessage('Restore complete.');
                return;
            }
        });
    });
    // Optional nudge for large edits
    const nudges = vscode.workspace.getConfiguration('promptReplay').get('autoNudgeLargeEdit', true);
    const lineThreshold = vscode.workspace.getConfiguration('promptReplay').get('largeEditLineThreshold', 20);
    let changeAccumulator = 0;
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (!nudges)
            return;
        changeAccumulator += e.contentChanges.reduce((acc, c) => acc + (c.text.split('\n').length - 1), 0);
        if (changeAccumulator >= (lineThreshold ?? 20)) {
            changeAccumulator = 0;
            vscode.window.showInformationMessage('Large edit detected. Log your prompt with: “Prompt Replay: Log Prompt…”.');
        }
    });
    context.subscriptions.push(startSession, createCheckpoint, logPrompt, openTimeline, changeSub);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map