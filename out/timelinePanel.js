"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimelinePanel = void 0;
const vscode = require("vscode");
class TimelinePanel {
    constructor(panel) {
        this.panel = panel;
    }
    static createOrShow(context) {
        const column = vscode.ViewColumn.Active;
        if (TimelinePanel.current) {
            TimelinePanel.current.panel.reveal(column);
            return TimelinePanel.current;
        }
        const panel = vscode.window.createWebviewPanel('promptReplay.timeline', 'Prompt Replay Timeline', column, { enableScripts: true, retainContextWhenHidden: true });
        const inst = new TimelinePanel(panel);
        TimelinePanel.current = inst;
        panel.onDidDispose(() => { TimelinePanel.current = undefined; });
        return inst;
    }
    setEvents(events) {
        const html = this.renderHtml(events);
        this.panel.webview.html = html;
    }
    onMessage(handler) {
        this.panel.webview.onDidReceiveMessage(handler);
    }
    renderHtml(events) {
        const rows = events
            .slice()
            .reverse()
            .map(ev => {
            const date = new Date(ev.timestamp).toLocaleString();
            const files = ev.filesChanged.length;
            const promptShort = ev.prompt.length > 160 ? ev.prompt.slice(0, 157) + '…' : ev.prompt;
            const fileRows = ev.diffUris.map((d, i) => {
                const left = d.left ?? '';
                const right = d.right ?? '';
                return `
            <tr>
              <td class="path">${d.path}</td>
              <td class="actions">
                <button data-ev="${ev.id}" data-left="${encodeURIComponent(left)}" data-right="${encodeURIComponent(right)}" data-title="${encodeURIComponent('Prompt Replay • ' + d.path)}">
                  View Diff
                </button>
              </td>
            </tr>
          `;
            }).join('');
            const tags = (ev.tags ?? []).map(t => `<span class="tag">${t}</span>`).join(' ');
            return `
          <div class="event">
            <div class="hdr">
              <span class="time">🕒 ${date}</span>
              <span class="files">📄 ${files} file${files === 1 ? '' : 's'}</span>
            </div>
            <div class="prompt">“${promptShort.replace(/</g, '&lt;')}” ${tags}</div>
            <table class="files">
              <tbody>${fileRows}</tbody>
            </table>
          </div>
        `;
        }).join('');
        return `
      <!doctype html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 10px; }
          .event { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
          .hdr { display: flex; gap: 12px; font-size: 12px; opacity: 0.8; margin-bottom: 6px; }
          .prompt { margin: 6px 0 8px; font-weight: 500; }
          table.files { width: 100%; border-collapse: collapse; }
          td.path { padding: 6px 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
          td.actions { text-align: right; padding: 6px 4px; }
          button { cursor: pointer; }
          .tag { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:10px; border:1px solid var(--vscode-panel-border); font-size:11px; opacity:.8; }
        </style>
      </head>
      <body>
        <div>
          <input id="search" placeholder="Search prompts/files…" style="width:100%;padding:6px;margin-bottom:10px;" />
        </div>
        ${rows || '<p>No events yet. Use “Prompt Replay: Create Checkpoint”, then “Log Prompt…”.</p>'}
        <script>
          const vscode = acquireVsCodeApi();
          document.body.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const left = decodeURIComponent(btn.dataset.left || '');
            const right = decodeURIComponent(btn.dataset.right || '');
            const title = decodeURIComponent(btn.dataset.title || 'Diff');
            vscode.postMessage({ type: 'openDiff', left, right, title });
          });

          const search = document.getElementById('search');
          search?.addEventListener('input', () => {
            vscode.postMessage({ type: 'search', q: search.value });
          });
        </script>
      </body>
      </html>
    `;
    }
}
exports.TimelinePanel = TimelinePanel;
//# sourceMappingURL=timelinePanel.js.map