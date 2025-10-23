"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Store = void 0;
const vscode = require("vscode");
const path = require("path");
class Store {
    constructor(ctx) {
        this.ctx = ctx;
    }
    rootFolder() {
        return vscode.workspace.workspaceFolders?.[0];
    }
    dirPath() {
        const root = this.rootFolder();
        if (!root)
            return;
        return path.join(root.uri.fsPath, '.promptreplay');
    }
    fileUri(filename) {
        const dir = this.dirPath();
        if (!dir)
            return;
        return vscode.Uri.file(path.join(dir, filename));
    }
    async ensureDir() {
        const dir = this.dirPath();
        if (!dir)
            return;
        const dUri = vscode.Uri.file(dir);
        try {
            await vscode.workspace.fs.stat(dUri);
        }
        catch {
            await vscode.workspace.fs.createDirectory(dUri);
        }
    }
    async appendEvent(ev, maxEvents) {
        await this.ensureDir();
        const file = this.fileUri('events.jsonl');
        if (!file)
            return;
        const line = Buffer.from(JSON.stringify(ev) + '\n');
        let content = line;
        try {
            const old = await vscode.workspace.fs.readFile(file);
            content = Buffer.concat([old, line]);
        }
        catch {
            // first write
        }
        // Trim if too many events
        const text = content.toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        if (lines.length > maxEvents) {
            const trimmed = lines.slice(lines.length - maxEvents).join('\n') + '\n';
            await vscode.workspace.fs.writeFile(file, Buffer.from(trimmed));
        }
        else {
            await vscode.workspace.fs.writeFile(file, content);
        }
    }
    async readEvents() {
        const file = this.fileUri('events.jsonl');
        if (!file)
            return [];
        try {
            const buf = await vscode.workspace.fs.readFile(file);
            const lines = Buffer.from(buf).toString('utf8').split('\n').filter(Boolean);
            return lines.map(l => JSON.parse(l));
        }
        catch {
            return [];
        }
    }
    get session() {
        return this.ctx.globalState.get('promptReplay.session', { active: false });
    }
    set session(s) {
        this.ctx.globalState.update('promptReplay.session', s);
    }
}
exports.Store = Store;
//# sourceMappingURL=store.js.map