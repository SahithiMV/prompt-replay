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
        this.panel.webview.html = this.renderHtml(events || []);
    }
    onMessage(handler) {
        this.panel.webview.onDidReceiveMessage(handler);
    }
    esc(s) {
        return (s ?? '').toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    renderHtml(events) {
        const rows = (events ?? []).map(ev => {
            const ts = Number(ev.timestamp ?? Date.now());
            const id = String(ev.id ?? `${ts}-${Math.random().toString(36).slice(2)}`);
            const date = new Date(ts).toLocaleString();
            const files = ev.filesChanged?.length ?? 0;
            const promptTxt = String(ev.prompt ?? '');
            const promptShort = promptTxt.length > 200 ? promptTxt.slice(0, 197) + '…' : promptTxt;
            const tags = (ev.tags ?? []).map(t => `<span class="tag">${this.esc(String(t))}</span>`).join(' ');
            const responsePreviewStr = ev.responsePreview ? String(ev.responsePreview) : '';
            const fileRows = (ev.diffUris ?? []).map(d => {
                const left = d.left ?? '';
                const right = d.right ?? '';
                const rel = String(d.path ?? '');
                return `
          <tr>
            <td class="path">${this.esc(rel)}</td>
            <td class="actions">
              <div class="row-actions">
                <button
                  class="btn"
                  data-cmd="openDiff"
                  data-left="${encodeURIComponent(left)}"
                  data-right="${encodeURIComponent(right)}"
                  data-title="${encodeURIComponent('Prompt Replay • ' + rel)}">
                  View Diff
                </button>
                <button class="btn small" data-cmd="restoreFile" data-id="${this.esc(id)}" data-path="${this.esc(rel)}" title="Restore this file to this version">
                  Restore file
                </button>
              </div>
            </td>
          </tr>`;
            }).join('');
            return `
        <div class="event" data-id="${this.esc(id)}" data-ts="${ts}">
          <div class="hdr">
            <button class="toggle" title="Collapse/Expand" data-cmd="toggle">▾</button>
            <span class="time">🕒 ${this.esc(date)}</span>
            <span class="files">📄 ${files} file${files === 1 ? '' : 's'}</span>
            <span class="spacer"></span>
            <button class="btn" data-cmd="exportEvent" data-id="${this.esc(id)}" title="Export this event to Markdown">
              Export
            </button>
            <button class="btn danger" data-cmd="restoreEvent" data-id="${this.esc(id)}" title="Restore workspace to this version">
              Restore
            </button>
          </div>
          <div class="prompt">“${this.esc(promptShort)}” ${tags}</div>
          <div class="body">
            ${responsePreviewStr ? `<div class="muted">↳ ${this.esc(responsePreviewStr)}</div>` : ''}
            <table class="files"><tbody>${fileRows}</tbody></table>
          </div>
        </div>`;
        }).join('');
        return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 10px; }
    .toolbar { display:flex; gap:8px; margin-bottom:10px; align-items:center; }
    input[type="text"] { flex:1; padding:6px; }
    button { cursor:pointer; }
    #grid { display:block; }
    .event { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .hdr { display: flex; gap: 12px; font-size: 12px; opacity: 0.9; margin-bottom: 6px; align-items:center; }
    .spacer { flex:1; }
    .toggle { border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground);
              color: var(--vscode-button-secondaryForeground); border-radius: 6px; padding: 2px 8px; }
    .prompt { margin: 6px 0 8px; font-weight: 600; }
    .body.hidden { display: none; }
    table.files { width: 100%; border-collapse: collapse; }
    td.path { padding: 6px 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    td.actions { text-align: right; padding: 6px 4px; }
    .tag { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:10px; border:1px solid var(--vscode-panel-border); font-size:11px; opacity:.8; }
    .muted { opacity:.7; }
    .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 8px; }
    .btn.danger { background: var(--vscode-inputValidation-errorBackground);
                  color: var(--vscode-errorForeground);
                  border-color: var(--vscode-inputValidation-errorBorder); }
    .row-actions { display: inline-flex; gap: 6px; align-items: center; }
    .btn.small { padding: 2px 6px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="search" placeholder="Search prompts/files/tags… (Enter or click Search)" />
    <button id="run">Search</button>
    <button id="sort">Sort: Newest</button>
    <button id="collapseAll" title="Collapse all">Collapse all</button>
    <button id="expandAll" title="Expand all">Expand all</button>
  </div>

  <div id="grid">
    ${rows || '<p class="muted">No events yet. Use “Prompt Replay: Create Checkpoint”, then “Log Prompt…”.</p>'}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const st = Object.assign({ q: '', sort: 'newest', collapsedIds: {} }, vscode.getState() || {});
    const search = document.getElementById('search');
    const btnRun = document.getElementById('run');
    const btnSort = document.getElementById('sort');
    const btnCollapseAll = document.getElementById('collapseAll');
    const btnExpandAll = document.getElementById('expandAll');
    const grid = document.getElementById('grid');

    search.value = st.q || '';
    btnSort.textContent = 'Sort: ' + (st.sort === 'oldest' ? 'Oldest' : 'Newest');

    // apply initial collapsed state
    for (const ev of grid.querySelectorAll('.event')) {
      const id = ev.getAttribute('data-id');
      const body = ev.querySelector('.body');
      const toggleBtn = ev.querySelector('.toggle');
      if (st.collapsedIds[id]) {
        body?.classList.add('hidden');
        if (toggleBtn) toggleBtn.textContent = '▸';
      } else {
        if (toggleBtn) toggleBtn.textContent = '▾';
      }
    }

    function setCollapsed(evEl, collapsed) {
      const id = evEl.getAttribute('data-id');
      const body = evEl.querySelector('.body');
      const toggleBtn = evEl.querySelector('.toggle');
      if (collapsed) {
        body?.classList.add('hidden');
        if (toggleBtn) toggleBtn.textContent = '▸';
        st.collapsedIds[id] = true;
      } else {
        body?.classList.remove('hidden');
        if (toggleBtn) toggleBtn.textContent = '▾';
        delete st.collapsedIds[id];
      }
      vscode.setState(st);
    }

    function applySort() {
      const cards = Array.from(grid.querySelectorAll('.event'));
      cards.sort((a, b) => {
        const ta = Number(a.getAttribute('data-ts') || '0');
        const tb = Number(b.getAttribute('data-ts') || '0');
        return st.sort === 'newest' ? (tb - ta) : (ta - tb);
      });
      grid.innerHTML = '';
      for (const c of cards) grid.appendChild(c);
      btnSort.textContent = 'Sort: ' + (st.sort === 'oldest' ? 'Oldest' : 'Newest');
      vscode.setState(st);

      // reapply collapsed arrows
      for (const ev of grid.querySelectorAll('.event')) {
        const id = ev.getAttribute('data-id');
        const body = ev.querySelector('.body');
        const toggleBtn = ev.querySelector('.toggle');
        if (st.collapsedIds[id]) {
          body?.classList.add('hidden');
          if (toggleBtn) toggleBtn.textContent = '▸';
        } else {
          if (toggleBtn) toggleBtn.textContent = '▾';
        }
      }
    }

    function runSearch() {
      const q = search.value;
      vscode.setState(Object.assign(st, { q }));
      vscode.postMessage({ type: 'search', q });
    }

    // toolbar handlers
    btnRun.addEventListener('click', runSearch);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    btnSort.addEventListener('click', () => { st.sort = (st.sort === 'newest' ? 'oldest' : 'newest'); applySort(); });
    btnCollapseAll.addEventListener('click', () => {
      for (const ev of grid.querySelectorAll('.event')) setCollapsed(ev, true);
    });
    btnExpandAll.addEventListener('click', () => {
      for (const ev of grid.querySelectorAll('.event')) setCollapsed(ev, false);
    });

    // body click: toggle / restore / export / openDiff / per-file restore
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const cmd = btn.getAttribute('data-cmd');
      if (btn.id === 'run' || btn.id === 'sort' || btn.id === 'collapseAll' || btn.id === 'expandAll') return;

      if (cmd === 'toggle') {
        const evEl = btn.closest('.event');
        const collapsed = evEl.querySelector('.body')?.classList.contains('hidden');
        setCollapsed(evEl, !collapsed);
        return;
      }

      if (cmd === 'exportEvent') {
        const id = btn.getAttribute('data-id');
        vscode.postMessage({ type: 'exportEvent', id });
        return;
      }

      if (cmd === 'restoreEvent') {
        const id = btn.getAttribute('data-id');
        vscode.postMessage({ type: 'restoreEvent', id }); // restore "this version" (after)
        return;
      }

      if (cmd === 'restoreFile') {
        const id = btn.getAttribute('data-id');
        const path = btn.getAttribute('data-path');
        vscode.postMessage({ type: 'restoreFile', id, path }); // restore file to "this version"
        return;
      }

      if (cmd === 'openDiff') {
        const left = decodeURIComponent(btn.dataset.left || '');
        const right = decodeURIComponent(btn.dataset.right || '');
        const title = decodeURIComponent(btn.dataset.title || 'Diff');
        vscode.postMessage({ type: 'openDiff', left, right, title });
        return;
      }
    });

    applySort();
  </script>
</body>
</html>`;
    }
}
exports.TimelinePanel = TimelinePanel;
//# sourceMappingURL=timelinePanel.js.map