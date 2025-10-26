"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimelinePanel = void 0;
const vscode = require("vscode");
class TimelinePanel {
    constructor(panel) {
        this.summaries = {};
        this.trashed = new Set();
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
    setEvents(events, summariesById, trashedIds) {
        this.summaries = summariesById || {};
        this.trashed = trashedIds ? new Set(trashedIds) : new Set();
        this.panel.webview.html = this.renderHtml(events || []);
    }
    onMessage(handler) {
        this.panel.webview.onDidReceiveMessage(handler);
    }
    esc(s) {
        return (s ?? '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    renderHtml(events) {
        const rows = (events ?? []).map(ev => {
            const ts = Number(ev.timestamp ?? Date.now());
            const id = this.esc(String(ev.id ?? `${ts}-${Math.random().toString(36).slice(2)}`));
            const date = new Date(ts).toLocaleString();
            const files = ev.filesChanged?.length ?? 0;
            const promptTxt = String(ev.prompt ?? '');
            const promptShort = promptTxt.length > 200 ? promptTxt.slice(0, 197) + '…' : promptTxt;
            const tags = (ev.tags ?? []).map(t => `<span class="tag">${this.esc(String(t))}</span>`).join(' ');
            const sum = this.summaries[id];
            const isTrashed = this.trashed.has(id);
            const fileRows = (ev.diffUris ?? []).map(d => {
                const left = d.left ?? '';
                const right = d.right ?? '';
                const encPath = encodeURIComponent(String(d.path ?? ''));
                return `
          <tr>
            <td class="path">${this.esc(String(d.path ?? ''))}</td>
            <td class="actions">
              <button class="btn" data-cmd="openDiff"
                data-left="${encodeURIComponent(left)}"
                data-right="${encodeURIComponent(right)}"
                data-title="${encodeURIComponent('Prompt Replay • ' + (d.path ?? ''))}">
                View Diff
              </button>
              <button class="btn" data-cmd="restoreFileBefore" data-event="${id}" data-path="${encPath}">Restore Before</button>
              <button class="btn" data-cmd="restoreFileAfter"  data-event="${id}" data-path="${encPath}">Restore After</button>
            </td>
          </tr>`;
            }).join('');
            const summaryBlock = sum ? `
        <div class="summary">
          <div class="summary-hdr">🧠 Summary <span class="meta">(${this.esc(sum.model)} • ${new Date(sum.createdAt).toLocaleString()})</span></div>
          <div class="overall">${this.esc(sum.overall || '')}</div>
          ${(sum.files || []).slice(0, 6).map(f => `<div class="file-sum"><span class="p">${this.esc(f.path)}:</span> ${this.esc(f.summary)}</div>`).join('')}
          ${(sum.files?.length || 0) > 6 ? `<div class="muted">…and ${sum.files.length - 6} more</div>` : ''}
        </div>
      ` : '';
            const sumBtnLabel = sum ? 'Regenerate Summary' : 'Summarize';
            const trashButtons = !isTrashed
                ? `<button class="btn warn" data-cmd="trashEvent" data-event="${id}">Move to Trash</button>`
                : `
           <button class="btn"      data-cmd="restoreFromTrash" data-event="${id}">Restore from Trash</button>
           <button class="btn warn" data-cmd="deletePermanent"  data-event="${id}">Delete Permanently</button>
          `;
            return `
        <div class="event" data-id="${id}" data-ts="${ts}">
          <div class="hdr">
            <button class="toggle" title="Collapse/Expand" data-cmd="toggle">▾</button>
            <span class="time">🕒 ${this.esc(date)}</span>
            <span class="files">📄 ${files} file${files === 1 ? '' : 's'}</span>
            <span class="spacer"></span>
            <button class="btn" data-cmd="summarize" data-event="${id}">${sumBtnLabel}</button>
            <button class="btn" data-cmd="restoreAllBefore" data-event="${id}">Restore Before (All)</button>
            <button class="btn" data-cmd="restoreAllAfter"  data-event="${id}">Restore After (All)</button>
            ${trashButtons}
          </div>
          <div class="prompt">“${this.esc(promptShort)}” ${tags}</div>
          <div class="body">
            ${summaryBlock}
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
    .event { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .hdr { display: flex; gap: 12px; font-size: 12px; opacity: 0.9; margin-bottom: 6px; align-items:center; }
    .spacer { flex: 1; }
    .prompt { margin: 6px 0 8px; font-weight: 600; }
    .body.hidden { display: none; }
    table.files { width: 100%; border-collapse: collapse; }
    td.path { padding: 6px 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    td.actions { text-align: right; padding: 6px 4px; }
    .tag { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:10px; border:1px solid var(--vscode-panel-border); font-size:11px; opacity:.8; }
    .muted { opacity:.7; }
    .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 8px; }
    .btn.warn { border-color: var(--vscode-editorWarning-foreground); }
    .toggle { border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground);
              color: var(--vscode-button-secondaryForeground); border-radius: 6px; padding: 2px 8px; }
    .summary { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 8px; margin: 6px 0 10px; }
    .summary-hdr { font-weight: 600; margin-bottom: 4px; }
    .summary .meta { opacity: .7; font-weight: 400; margin-left: 6px; }
    .file-sum .p { font-family: var(--vscode-editor-font-family); opacity: .9; }
    .modeBadge { opacity: .8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="search" placeholder="Search prompts/files/tags… (Enter or click Search)" />
    <button id="run">Search</button>
    <button id="clear">Clear</button>
    <button id="sort">Sort: Newest</button>
    <button id="collapseAll">Collapse all</button>
    <button id="expandAll">Expand all</button>
    <span class="spacer"></span>
    <span class="modeBadge" id="modeBadge"></span>
    <button id="toggleMode">Show Trash</button>
  </div>

  <div id="grid">
    ${rows || '<p class="muted">No events yet. Use “Prompt Replay: Create Checkpoint”, then “Log Prompt…”.</p>'}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const st = Object.assign({ q: '', sort: 'newest', collapsedIds: {}, mode: 'active' }, vscode.getState() || {});
    const search = document.getElementById('search');
    const btnRun = document.getElementById('run');
    const btnClear = document.getElementById('clear');
    const btnSort = document.getElementById('sort');
    const btnCollapseAll = document.getElementById('collapseAll');
    const btnExpandAll = document.getElementById('expandAll');
    const btnToggleMode = document.getElementById('toggleMode');
    const modeBadge = document.getElementById('modeBadge');
    const grid = document.getElementById('grid');

    function updateModeUI() {
      btnToggleMode.textContent = st.mode === 'active' ? 'Show Trash' : 'Show Active';
      modeBadge.textContent = st.mode === 'active' ? '' : 'Viewing: Trash';
    }

    search.value = st.q || '';
    btnSort.textContent = 'Sort: ' + (st.sort === 'oldest' ? 'Oldest' : 'Newest');
    updateModeUI();

    function applyCollapsedState() {
      for (const ev of grid.querySelectorAll('.event')) {
        const id = ev.getAttribute('data-id');
        const body = ev.querySelector('.body');
        const toggleBtn = ev.querySelector('.toggle');
        if (st.collapsedIds[id]) {
          body?.classList.add('hidden');
          if (toggleBtn) toggleBtn.textContent = '▸';
        } else {
          body?.classList.remove('hidden');
          if (toggleBtn) toggleBtn.textContent = '▾';
        }
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
      applyCollapsedState();
    }

    function runSearch() {
      const q = search.value;
      st.q = q;
      vscode.setState(st);
      vscode.postMessage({ type: 'search', q });
    }

    // toolbar handlers
    btnRun.addEventListener('click', runSearch);
    btnClear.addEventListener('click', () => { search.value = ''; runSearch(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    btnSort.addEventListener('click', () => { st.sort = (st.sort === 'newest' ? 'oldest' : 'newest'); applySort(); });
    btnCollapseAll.addEventListener('click', () => { for (const ev of grid.querySelectorAll('.event')) setCollapsed(ev, true); });
    btnExpandAll.addEventListener('click', () => { for (const ev of grid.querySelectorAll('.event')) setCollapsed(ev, false); });
    btnToggleMode.addEventListener('click', () => {
      st.mode = (st.mode === 'active' ? 'trash' : 'active');
      vscode.setState(st);
      updateModeUI();
      vscode.postMessage({ type: 'switchMode', mode: st.mode });
    });

    // body click
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const cmd = btn.getAttribute('data-cmd');

      if (btn.id === 'run' || btn.id === 'clear' || btn.id === 'sort' || btn.id === 'collapseAll' || btn.id === 'expandAll' || btn.id === 'toggleMode') return;

      if (cmd === 'toggle') {
        const evEl = btn.closest('.event');
        const collapsed = evEl.querySelector('.body')?.classList.contains('hidden');
        setCollapsed(evEl, !collapsed);
        return;
      }

      if (cmd === 'openDiff') {
        const left = decodeURIComponent(btn.dataset.left || '');
        const right = decodeURIComponent(btn.dataset.right || '');
        const title = decodeURIComponent(btn.dataset.title || 'Diff');
        vscode.postMessage({ type: 'openDiff', left, right, title });
        return;
      }

      if (cmd === 'summarize') {
        const eventId = btn.getAttribute('data-event');
        vscode.postMessage({ type: 'summarize', eventId });
        return;
      }

      if (cmd === 'restoreAllBefore' || cmd === 'restoreAllAfter') {
        const eventId = btn.getAttribute('data-event');
        const side = cmd.endsWith('Before') ? 'before' : 'after';
        vscode.postMessage({ type: 'restoreAll', eventId, side });
        return;
      }

      if (cmd === 'restoreFileBefore' || cmd === 'restoreFileAfter') {
        const eventId = btn.getAttribute('data-event');
        const pathEnc = btn.getAttribute('data-path') || '';
        const side = cmd.endsWith('Before') ? 'before' : 'after';
        vscode.postMessage({ type: 'restoreFile', eventId, path: decodeURIComponent(pathEnc), side });
        return;
      }

      if (cmd === 'trashEvent') {
        const eventId = btn.getAttribute('data-event');
        vscode.postMessage({ type: 'trashEvent', eventId });
        return;
      }
      if (cmd === 'restoreFromTrash') {
        const eventId = btn.getAttribute('data-event');
        vscode.postMessage({ type: 'restoreFromTrash', eventId });
        return;
      }
      if (cmd === 'deletePermanent') {
        const eventId = btn.getAttribute('data-event');
        vscode.postMessage({ type: 'deletePermanent', eventId });
        return;
      }
    });

    // initial
    applySort();
    applyCollapsedState();
  </script>
</body>
</html>`;
    }
}
exports.TimelinePanel = TimelinePanel;
//# sourceMappingURL=timelinePanel.js.map