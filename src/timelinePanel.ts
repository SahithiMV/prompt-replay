import * as vscode from 'vscode';
import { PromptEvent } from './types';

export class TimelinePanel {
  public static current?: TimelinePanel;
  private panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
  }

  static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.ViewColumn.Active;
    if (TimelinePanel.current) {
      TimelinePanel.current.panel.reveal(column);
      return TimelinePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'promptReplay.timeline',
      'Prompt Replay Timeline',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const inst = new TimelinePanel(panel);
    TimelinePanel.current = inst;
    panel.onDidDispose(() => { TimelinePanel.current = undefined; });
    return inst;
  }

  setEvents(events: PromptEvent[]) {
    this.panel.webview.html = this.renderHtml(events || []);
  }

  onMessage(handler: (msg: any) => void) {
    this.panel.webview.onDidReceiveMessage(handler);
  }

  private esc(s: string): string {
    return (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  private renderHtml(events: PromptEvent[]): string {
    const rows = (events ?? []).slice().reverse().map(ev => {
      const date = new Date(ev.timestamp || Date.now()).toLocaleString();
      const files = ev.filesChanged?.length ?? 0;
      const promptTxt = String(ev.prompt ?? '');
      const promptShort = promptTxt.length > 200 ? promptTxt.slice(0,197) + '…' : promptTxt;
      const tags = (ev.tags ?? []).map(t => `<span class="tag">${this.esc(String(t))}</span>`).join(' ');

      const fileRows = (ev.diffUris ?? []).map(d => {
        const left = d.left ?? '';
        const right = d.right ?? '';
        return `
          <tr>
            <td class="path">${this.esc(String(d.path ?? ''))}</td>
            <td class="actions">
              <button
                data-left="${encodeURIComponent(left)}"
                data-right="${encodeURIComponent(right)}"
                data-title="${encodeURIComponent('Prompt Replay • ' + (d.path ?? ''))}">
                View Diff
              </button>
            </td>
          </tr>`;
      }).join('');

      const responsePreview = (ev as any).responsePreview
        ? `<div class="muted">↳ ${this.esc(String((ev as any).responsePreview))}</div>`
        : '';

      return `
        <div class="event">
          <div class="hdr">
            <span class="time">🕒 ${this.esc(date)}</span>
            <span class="files">📄 ${files} file${files === 1 ? '' : 's'}</span>
          </div>
          <div class="prompt">“${this.esc(promptShort)}” ${tags}</div>
          ${responsePreview}
          <table class="files"><tbody>${fileRows}</tbody></table>
        </div>`;
    }).join('');

    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 10px; }
    .toolbar { display:flex; gap:8px; margin-bottom:10px; }
    input[type="text"] { flex:1; padding:6px; }
    button { cursor:pointer; }
    .event { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .hdr { display: flex; gap: 12px; font-size: 12px; opacity: 0.85; margin-bottom: 6px; }
    .prompt { margin: 6px 0 8px; font-weight: 600; }
    table.files { width: 100%; border-collapse: collapse; }
    td.path { padding: 6px 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    td.actions { text-align: right; padding: 6px 4px; }
    .tag { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:10px; border:1px solid var(--vscode-panel-border); font-size:11px; opacity:.8; }
    .muted { opacity:.7; }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="search" placeholder="Search prompts/files/tags… (Enter or click Search)" />
    <button id="run">Search</button>
  </div>

  ${rows || '<p class="muted">No events yet. Use “Prompt Replay: Create Checkpoint”, then “Log Prompt…”.</p>'}

  <script>
    const vscode = acquireVsCodeApi();

    // Persist search text across renders
    const st = vscode.getState() || { q: '' };
    const search = document.getElementById('search');
    search.value = st.q || '';

    function runSearch() {
      const q = search.value;
      vscode.setState({ q });          // keep phrase (with spaces)
      vscode.postMessage({ type: 'search', q }); // ask extension to filter + re-render
    }

    document.getElementById('run').addEventListener('click', runSearch);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch();
    });

    // Open diffs
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.id === 'run') return;
      const left = decodeURIComponent(btn.dataset.left || '');
      const right = decodeURIComponent(btn.dataset.right || '');
      const title = decodeURIComponent(btn.dataset.title || 'Diff');
      vscode.postMessage({ type: 'openDiff', left, right, title });
    });
  </script>
</body>
</html>`;
  }
}
