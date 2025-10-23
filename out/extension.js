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
// Debug banner so you know activation happened
console.log('[Prompt Replay] activate()');
// Track files edited since last checkpoint
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
async function activate(context) {
    const store = new store_1.Store(context);
    // Track edits between checkpoint and logPrompt
    const editListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (!store.session.lastCheckpointSha)
            return; // only while a checkpoint is active
        if (e.document.uri.scheme !== 'file')
            return; // ignore virtual docs
        const rp = relPath(e.document.uri);
        if (rp)
            touchedSinceCheckpoint.add(rp);
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
        const api = await (0, git_1.getGitApi)();
        const repo = (0, git_1.primaryRepo)(api);
        const sha = (0, git_1.headSha)(repo) ?? `:working:${Date.now()}`;
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
        if (!prompt)
            return;
        const responsePreview = await vscode.window.showInputBox({ prompt: 'Optional: short response preview (or leave empty)' });
        const tagsStr = await vscode.window.showInputBox({ prompt: 'Optional: tags (comma-separated, e.g. bug fix, refactor)' });
        const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;
        const cfg = vscode.workspace.getConfiguration('promptReplay');
        const maxEvents = cfg.get('maxEvents', 2000);
        const api = await (0, git_1.getGitApi)();
        const repo = (0, git_1.primaryRepo)(api);
        let diffs = await (0, git_1.collectWorkingDiff)(repo);
        const repoRoot = store.session.repoRoot ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
        const checkpointRef = store.session.lastCheckpointSha;
        // --- Decide what to include ---
        if (checkpointRef) {
            // With checkpoint: ONLY include files touched since checkpoint
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
            // No checkpoint: allow logging current working changes, but bail if none
            if (diffs.length === 0) {
                vscode.window.showInformationMessage('Prompt Replay: no changes in the working tree — nothing to log.');
                return;
            }
        }
        // Build event scaffold first (id needed for snapshot path)
        const ev = {
            id: (0, crypto_1.randomUUID)(),
            timestamp: Date.now(),
            prompt,
            responsePreview: responsePreview || undefined,
            repoRoot,
            beforeRef: checkpointRef,
            afterRef: 'WORKING',
            filesChanged: diffs.map(d => d.path),
            diffUris: [], // fill below
            tags
        };
        // --- Snapshot "left" from checkpoint ref for accurate diffs ---
        // NEW file -> empty left
        // DELETED file -> empty right
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
                    // LEFT snapshot
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
                        // NEW FILE -> empty left to show additions
                        await vscode.workspace.fs.writeFile(leftSnap, Buffer.alloc(0));
                    }
                    snapshotLeftUris[d.path] = leftSnap;
                    // RIGHT snapshot for DELETED files
                    const rightExists = await exists(d.right);
                    if (!rightExists) {
                        const rightSnap = vscode.Uri.file(path.join(afterDir.fsPath, d.path));
                        const rightDirUri = vscode.Uri.file(path.dirname(rightSnap.fsPath));
                        try {
                            await vscode.workspace.fs.createDirectory(rightDirUri);
                        }
                        catch { }
                        await vscode.workspace.fs.writeFile(rightSnap, Buffer.alloc(0));
                        snapshotRightUrisForDeleted[d.path] = rightSnap;
                    }
                }
                catch {
                    // Snapshot errors are non-fatal; we'll fall back to Git API URIs
                }
            }
        }
        // Prefer our snapshots; fallback to Git API URIs
        const diffUris = diffs.map(d => {
            const leftUri = snapshotLeftUris[d.path] ?? d.left;
            const rightUri = snapshotRightUrisForDeleted[d.path] ?? d.right;
            return {
                path: d.path,
                left: leftUri?.toString(),
                right: rightUri?.toString()
            };
        });
        ev.diffUris = diffUris;
        // Persist event
        await store.appendEvent(ev, maxEvents);
        // Reset checkpoint & touched set so the next one is explicit
        touchedSinceCheckpoint.clear();
        store.session = { ...store.session, lastCheckpointSha: undefined };
        vscode.window.showInformationMessage(`Prompt Replay: logged prompt with ${ev.filesChanged.length} changed file(s).`);
    });
    const openTimeline = vscode.commands.registerCommand('promptReplay.openTimeline', async () => {
        const panel = timelinePanel_1.TimelinePanel.createOrShow(context);
        const eventsAll = await store.readEvents();
        panel.setEvents(eventsAll);
        panel.onMessage(async (msg) => {
            if (msg.type === 'openDiff') {
                const left = msg.left ? vscode.Uri.parse(msg.left) : undefined;
                const right = msg.right ? vscode.Uri.parse(msg.right) : undefined;
                if (left && right) {
                    vscode.commands.executeCommand('vscode.diff', left, right, msg.title || 'Diff');
                }
                else if (right) {
                    vscode.window.showTextDocument(right);
                }
            }
            else if (msg.type === 'search') {
                const q = (msg.q || '').toLowerCase();
                const all = await store.readEvents();
                const filtered = !q ? all : all.filter(ev => ev.prompt.toLowerCase().includes(q) ||
                    ev.filesChanged.some(f => f.toLowerCase().includes(q)) ||
                    (ev.tags ?? []).some(t => t.toLowerCase().includes(q)));
                timelinePanel_1.TimelinePanel.current?.setEvents(filtered);
            }
        });
    });
    // Optional: nudge on large edits
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