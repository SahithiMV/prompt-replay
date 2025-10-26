"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarizeWithVsCodeLM = summarizeWithVsCodeLM;
const vscode = require("vscode");
function truncate(s, max = 4000) {
    if (!s)
        return '';
    return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s;
}
/**
 * Try to summarize an event using VS Code's Language Model API.
 * - Gracefully returns undefined if the API/model isn't available.
 * - Keeps tokens in check by truncating diffs and capping files.
 */
async function summarizeWithVsCodeLM(event, perFile) {
    // Guard for older VS Code: access via "any" so TypeScript doesn't require the API.
    const anyVS = vscode;
    if (!anyVS.lm?.selectChatModels)
        return undefined;
    const models = await anyVS.lm.selectChatModels({});
    const model = models?.[0];
    if (!model?.sendRequest)
        return undefined;
    const ChatMsg = anyVS.LanguageModelChatMessage;
    if (!ChatMsg)
        return undefined;
    const system = ChatMsg.System([
        'You summarize code changes for a changelog.',
        'Be precise and concise. Avoid speculation.',
        'Return JSON with keys:',
        'overall: string',
        'files: array of { path: string, summary: string }',
        'categories: optional array from [bugfix, feature, refactor, docs, test, infra]'
    ].join(' '));
    const MAX_FILES = 8;
    const parts = [];
    parts.push(`Event: ${event.id}`);
    parts.push(`Prompt: ${event.prompt}`);
    parts.push(`Files changed: ${perFile.length}`);
    for (const f of perFile.slice(0, MAX_FILES)) {
        parts.push([
            `# ${f.path}`,
            `--- BEFORE ---`,
            truncate(f.before, 4000),
            `--- AFTER ---`,
            truncate(f.after, 4000)
        ].join('\n'));
    }
    const user = ChatMsg.User(parts.join('\n\n'));
    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest([system, user], {}, cts.token);
    let text = '';
    for await (const chunk of response.text)
        text += chunk;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        parsed = { overall: (text ?? '').toString().trim(), files: [] };
    }
    return {
        model: model?.name ?? 'vscode-lm',
        createdAt: Date.now(),
        promptTemplateHash: 'v1',
        overall: String(parsed.overall || '').slice(0, 2000),
        files: Array.isArray(parsed.files)
            ? parsed.files
                .map((x) => ({ path: String(x.path || ''), summary: String(x.summary || '') }))
                .slice(0, 20)
            : [],
        categories: Array.isArray(parsed.categories) ? parsed.categories.map(String) : undefined
    };
}
//# sourceMappingURL=ai.js.map