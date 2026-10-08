import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { createEditor } from './editor.js';
import { parseDsEdit, previewOps, diffLines } from './dsedit.js';
import { detectSelfProject, isSelfFile, reloadModeFor, shouldIgnoreEntry, selfState } from './self.js';
import { createTerminal, destroyTerminal, fitTerminal, focusTerminal, hasTerminal } from './terminal.js';

/* ---------- Estado ---------- */
const state = {
  rootDir: null,
  tabs: new Map(),
  activePath: null,
  previewOpen: false,
  autoApply: false,
  undoStack: [],
  sidebarWidth: 240,
  previewWidth: 0,
  terminalOpen: false,
  panelTab: 'terminal',
  terminalCwd: null,
  zoom: 1,
};

/* ---------- Persistência ---------- */
const SESSION_KEY = 'dsedit.session.v1';
let saveSessionTimer = null;

function buildSession() {
  return {
    rootDir: state.rootDir,
    openPaths: Array.from(state.tabs.keys()),
    activePath: state.activePath,
    previewOpen: state.previewOpen,
    sidebarWidth: state.sidebarWidth,
    previewWidth: state.previewWidth,
    autoApply: state.autoApply,
    autoFix: errorState.autoFix,
    terminalOpen: state.terminalOpen,
    zoom: state.zoom,
  };
}

function saveSession() {
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(buildSession())); } catch (e) {}
  }, 400);
}

function saveSessionNow() {
  clearTimeout(saveSessionTimer);
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(buildSession())); } catch (e) {}
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

async function restoreSession() {
  const s = loadSession();
  if (!s) return;

  if (typeof s.autoApply === 'boolean') { state.autoApply = s.autoApply; updateAutoApplyBtn(); }
  if (typeof s.autoFix === 'boolean')    { errorState.autoFix = s.autoFix; updateAutoFixBtn(); }
  if (typeof s.zoom === 'number')        { applyZoom(s.zoom); }
  if (typeof s.sidebarWidth === 'number') {
    state.sidebarWidth = s.sidebarWidth;
    document.getElementById('sidebar').style.width = s.sidebarWidth + 'px';
  }
  if (typeof s.previewWidth === 'number' && s.previewWidth > 0) {
    state.previewWidth = s.previewWidth;
    previewPane.style.flex = `0 0 ${s.previewWidth}px`;
  }

  if (s.rootDir) {
    try {
      await invoke('list_dir', { path: s.rootDir });
      state.rootDir = s.rootDir;
      await renderTree();
      state.terminalCwd = s.rootDir;
    } catch (e) { state.rootDir = null; }
  }

  if (Array.isArray(s.openPaths) && s.openPaths.length > 0) {
    for (const p of s.openPaths) {
      try {
        const content = await invoke('read_file', { path: p });
        const name = p.split(/[\\/]/).pop();
        state.tabs.set(p, { path: p, name, content, dirty: false });
      } catch (e) {}
    }
  }

  if (s.activePath && state.tabs.has(s.activePath)) activateTab(s.activePath);
  else if (state.tabs.size > 0) activateTab(state.tabs.keys().next().value);

  if (s.previewOpen && state.activePath) openPreview();
  if (s.terminalOpen) setTimeout(() => togglePanel(true), 400);

  renderTabs();
}

/* ---------- Elementos ---------- */
const treeEl      = document.getElementById('tree');
const tabsEl      = document.getElementById('tabs');
const editorHost  = document.getElementById('editorPane');
const previewPane = document.getElementById('previewPane');
const previewFrame= document.getElementById('previewFrame');
const statusPath  = document.getElementById('statusPath');
const statusLang  = document.getElementById('statusLang');
const statusPos   = document.getElementById('statusPos');
const paletteEl   = document.getElementById('commandPalette');
const paletteInput= document.getElementById('paletteInput');
const paletteList = document.getElementById('paletteList');
const toastEl     = document.getElementById('toast');
const askInput    = document.getElementById('askInput');
const askAttachFile   = document.getElementById('askAttachFile');
const askAttachPrompt = document.getElementById('askAttachPrompt');
const btnAskSend      = document.getElementById('btnAskSend');
const btnAskContinue  = document.getElementById('btnAskContinue');
const btnFetch        = document.getElementById('btnFetch');
const btnDiag         = document.getElementById('btnDiag');
const btnAutoFix      = document.getElementById('btnAutoFix');
const btnFixErrors    = document.getElementById('btnFixErrors');
const errorBadge      = document.getElementById('errorBadge');
const btnSelf         = document.getElementById('btnSelf');
const btnReloadSelf   = document.getElementById('btnReloadSelf');
const selfBadge       = document.getElementById('selfBadge');
const btnSendContext  = document.getElementById('btnSendContext');
const contextBadge    = document.getElementById('contextBadge');
const panelWrap       = document.getElementById('panelWrap');
const terminalHost    = document.getElementById('terminalHost');
const problemsList    = document.getElementById('problemsList');
const problemsCount   = document.getElementById('problemsCount');
const outputLog       = document.getElementById('outputLog');

/* ---------- Editor ---------- */
const editor = createEditor(editorHost, {
  onChange: onEditorChange,
  onSave: saveActive,
  onPosChange: ({ line, col }) => { statusPos.textContent = `Ln ${line}, Col ${col}`; },
  onPalette: openPalette,
});

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.className = 'toast', kind === 'warn' ? 6000 : 3000);
}

/* ---------- Utils ---------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

/* ---------- Diagnóstico de rede (para o erro "network" da voz) ---------- */
async function pingUrl(url, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { method: 'GET', mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return { ok: true, status: r.status || 0 };
  } catch (e) {
    return { ok: false, error: (e && (e.name || e.message)) ? (e.name + ': ' + e.message) : String(e) };
  }
}

async function networkDiagnose() {
  const targets = [
    { name: 'Google Speech (Web Speech API)', url: 'https://www.google.com/speech-api/v2/recognize' },
    { name: 'Google (geral)',                 url: 'https://www.google.com/generate_204' },
    { name: 'DeepSeek (chat.deepseek.com)',   url: 'https://chat.deepseek.com/' },
    { name: 'Cloudflare (teste neutro)',      url: 'https://1.1.1.1/' },
  ];
  const results = [];
  for (const t of targets) {
    const r = await pingUrl(t.url, 3000);
    results.push({ alvo: t.name, ok: r.ok, detalhe: r.ok ? 'alcançável' : r.error });
  }
  console.table(results);
  return results;
}

/* ---------- Zoom / Acessibilidade ---------- */
function applyZoom(level) {
  const z = Math.max(0.5, Math.min(2.5, Number(level) || 1));
  state.zoom = z;
  document.body.style.zoom = String(z);
  try { localStorage.setItem('dsedit.zoom', String(z)); } catch (e) {}
  updateZoomLabel();
}
function zoomIn()    { applyZoom((state.zoom || 1) + 0.1); toast('🔍 Zoom: ' + Math.round(state.zoom * 100) + '%', 'ok'); }
function zoomOut()   { applyZoom((state.zoom || 1) - 0.1); toast('🔍 Zoom: ' + Math.round(state.zoom * 100) + '%', 'ok'); }
function zoomReset() { applyZoom(1); toast('🔍 Zoom: 100%', 'ok'); }
function updateZoomLabel() {
  const el = document.getElementById('zoomLabel');
  if (el) el.textContent = Math.round((state.zoom || 1) * 100) + '%';
}

async function testMic() {
  toast('🎤 Testando microfone...', 'ok');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('🎤 Mic API ausente neste ambiente', 'err');
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = stream.getAudioTracks();
    const label = tracks.map(t => t.label || '(sem nome)').join(', ') || 'dispositivo detectado';
    stream.getTracks().forEach(t => t.stop());
    toast('🎤 Mic OK: ' + label, 'ok');
    console.log('[voice] mic OK:', label);
    return true;
  } catch (e) {
    const msg = (e && (e.name || e.message)) ? (e.name + ' — ' + e.message) : String(e);
    toast('🎤 Mic FALHOU: ' + msg, 'err');
    console.warn('[voice] mic fail:', e);
    return false;
  }
}

/* ---------- Sidebar ---------- */
async function openFolder() {
  const path = await openDialog({ directory: true, multiple: false });
  if (!path) return;
  state.rootDir = path;
  state.terminalCwd = path;
  contextState.sent = false;
  updateContextBadge();
  renderTree();
  saveSession();
  refreshSelfState();
  if (state.terminalOpen && hasTerminal()) {
    // reinicia terminal na nova pasta
    await destroyTerminal();
    await createTerminal(terminalHost, state.terminalCwd);
  }
}

async function renderTree() {
  treeEl.innerHTML = '';
  if (!state.rootDir) {
    treeEl.innerHTML = '<div style="padding:12px;color:var(--fg3);font-size:12px">Nenhuma pasta aberta</div>';
    return;
  }
  const container = document.createElement('div');
  await buildTree(state.rootDir, container, 0);
  treeEl.appendChild(container);
}

async function buildTree(path, parent, depth) {
  let entries;
  try {
    entries = await invoke('list_dir', { path });
  } catch (e) { console.error(e); return; }

  entries = entries.filter(e => !shouldIgnoreEntry(e));

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'tree-item';
    if (selfState.rootDir && isSelfFile(entry.path, selfState.rootDir)) {
      row.classList.add('self-file');
    }
    row.style.paddingLeft = (12 + depth * 12) + 'px';
    row.title = entry.path;

    const icon = document.createElement('span');
    icon.className = 'ic';
    icon.textContent = entry.is_dir ? '▸' : '·';

    const name = document.createElement('span');
    name.textContent = entry.name;
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';

    row.append(icon, name);
    parent.appendChild(row);

    if (entry.is_dir) {
      const childBox = document.createElement('div');
      childBox.className = 'tree-children';
      childBox.style.display = 'none';
      parent.appendChild(childBox);

      let loaded = false;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const open = childBox.style.display !== 'none';
        if (!open && !loaded) {
          await buildTree(entry.path, childBox, depth + 1);
          loaded = true;
        }
        childBox.style.display = open ? 'none' : 'block';
        icon.textContent = open ? '▾' : '▸';
      });
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        openFile(entry.path);
      });
    }
  }
}

/* ---------- Arquivos ---------- */
async function openFile(path) {
  if (state.tabs.has(path)) { activateTab(path); return; }
  try {
    const content = await invoke('read_file', { path });
    const name = path.split(/[\\/]/).pop();
    state.tabs.set(path, { path, name, content, dirty: false });
    activateTab(path);
    saveSession();
  } catch (e) {
    toast('Erro abrindo arquivo: ' + e, 'err');
  }
}

function activateTab(path) {
  state.activePath = path;
  const tab = state.tabs.get(path);
  if (!tab) return;

  editor.setValue(tab.content, tab.name);
  editor.focus();

  statusPath.textContent = tab.path;
  const ext = (tab.name.split('.').pop() || '').toLowerCase();
  statusLang.textContent = ext ? ext.toUpperCase() : '—';

  clearPreviewErrors();
  renderTabs();
  updatePreview();
  saveSession();
}

function closeTab(path) {
  const tab = state.tabs.get(path);
  if (tab?.dirty) {
    if (!confirm(`"${tab.name}" tem alterações não salvas. Fechar mesmo assim?`)) return;
  }
  state.tabs.delete(path);
  if (state.activePath === path) {
    state.activePath = state.tabs.keys().next().value || null;
    if (state.activePath) activateTab(state.activePath);
    else {
      editor.setValue('', '');
      statusPath.textContent = 'nenhum arquivo';
      statusLang.textContent = '—';
    }
  }
  renderTabs();
  saveSession();
}

function onEditorChange(text) {
  if (!state.activePath) return;
  const tab = state.tabs.get(state.activePath);
  if (!tab) return;
  if (tab.content === text) return;
  tab.content = text;
  tab.dirty = true;
  renderTabs();
  if (state.previewOpen) schedulePreview();
}

async function saveActive() {
  if (!state.activePath) return;
  const tab = state.tabs.get(state.activePath);
  if (!tab) return;
  try {
    await invoke('write_file', { path: tab.path, content: tab.content });
    tab.dirty = false;
    renderTabs();
    saveSessionNow();

    if (selfState.active || isSelfFile(tab.path, selfState.rootDir)) {
      const rule = reloadModeFor(tab.path);
      if (rule) {
        if (rule.mode === 'rust') toast('🦀 ' + rule.msg, 'warn');
        else toast(rule.msg, 'ok');
      } else {
        toast('Salvo (self): ' + tab.name, 'ok');
      }
    } else {
      toast('Salvo: ' + tab.name, 'ok');
    }
  } catch (e) {
    toast('Erro salvando: ' + e, 'err');
  }
}

/* ---------- Tabs ---------- */
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const [path, tab] of state.tabs) {
    const ext = (tab.name.split('.').pop() || '').toLowerCase();
    const el = document.createElement('div');
    el.className = 'tab' + (path === state.activePath ? ' active' : '');
    el.dataset.lang = ext;

    const dot = document.createElement('span');
    dot.className = 'dot';
    if (tab.dirty) dot.style.background = 'var(--acc)';

    const label = document.createElement('span');
    label.textContent = tab.name;

    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(path); });

    el.append(dot, label, x);
    el.addEventListener('click', () => activateTab(path));
    tabsEl.appendChild(el);
  }
}

/* ============================================================
   CAPTURA DE ERROS DO PREVIEW
   ============================================================ */
const errorState = {
  errors: [],
  lastSentHash: '',
  attempts: 0,
  maxAttempts: 3,
  autoFix: false,
  pendingFix: false,
  cooldownUntil: 0,
};

function clearPreviewErrors() {
  errorState.errors = [];
  errorState.pendingFix = false;
  updateErrorBadge();
}

function updateErrorBadge() {
  const n = errorState.errors.length;
  if (errorBadge) {
    errorBadge.textContent = String(n);
    errorBadge.classList.toggle('show', n > 0);
  }
  if (btnFixErrors) {
    btnFixErrors.classList.toggle('has-errors', n > 0);
    btnFixErrors.title = n > 0 ? `Enviar ${n} erro(s) ao DeepSeek` : 'Nenhum erro no preview';
  }
  if (problemsCount) problemsCount.textContent = String(n);
  if (problemsList) {
    problemsList.innerHTML = '';
    if (n === 0) {
      problemsList.innerHTML = '<div style="color:var(--fg3);padding:16px;font-size:12.5px">Nenhum problema detectado</div>';
    } else {
      errorState.errors.forEach(e => {
        const el = document.createElement('div');
        el.className = 'problem-item';
        el.innerHTML = `<span class="sev">●</span><span>${escapeHtml(e.message || '')}${e.lineno ? ` <span style="color:var(--fg3)">(linha ${e.lineno})</span>` : ''}</span>`;
        problemsList.appendChild(el);
      });
    }
  }
}

function hashError(e) {
  const s = (e.type || '') + '|' + (e.message || '') + '|' + (e.lineno || '') + '|' + (e.colno || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

window.addEventListener('message', (e) => {
  if (!e.data || !e.data.__dsedit) return;
  const { type, data } = e.data;

  if (type === 'ready') { console.log('[preview] iframe pronto'); return; }

  if (type === 'error' || type === 'unhandledrejection' || type === 'console.error') {
    const hash = hashError(data);
    if (errorState.errors.some(x => hashError(x) === hash)) return;
    errorState.errors.push({ ...data, type, at: Date.now() });
    updateErrorBadge();
    console.log('[preview] erro capturado:', data);
    if (errorState.autoFix) scheduleAutoFix();
  }
});

let autoFixTimer = null;
function scheduleAutoFix() {
  clearTimeout(autoFixTimer);
  autoFixTimer = setTimeout(maybeSendErrorFix, 1500);
}

function maybeSendErrorFix() {
  if (!errorState.autoFix) return;
  if (errorState.pendingFix) return;
  if (errorState.errors.length === 0) return;
  if (errorState.attempts >= errorState.maxAttempts) {
    toast(`⚠️ Auto-fix: limite de ${errorState.maxAttempts} tentativas atingido`, 'err');
    return;
  }
  if (Date.now() < errorState.cooldownUntil) return;
  if (autoLoop.running) return;

  const first = errorState.errors[0];
  const hash = hashError(first);
  if (hash === errorState.lastSentHash) return;

  errorState.lastSentHash = hash;
  errorState.attempts++;
  errorState.pendingFix = true;
  errorState.cooldownUntil = Date.now() + 30000;

  sendErrorsToDeepSeek(true);
}

async function sendErrorsToDeepSeek(auto) {
  if (!state.activePath) { toast('Nenhum arquivo aberto', 'err'); return; }
  if (errorState.errors.length === 0) { toast('Nenhum erro para enviar', 'err'); return; }

  const tab = state.tabs.get(state.activePath);
  if (!tab) return;

  const codeLines = tab.content.split('\n');
  const w = String(codeLines.length).length;
  const numbered = codeLines.map((l, i) => String(i + 1).padStart(w, ' ') + '| ' + l).join('\n');

  const errParts = errorState.errors.map((e, i) => {
    const parts = [`Erro ${i + 1} (${e.type}):`];
    if (e.message) parts.push(`  Mensagem: ${e.message}`);
    if (e.lineno)  parts.push(`  Linha: ${e.lineno}${e.colno ? ', coluna ' + e.colno : ''}`);
    if (e.stack)   parts.push(`  Stack: ${e.stack.split('\n').slice(0, 4).join('\n    ')}`);
    return parts.join('\n');
  }).join('\n\n');

  const payload = [
    DSEDIT_PROMPT, '', '---', '',
    'O arquivo abaixo está com erro em tempo de execução.',
    'Corrija usando SEARCH/REPLACE. NÃO reescreva o arquivo inteiro.',
    '', `Arquivo: \`${tab.name}\``, '', '```', numbered, '```',
    '', 'Erros detectados no preview:', '', errParts, '',
    'Pedido: corrija o(s) erro(s) acima mantendo o resto do código igual.',
  ].join('\n');

  try {
    await invoke('open_deepseek');
    await invoke('send_to_deepseek', { payload });
    toast(auto ? '🐛 Erros enviados automaticamente' : '🐛 Erros enviados', 'ok');
    try { await invoke('write_clipboard', { text: '' }); } catch (e) {}
    setTimeout(startAutoLoop, 1500);
  } catch (e) {
    toast('Erro enviando: ' + e, 'err');
    errorState.pendingFix = false;
  }
}

function updateAutoFixBtn() {
  if (!btnAutoFix) return;
  if (errorState.autoFix) {
    btnAutoFix.textContent = 'Fix: ON';
    btnAutoFix.style.background = 'linear-gradient(135deg,#f05252,#c93636)';
    btnAutoFix.style.borderColor = '#c93636';
    btnAutoFix.style.color = '#fff';
    btnAutoFix.style.fontWeight = '800';
  } else {
    btnAutoFix.textContent = 'Fix: OFF';
    btnAutoFix.style.background = '';
    btnAutoFix.style.borderColor = '';
    btnAutoFix.style.color = '';
    btnAutoFix.style.fontWeight = '';
  }
}

if (btnAutoFix) {
  btnAutoFix.addEventListener('click', () => {
    errorState.autoFix = !errorState.autoFix;
    if (errorState.autoFix) { errorState.attempts = 0; errorState.lastSentHash = ''; }
    updateAutoFixBtn();
    saveSession();
    toast('Auto-fix: ' + (errorState.autoFix ? 'LIGADO' : 'desligado'), 'ok');
  });
}

if (btnFixErrors) {
  btnFixErrors.addEventListener('click', () => {
    if (errorState.errors.length === 0) { toast('Nenhum erro capturado', 'err'); return; }
    errorState.attempts = 0;
    errorState.lastSentHash = '';
    sendErrorsToDeepSeek(false);
  });
}

function injectErrorHandler(html) {
  const handler = `
<script>
(function(){
  function send(type, data) {
    try { parent.postMessage({ __dsedit: true, type: type, data: data }, '*'); } catch(e) {}
  }
  window.addEventListener('error', function(e){
    send('error', { message: e.message, lineno: e.lineno, colno: e.colno,
      stack: e.error && e.error.stack ? String(e.error.stack) : '' });
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    send('unhandledrejection', {
      message: String(r && r.message ? r.message : r),
      stack: r && r.stack ? String(r.stack) : '' });
  });
  var origError = console.error;
  console.error = function(){
    var args = [].slice.call(arguments).map(function(a){
      try { return typeof a === 'string' ? a : JSON.stringify(a); } catch(e) { return String(a); }
    });
    send('console.error', { message: args.join(' ') });
    origError.apply(console, arguments);
  };
  send('ready', {});
})();
<\/script>
`;
  if (html.includes('</head>')) return html.replace('</head>', handler + '</head>');
  if (html.includes('<head>'))  return html.replace('<head>', '<head>' + handler);
  return handler + html;
}

/* ---------- Preview ---------- */
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 300);
}

function buildCssPreview(css) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>
    <body style="font-family:system-ui;padding:24px">
    <h1>Título de exemplo</h1>
    <p>Parágrafo com <a href="#">link</a> e <strong>negrito</strong>.</p>
    <button>Botão</button>
    <div style="margin-top:16px;padding:12px;border:1px solid #ccc;border-radius:8px">Caixa</div>
    </body></html>`;
}

function buildJsPreview(js) {
  const safe = js.replace(/<\/(script)/gi, '<\\/$1');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:ui-monospace,monospace;background:#0f1115;color:#e6e8eb;padding:16px;margin:0}
    pre{white-space:pre-wrap}
  </style></head><body><pre id="__out"></pre>
<script>
(function(){
  var o = document.getElementById('__out');
  function w(){
    var a = [].slice.call(arguments);
    o.textContent += a.map(function(x){
      try { return typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x); }
      catch(e){ return String(x); }
    }).join(' ') + '\\n';
  }
  console.log = console.info = console.warn = console.error = w;
  window.addEventListener('error', function(e){
    w('ERRO:', e.message + (e.lineno ? ' (linha ' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function(e){
    w('ERRO (promise):', String(e.reason && e.reason.message ? e.reason.message : e.reason));
  });
})();
<\/script>
<script>
${safe}
<\/script></body></html>`;
}

function renderMarkdown(src) {
  const blocks = [];
  const t = escapeHtml(src).replace(/```[^\n]*\n([\s\S]*?)```/g, (m, c) => {
    blocks.push('<pre><code>' + c + '</code></pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  const out = [];
  let list = false, para = [];
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeL = () => { if (list) { out.push('</ul>'); list = false; } };

  for (const line of t.split('\n')) {
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { flushP(); closeL(); out.push(line.trim()); }
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushP(); closeL();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushP();
      if (!list) { out.push('<ul>'); list = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
    }
    else if (!line.trim()) { flushP(); closeL(); }
    else { closeL(); para.push(line); }
  }
  flushP(); closeL();
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
}

function buildMdPreview(md) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui;max-width:720px;margin:32px auto;padding:0 20px;line-height:1.6;color:#e6e8eb;background:#0f1115}
    pre{background:#16181d;padding:12px;border-radius:8px;overflow:auto}
    code{background:#16181d;padding:2px 6px;border-radius:4px}
    a{color:#4d7cfe}
    h1,h2,h3{border-bottom:1px solid #232733;padding-bottom:6px}
  </style></head><body>${renderMarkdown(md)}</body></html>`;
}

function buildPreviewHtml() {
  if (!state.activePath) return '';
  const tab = state.tabs.get(state.activePath);
  if (!tab) return '';
  const ext = (tab.name.split('.').pop() || '').toLowerCase();

  if (['html','htm','xhtml'].includes(ext)) return injectErrorHandler(tab.content);
  if (ext === 'css') return injectErrorHandler(buildCssPreview(tab.content));
  if (['js','mjs','cjs'].includes(ext)) return injectErrorHandler(buildJsPreview(tab.content));
  if (['md','markdown'].includes(ext)) return buildMdPreview(tab.content);
  return `<pre style="padding:16px;font-family:ui-monospace;white-space:pre-wrap">${escapeHtml(tab.content)}</pre>`;
}

function buildPreviewHtmlForWindow() {
  if (!state.activePath) return '';
  const tab = state.tabs.get(state.activePath);
  if (!tab) return '';
  const ext = (tab.name.split('.').pop() || '').toLowerCase();

  if (['html','htm','xhtml'].includes(ext)) return tab.content;
  if (ext === 'css') return buildCssPreview(tab.content);
  if (['js','mjs','cjs'].includes(ext)) return buildJsPreview(tab.content);
  if (['md','markdown'].includes(ext)) return buildMdPreview(tab.content);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="background:#1e1e1e;color:#ccc;padding:20px;font-family:monospace;white-space:pre-wrap">${escapeHtml(tab.content)}</body></html>`;
}

function updatePreview() {
  if (!state.previewOpen) return;
  clearPreviewErrors();
  previewFrame.srcdoc = buildPreviewHtml();
}

function openPreview() {
  state.previewOpen = true;
  previewPane.classList.add('open');
  if (state.previewWidth > 0) previewPane.style.flex = `0 0 ${state.previewWidth}px`;
  updatePreview();
  saveSession();
}
function closePreview() {
  state.previewOpen = false;
  previewPane.classList.remove('open');
  saveSession();
}

document.getElementById('btnClosePreview').addEventListener('click', closePreview);
document.getElementById('btnReloadPreview').addEventListener('click', updatePreview);

const btnFullPreview    = document.getElementById('btnFullPreview');
const btnPopoutPreview  = document.getElementById('btnPopoutPreview');
const btnRunPreview     = document.getElementById('btnRunPreview');

if (btnFullPreview) {
  btnFullPreview.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === previewFrame) await document.exitFullscreen();
      else {
        await previewFrame.requestFullscreen();
        setTimeout(() => { try { previewFrame.focus(); } catch(e) {} }, 100);
      }
    } catch (e) { toast('Fullscreen falhou: ' + e.message, 'err'); }
  });
}

async function popoutPreview() {
  if (!state.activePath) { toast('Nenhum arquivo aberto', 'err'); return; }
  const tab = state.tabs.get(state.activePath);
  if (!tab) return;
  const html = buildPreviewHtmlForWindow();
  try {
    await invoke('open_preview_window', { html, title: '▶ ' + tab.name });
    toast('🖥️ Aberto em janela própria', 'ok');
  } catch (e) { toast('Erro: ' + e, 'err'); }
}

if (btnPopoutPreview) btnPopoutPreview.addEventListener('click', popoutPreview);
if (btnRunPreview)    btnRunPreview.addEventListener('click', popoutPreview);

/* ---------- Command palette ---------- */
const COMMANDS = [
  { id:'open-folder', label:'Abrir pasta…',      k:'Ctrl+O', run: openFolder },
  { id:'save',        label:'Salvar arquivo',    k:'Ctrl+S', run: saveActive },
  { id:'close-tab',   label:'Fechar aba atual',  k:'Ctrl+W', run: () => state.activePath && closeTab(state.activePath) },
  { id:'preview',     label:'Alternar preview',  k:'Ctrl+P', run: () => state.previewOpen ? closePreview() : openPreview() },
  { id:'run-preview', label:'▶ Executar em janela própria', k:'F5', run: popoutPreview },
  { id:'full-preview',label:'⛶ Preview em tela cheia', k:'F11', run: () => btnFullPreview && btnFullPreview.click() },
  { id:'terminal',    label:'Alternar terminal', k:'Ctrl+`', run: () => togglePanel() },
  { id:'deepseek',    label:'Abrir DeepSeek',    k:'',        run: () => invoke('open_deepseek') },
  { id:'ask',         label:'Focar barra de pergunta', k:'Ctrl+Enter', run: () => askInput.focus() },
  { id:'fetch',       label:'Puxar último bloco do chat', k:'', run: fetchLatestBlock },
  { id:'fix',         label:'Corrigir erros do preview', k:'', run: () => sendErrorsToDeepSeek(false) },
  { id:'context',     label:'📦 Enviar contexto do projeto', k:'', run: () => sendProjectContext(false) },
  { id:'dsedit',      label:'Colar bloco DSEDIT',k:'Ctrl+Shift+V', run: () => openDsedit() },
  { id:'new-file',    label:'Novo arquivo…',     k:'',        run: newFileDialog },
  { id:'reload-tree', label:'Recarregar árvore', k:'',        run: renderTree },
  { id:'self-open',   label:'🛠️ Abrir projeto do DSedit (self-hosting)', k:'F9', run: openSelfProject },
  { id:'self-reload', label:'🔄 Recarregar o editor', k:'',   run: () => location.reload() },
  { id:'clear-session',label:'Limpar sessão salva', k:'',     run: clearSession },
  { id:'auto-loop-toggle',label:'Ligar/desligar auto-loop', k:'', run: () => autoLoop.running ? stopAutoLoop() : startAutoLoop() },
  { id:'auto-fix-toggle',label:'Ligar/desligar auto-fix', k:'', run: () => btnAutoFix && btnAutoFix.click() },
  { id:'voice-toggle',  label:'Alternar microfone (comandos de voz)', k:'Ctrl+Shift+M', run: () => toggleVoice() },
  { id:'voice-help',    label:'Ajuda de voz (listar comandos)',       k:'',             run: voiceHelp },
  { id:'voice-dict',    label:'Alternar modo ditado por voz',          k:'',             run: () => setDictation(!voiceState.dictationMode) },
  { id:'prompt-focus',  label:'Focar + selecionar barra de prompt',    k:'Ctrl+Enter',   run: () => { askInput.focus(); askInput.select(); } },
  { id:'zoom-in',       label:'🔍 Aumentar zoom',   k:'Ctrl+=', run: zoomIn },
  { id:'zoom-out',      label:'🔍 Diminuir zoom',   k:'Ctrl+-', run: zoomOut },
  { id:'zoom-reset',    label:'🔍 Resetar zoom',    k:'Ctrl+0', run: zoomReset },
  { id:'mic-test',      label:'🎤 Testar microfone', k:'',       run: testMic },
  { id:'voice-diag',    label:'🔬 Diagnóstico de voz + rede', k:'', run: diagnoseVoice },
  { id:'chatgpt-open',  label:'💬 Abrir ChatGPT (auto-push pro DeepSeek)', k:'', run: () => invoke('open_chatgpt') },
  { id:'chatgpt-on',    label:'💬 Ligar auto-push do ChatGPT',  k:'', run: () => setChatGPTAutoPush(true) },
  { id:'chatgpt-off',   label:'💬 Desligar auto-push do ChatGPT', k:'', run: () => setChatGPTAutoPush(false) },
  { id:'net-diag',      label:'🌐 Diagnóstico de rede',       k:'', run: async () => { const r = await networkDiagnose(); const ok = r.filter(x => x.ok).length; toast(`🌐 Rede: ${ok}/${r.length} alvos OK (veja console)`, ok === r.length ? 'ok' : 'warn'); } },
  { id:'chatgpt-open',  label:'💬 Abrir ChatGPT (auto-push pro DeepSeek)', k:'', run: () => invoke('open_chatgpt') },
  { id:'chatgpt-on',    label:'💬 Ligar auto-push do ChatGPT',  k:'', run: () => setChatGPTAutoPush(true) },
  { id:'chatgpt-off',   label:'💬 Desligar auto-push do ChatGPT', k:'', run: () => setChatGPTAutoPush(false) },
];

function openPalette() {
  paletteEl.classList.add('open');
  paletteInput.value = '';
  paletteInput.focus();
  renderPalette('');
}
function closePalette() { paletteEl.classList.remove('open'); }

function renderPalette(q) {
  q = q.toLowerCase();
  const list = q ? COMMANDS.filter(c => c.label.toLowerCase().includes(q) || c.id.includes(q)) : COMMANDS;
  paletteList.innerHTML = '';
  if (list.length === 0) {
    paletteList.innerHTML = '<div style="padding:16px;color:var(--fg3);text-align:center">Nenhum comando</div>';
    return;
  }
  list.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'palette-item' + (i === 0 ? ' sel' : '');
    el.innerHTML = `<span>${c.label}</span>${c.k ? `<span class="k">${c.k}</span>` : ''}`;
    el.addEventListener('click', () => { closePalette(); c.run(); });
    paletteList.appendChild(el);
  });
  paletteList._filtered = list;
  paletteList._idx = 0;
}

paletteInput.addEventListener('input', () => renderPalette(paletteInput.value));
paletteInput.addEventListener('keydown', (e) => {
  const list = paletteList._filtered || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteList._idx = Math.min(list.length - 1, (paletteList._idx || 0) + 1); highlightPalette(); }
  if (e.key === 'ArrowUp')   { e.preventDefault(); paletteList._idx = Math.max(0, (paletteList._idx || 0) - 1); highlightPalette(); }
  if (e.key === 'Enter') {
    e.preventDefault();
    const item = list[paletteList._idx || 0];
    if (item) { closePalette(); item.run(); }
  }
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
paletteEl.addEventListener('mousedown', (e) => { if (e.target === paletteEl) closePalette(); });
function highlightPalette() {
  const items = paletteList.querySelectorAll('.palette-item');
  items.forEach((el, i) => el.classList.toggle('sel', i === paletteList._idx));
}

function clearSession() {
  if (!confirm('Limpar sessão salva? As próximas aberturas começarão em branco.')) return;
  localStorage.removeItem(SESSION_KEY);
  toast('Sessão limpa', 'ok');
}

/* ---------- Novo arquivo ---------- */
async function newFileDialog() {
  if (!state.rootDir) { toast('Abra uma pasta primeiro', 'err'); return; }
  const name = prompt('Nome do arquivo:', 'novo.html');
  if (!name) return;
  const path = state.rootDir.replace(/[\\/]$/, '') + '/' + name;
  try {
    await invoke('create_file', { path });
    await renderTree();
    await openFile(path);
  } catch (e) { toast('Erro: ' + e, 'err'); }
}

/* ---------- Resizers ---------- */
function setupResizer(id, target, dir, min, max, onEnd) {
  const el = document.getElementById(id);
  let dragging = false, startPos = 0, startSize = 0;

  el.addEventListener('mousedown', (e) => {
    dragging = true;
    el.classList.add('dragging');
    startPos = dir === 'x' ? e.clientX : e.clientY;
    startSize = dir === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = (dir === 'x' ? e.clientX : e.clientY) - startPos;
    const next = Math.max(min, Math.min(max, startSize + delta));
    if (dir === 'x') target.style.flex = `0 0 ${next}px`;
    else target.style.height = next + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    if (onEnd) onEnd();
  });
}

const sidebarEl = document.getElementById('sidebar');
sidebarEl.style.width = state.sidebarWidth + 'px';

setupResizer('resizerSide', sidebarEl, 'x', 160, 500, () => {
  state.sidebarWidth = sidebarEl.getBoundingClientRect().width;
  saveSession();
});

setupResizer('resizerPreview', previewPane, 'x', 200, window.innerWidth - 400, () => {
  state.previewWidth = previewPane.getBoundingClientRect().width;
  saveSession();
});

/* ---------- DSEDIT modal ---------- */
const dseditModal  = document.getElementById('dseditModal');
const dseditInput  = document.getElementById('dseditInput');
const dseditStatus = document.getElementById('dseditStatus');
const dseditCount  = document.getElementById('dseditCount');
const dseditDiff   = document.getElementById('dseditDiff');
const dseditApply  = document.getElementById('dseditApply');

let dseditPending = null;

function openDsedit(prefill) {
  dseditModal.classList.add('open');
  dseditInput.value = prefill || '';
  dseditInput.focus();
  resetDsedit();
  if (prefill) analyzeDsedit();
}
function closeDsedit() {
  dseditModal.classList.remove('open');
  dseditPending = null;
}
function resetDsedit() {
  dseditStatus.textContent = 'Cole o bloco acima para analisar';
  dseditStatus.className = '';
  dseditCount.textContent = '';
  dseditDiff.innerHTML = '';
  dseditApply.disabled = true;
  dseditPending = null;
}

function analyzeDsedit() {
  const src = dseditInput.value.trim();
  if (!src) { resetDsedit(); return; }

  const { ops, errors } = parseDsEdit(src);

  if (ops.length === 0) {
    dseditStatus.textContent = 'Nenhuma operação @file encontrada';
    dseditStatus.className = 'err';
    dseditCount.textContent = '';
    dseditDiff.innerHTML = '';
    dseditApply.disabled = true;
    dseditPending = null;
    return;
  }

  const filesSnapshot = {};
  for (const [, tab] of state.tabs) filesSnapshot[tab.name] = tab.content;

  let result;
  try { result = previewOps(ops, filesSnapshot); }
  catch (e) {
    dseditStatus.textContent = '✖ ' + e.message;
    dseditStatus.className = 'err';
    dseditCount.textContent = '';
    dseditDiff.innerHTML = '';
    dseditApply.disabled = true;
    dseditPending = null;
    return;
  }

  dseditDiff.innerHTML = '';
  let totalAdd = 0, totalDel = 0;
  const filesAffected = Object.keys(result);

  for (const file of filesAffected) {
    const oldText = filesSnapshot[file] ?? '';
    const head = document.createElement('div');
    head.className = 'file';
    head.textContent = '📄 ' + file + (file in filesSnapshot ? '' : ' (novo)');
    dseditDiff.appendChild(head);

    const lines = diffLines(oldText, result[file]);
    for (const l of lines) {
      if (l.type === 'add') totalAdd++;
      else if (l.type === 'del') totalDel++;
      const row = document.createElement('div');
      row.className = 'line ' + l.type;
      const pre = document.createElement('span');
      pre.className = 'pre';
      pre.textContent = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      const txt = document.createElement('span');
      txt.textContent = l.text || ' ';
      row.append(pre, txt);
      dseditDiff.appendChild(row);
    }
  }

  const missing = filesAffected.filter(f => !(f in filesSnapshot));
  if (missing.length > 0) {
    dseditStatus.textContent = '✖ Arquivos não abertos: ' + missing.join(', ');
    dseditStatus.className = 'err';
    dseditApply.disabled = true;
    dseditPending = null;
    return;
  }

  const errMsg = errors.length ? ` (${errors.length} aviso${errors.length > 1 ? 's' : ''})` : '';
  dseditStatus.textContent = `✔ ${ops.length} op(s) em ${filesAffected.length} arquivo(s)${errMsg}`;
  dseditStatus.className = 'ok';
  dseditCount.textContent = `+${totalAdd} −${totalDel}`;
  dseditApply.disabled = false;
  dseditPending = { result, ops };
}

async function applyDsedit() {
  if (!dseditPending) return;
  const { result } = dseditPending;

  for (const [name, newText] of Object.entries(result)) {
    let tab = null;
    for (const [, t] of state.tabs) if (t.name === name) { tab = t; break; }
    if (!tab) continue;
    tab.content = newText;
    tab.dirty = true;
    try {
      await invoke('write_file', { path: tab.path, content: newText });
      tab.dirty = false;
    } catch (e) { toast('Erro salvando ' + name + ': ' + e, 'err'); }
  }

  if (state.activePath) activateTab(state.activePath);
  renderTabs();
  if (state.previewOpen) updatePreview();
  toast('DSEDIT aplicado com sucesso', 'ok');
  closeDsedit();
}

document.getElementById('btnDsedit').addEventListener('click', () => openDsedit());
document.getElementById('dseditClose').addEventListener('click', closeDsedit);
document.getElementById('dseditCancel').addEventListener('click', closeDsedit);
dseditApply.addEventListener('click', applyDsedit);
dseditInput.addEventListener('input', analyzeDsedit);
dseditModal.addEventListener('mousedown', (e) => { if (e.target === dseditModal) closeDsedit(); });

/* ============================================================
   SCOPE VALIDATION (só aceita editar o arquivo enviado)
   ============================================================ */
function validateScope(payload, expectedFileName) {
  const allowed = new Set([expectedFileName]);
  return validateScopeMulti(payload, allowed);
}

function validateScopeMulti(payload, allowedSet) {
  const { ops } = parseDsEdit(payload);
  const filesTouched = new Set(ops.map(o => o.file).filter(Boolean));
  if (filesTouched.size === 0) return { ok: false, reason: 'bloco sem @file' };
  const extra = [...filesTouched].filter(f => !allowedSet.has(f));
  if (extra.length > 0) {
    return { ok: false, reason: `Fora do escopo: ${extra.join(', ')}. Autorizados: ${[...allowedSet].join(', ')}`, extra };
  }
  return { ok: true };
}

/* ---------- Auto-apply ---------- */
async function autoApplyBlock(payload) {
  // Validação de escopo (antes de aplicar)
  const expected = autoLoop.expectedFile
    || (state.activePath ? state.activePath.split(/[\\/]/).pop() : null);

  if (expected && !state.allowMultiFile) {
    const allowed = new Set([expected]);
    if (autoLoop.allowedFiles) for (const f of autoLoop.allowedFiles) allowed.add(f);
    const v = validateScopeMulti(payload, allowed);
    if (!v.ok) {
      toast('⚠️ ' + v.reason, 'err');
      console.warn('[scope] recusado:', v);
      errorState.pendingFix = false;
      return;
    }
  }

  const { ops, errors } = parseDsEdit(payload);
  if (ops.length === 0) { errorState.pendingFix = false; return; }

  const filesSnapshot = {};
  for (const [, tab] of state.tabs) filesSnapshot[tab.name] = tab.content;

  let result;
  try { result = previewOps(ops, filesSnapshot); }
  catch (e) {
    errorState.pendingFix = false;
    toast('✖ DSEDIT: ' + e.message, 'err');
    return;
  }

  const missing = Object.keys(result).filter(f => !(f in filesSnapshot));
  if (missing.length > 0) {
    errorState.pendingFix = false;
    toast('✖ Arquivos não abertos: ' + missing.join(', '), 'err');
    return;
  }

  const undoEntry = {
    timestamp: Date.now(),
    files: Object.entries(result).map(([name, newText]) => {
      let tab = null;
      for (const [, t] of state.tabs) if (t.name === name) { tab = t; break; }
      return { name, path: tab.path, oldText: tab.content, newText };
    }),
  };
  state.undoStack.push(undoEntry);
  if (state.undoStack.length > 20) state.undoStack.shift();

  let ok = 0, fail = 0;
  for (const [name, newText] of Object.entries(result)) {
    let tab = null;
    for (const [, t] of state.tabs) if (t.name === name) { tab = t; break; }
    if (!tab) continue;
    tab.content = newText;
    try {
      await invoke('write_file', { path: tab.path, content: newText });
      tab.dirty = false;
      ok++;
    } catch (e) { fail++; console.error('auto-apply save fail:', e); }
  }

  if (state.activePath) activateTab(state.activePath);
  renderTabs();
  if (state.previewOpen) updatePreview();
  toast(`⚡ Auto-aplicado: ${ok} arquivo(s)${fail ? ' (' + fail + ' erro)' : ''}`, 'ok');
  showUndoButton();

  if (errorState.pendingFix) {
    errorState.pendingFix = false;
    errorState.errors = [];
    updateErrorBadge();
  }
}

function showUndoButton() {
  const old = document.getElementById('undoToast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'undoToast';
  el.style.cssText = `position:fixed;bottom:90px;left:20px;display:flex;align-items:center;gap:12px;padding:10px 16px;background:#16181d;border:1px solid #4d7cfe;border-radius:10px;font-size:12px;color:#e6e8eb;box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:200;`;
  el.innerHTML = `
    <span>⚡ Alterações aplicadas</span>
    <button id="btnUndoApply" style="height:26px;padding:0 12px;border:0;border-radius:6px;background:#4d7cfe;color:#fff;font-weight:700;font-size:11px;cursor:pointer;">Desfazer</button>
    <button id="btnUndoClose" style="height:26px;width:26px;border:1px solid #2f3544;border-radius:6px;background:transparent;color:#9aa1ad;font-size:14px;cursor:pointer;">×</button>`;
  document.body.appendChild(el);
  document.getElementById('btnUndoApply').addEventListener('click', undoLastApply);
  document.getElementById('btnUndoClose').addEventListener('click', () => el.remove());
  setTimeout(() => { if (el.parentNode) el.remove(); }, 15000);
}

async function undoLastApply() {
  const entry = state.undoStack.pop();
  if (!entry) { toast('Nada para desfazer', 'err'); return; }
  for (const { name, path, oldText } of entry.files) {
    let tab = null;
    for (const [, t] of state.tabs) if (t.name === name) { tab = t; break; }
    if (!tab) continue;
    tab.content = oldText;
    try {
      await invoke('write_file', { path, content: oldText });
      tab.dirty = false;
    } catch (e) { console.error('undo save fail:', e); }
  }
  if (state.activePath) activateTab(state.activePath);
  renderTabs();
  if (state.previewOpen) updatePreview();
  const el = document.getElementById('undoToast');
  if (el) el.remove();
  toast('↶ Desfeito', 'ok');
}

const btnAutoApply = document.getElementById('btnAutoApply');

function updateAutoApplyBtn() {
  if (state.autoApply) {
    btnAutoApply.textContent = 'Auto: ON';
    btnAutoApply.style.background = 'linear-gradient(135deg,#31c48d,#22a06b)';
    btnAutoApply.style.borderColor = '#22a06b';
    btnAutoApply.style.color = '#04140d';
    btnAutoApply.style.fontWeight = '800';
  } else {
    btnAutoApply.textContent = 'Auto: OFF';
    btnAutoApply.style.background = '';
    btnAutoApply.style.borderColor = '';
    btnAutoApply.style.color = '';
    btnAutoApply.style.fontWeight = '';
  }
}

btnAutoApply.addEventListener('click', () => {
  state.autoApply = !state.autoApply;
  updateAutoApplyBtn();
  saveSession();
  toast('Auto-apply: ' + (state.autoApply ? 'LIGADO' : 'desligado'), 'ok');
});

/* ============================================================
   PROMPT DSEDIT v2
   ============================================================ */
const DSEDIT_PROMPT = `# DSEDIT v2 — PROTOCOLO SEARCH/REPLACE

## ESCOPO — REGRA MAIS IMPORTANTE

Você edita o(s) arquivo(s) alvo que eu te mandei.
- NÃO crie arquivos novos a menos que eu peça explicitamente.
- NÃO sugira refatorações fora do escopo do pedido.

Se você PRECISAR VER outro arquivo do projeto antes de editar, responda
SOMENTE com linhas \`##READ @nome-do-arquivo\` (uma por linha, sem mais
nada). O sistema te envia o conteúdo e você continua a edição.

Se precisar editar TAMBÉM outro arquivo (não só o alvo original), peça
primeiro com \`##READ @outro-arquivo\` e depois mande os blocos
\`@file outro-arquivo\` normalmente — o sistema aceita múltiplos arquivos
quando o \`##READ\` foi feito antes.

---

## FORMATO OBRIGATÓRIO

\`\`\`dsedit
##DSEDIT v2
@file <nome-do-arquivo-que-eu-te-mandei>
<<<<<<< SEARCH
<texto exato existente>
=======
<texto novo>
>>>>>>> REPLACE
\`\`\`

---

## REGRAS

1. O bloco SEARCH deve conter o texto EXATO copiado do arquivo — sem inventar.
2. Copie TODAS as linhas do trecho original, incluindo indentação.
3. Não use linhas com números (tipo "12| foo"). Copie o texto puro.
4. Para mudar várias partes do MESMO arquivo, use vários blocos SEARCH/REPLACE.
5. Cada bloco é aplicado sobre o resultado do anterior.
6. Se o trecho aparece em vários lugares, inclua mais contexto pra desambiguar.
7. Para adicionar no final do arquivo, use SEARCH vazio.
8. Para deletar, use REPLACE vazio.
9. Se faltar VER outro arquivo, peça com \`##READ @nome\` e pare — não
   invente. Depois de receber, mande os SEARCH/REPLACE.
10. NUNCA use @rep, @ins, @del, @set, @find, @with.
11. Quando a edição for possível e estiver clara, envie SOMENTE o bloco
    SEARCH/REPLACE — sem texto extra. O chat fica reservado para dúvidas,
    ambiguidades, listagem de arquivos a abrir, ou pedidos fora de escopo.

---

## EXEMPLO

Arquivo:
\`\`\`
const a = 1;
const b = 2;
const c = 3;
\`\`\`

Pedido: troque b por 20 e adicione d = 4 depois de c

Resposta:
\`\`\`dsedit
##DSEDIT v2
@file x.js
<<<<<<< SEARCH
const b = 2;
=======
const b = 20;
>>>>>>> REPLACE

@file x.js
<<<<<<< SEARCH
const c = 3;
=======
const c = 3;
const d = 4;
>>>>>>> REPLACE
\`\`\`

---

## REGRA FINAL

Você edita O ARQUIVO ENVIADO usando SEARCH/REPLACE. Mantenha o formato acima
como prioridade absoluta — sem inventar sintaxe nova, sem reescrever o arquivo
inteiro, sem misturar explicações junto do bloco.

Fluxo de edição:
1. Se você já tem tudo pra editar o alvo → mande os blocos SEARCH/REPLACE.
2. Se precisa VER outro arquivo → mande só \`##READ @nome\` (uma ou mais
   linhas) e pare. O sistema te devolve o conteúdo e você continua.
3. Se precisa editar também outro arquivo → peça antes com \`##READ\`,
   depois mande blocos \`@file\` pra cada um.
4. Se o pedido for genuinamente ambíguo → use o chat pra perguntar e
   encerre com a linha:

SEM MUDANÇAS

Não use o chat para justificar edições que já estão no bloco SEARCH/REPLACE —
nesse caso, responda apenas o bloco, sem conversa.
`;

/* ============================================================
   CONTEXTO DO PROJETO
   ============================================================ */
const contextState = {
  clean: true,
  sent: false,
  filesCount: 0,
  bytesTotal: 0,
  lastSentAt: 0,
};

function updateContextBadge() {
  if (!contextBadge) return;
  const show = contextState.sent;
  contextBadge.classList.toggle('show', show);
  if (show) {
    contextBadge.title = `Contexto: ${contextState.filesCount} arquivos, ${contextState.symbolsTotal || 0} símbolos`;
    if (btnSendContext) {
      btnSendContext.classList.remove('sending');
      btnSendContext.classList.add('sent');
      btnSendContext.textContent = '📦 Mapa ✓';
    }
  } else {
    if (btnSendContext) {
      btnSendContext.classList.remove('sending');
      btnSendContext.classList.remove('sent');
      btnSendContext.textContent = '📦 Mapa';
    }
  }
}

async function buildProjectContext() {
  if (!state.rootDir) return null;

  // Pega o mapa do projeto (só assinaturas)
  let map;
  try {
    map = await invoke('build_repo_map', { root: state.rootDir });
  } catch (e) {
    toast('Erro lendo projeto: ' + e, 'err');
    return null;
  }

  if (!map || map.length === 0) return null;

  const parts = [];
  let totalSymbols = 0;

  parts.push('# ESTRUTURA DO PROJETO');
  parts.push('');
  parts.push('Este é o mapa de todos os arquivos. Você NÃO tem o conteúdo');
  parts.push('completo ainda — quando precisar editar um arquivo, ele será');
  parts.push('enviado em separado.');
  parts.push('');
  parts.push(`- Raiz: \`${state.rootDir}\``);
  parts.push(`- Total de arquivos: ${map.length}`);
  parts.push('');

  for (const f of map) {
    parts.push(`### \`${f.file}\` (${f.lang}, ${f.lines} linhas)`);
    if (f.symbols.length === 0) {
      parts.push('_(sem símbolos detectados)_');
    } else {
      for (const s of f.symbols) {
        parts.push(`- L${s.line} \`${s.kind}\` ${s.name}`);
        totalSymbols++;
      }
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('');
  parts.push(`_Fim do mapa: ${map.length} arquivos, ${totalSymbols} símbolos._`);
  parts.push('');
  parts.push('Próximas mensagens: eu envio o **arquivo ativo** completo pra você editar.');

  contextState.filesCount = map.length;
  contextState.bytesTotal = 0;
  contextState.symbolsTotal = totalSymbols;

  return parts.join('\n');
}

listen('chat-status', (e) => {
  const clean = !!e.payload;
  const wasClean = contextState.clean;
  contextState.clean = clean;
  if (clean && !wasClean) {
    contextState.sent = false;
    updateContextBadge();
    console.log('[context] novo chat, contexto resetado');
  }
  if (!clean && !contextState.sent) {
    contextState.sent = true;
    updateContextBadge();
  }
});

if (btnSendContext) btnSendContext.addEventListener('click', () => sendProjectContext(false));

/* ---------- Ask bar ---------- */
function buildAskPayload(userText) {
  const parts = [];

  if (askAttachPrompt.checked) {
    parts.push(DSEDIT_PROMPT);
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  if (askAttachFile.checked && state.activePath) {
    const tab = state.tabs.get(state.activePath);
    if (tab) {
      const lines = tab.content.split('\n');
      const w = String(lines.length).length;
      const numbered = lines.map((l, i) => String(i + 1).padStart(w, ' ') + '| ' + l).join('\n');
      parts.push('## ARQUIVO ALVO (o ÚNICO que você pode editar)');
      parts.push('');
      parts.push('`' + tab.name + '`');
      parts.push('');
      parts.push('```');
      parts.push(numbered);
      parts.push('```');
      parts.push('');
    }
  }

  parts.push('## PEDIDO');
  parts.push(userText);
  return parts.join('\n');
}

/* ============================================================
   AUTO-LOOP
   ============================================================ */
const autoLoop = {
  running: false,
  lastHash: '',
  lastContent: '',
  incompleteStreak: 0,
  continueCount: 0,
  timer: null,
  pollInterval: 2500,
  continueCooldown: 15000,
  maxContinues: 8,
  idleTicks: 0,
  maxIdle: 20,
  cooldownUntil: 0,
  hashAtLastContinue: '',
  expectedFile: null,
  allowedFiles: null,
};

async function tryPullOnce() {
  try {
    await invoke('fetch_latest_block');
    await new Promise(r => setTimeout(r, 500));
    const text = await invoke('read_clipboard');
    if (!text || !text.includes('##DSEDIT')) return null;
    return text.trim();
  } catch (e) { return null; }
}

async function autoLoopTick() {
  if (!autoLoop.running) return;
  const text = await tryPullOnce();
  const now = Date.now();

  if (!text) {
    autoLoop.idleTicks++;
    if (autoLoop.idleTicks > autoLoop.maxIdle) {
      toast('⏱️ Auto-loop: sem resposta, desligando', 'err');
      stopAutoLoop();
      return;
    }
    autoLoop.timer = setTimeout(autoLoopTick, autoLoop.pollInterval);
    return;
  }

  const hash = hashStr(text);

  if (hash !== autoLoop.lastHash) {
    autoLoop.lastHash = hash;
    autoLoop.lastContent = text;
    autoLoop.incompleteStreak = 0;
    autoLoop.idleTicks = 0;

    if (isBlockIncomplete(text)) {
      autoLoop.timer = setTimeout(autoLoopTick, 3500);
      return;
    }
    applyAutoBlock(text);
    stopAutoLoop();
    return;
  }

  autoLoop.idleTicks = 0;

  if (!isBlockIncomplete(text)) {
    applyAutoBlock(text);
    stopAutoLoop();
    return;
  }

  if (hash === autoLoop.hashAtLastContinue) {
    autoLoop.timer = setTimeout(autoLoopTick, autoLoop.pollInterval);
    return;
  }
  if (now < autoLoop.cooldownUntil) {
    autoLoop.timer = setTimeout(autoLoopTick, autoLoop.pollInterval);
    return;
  }
  if (autoLoop.continueCount >= autoLoop.maxContinues) {
    toast('⚠️ Limite de continues atingido', 'err');
    stopAutoLoop();
    return;
  }

  autoLoop.incompleteStreak++;
  if (autoLoop.incompleteStreak < 2) {
    autoLoop.timer = setTimeout(autoLoopTick, autoLoop.pollInterval);
    return;
  }

  autoLoop.continueCount++;
  autoLoop.incompleteStreak = 0;
  autoLoop.hashAtLastContinue = hash;
  autoLoop.cooldownUntil = now + autoLoop.continueCooldown;

  toast(`↻ Pedindo continuação ${autoLoop.continueCount}/${autoLoop.maxContinues}...`, 'ok');
  try {
    await invoke('open_deepseek');
    await invoke('send_to_deepseek', { payload: 'continuar' });
  } catch (e) {}

  autoLoop.timer = setTimeout(autoLoopTick, autoLoop.continueCooldown);
}

function startAutoLoop() {
  if (autoLoop.running) return;
  autoLoop.running = true;
  autoLoop.lastHash = '';
  autoLoop.lastContent = '';
  autoLoop.incompleteStreak = 0;
  autoLoop.continueCount = 0;
  autoLoop.idleTicks = 0;
  autoLoop.cooldownUntil = 0;
  autoLoop.hashAtLastContinue = '';
  clearTimeout(autoLoop.timer);
  autoLoop.timer = setTimeout(autoLoopTick, 1500);
}

function stopAutoLoop() {
  autoLoop.running = false;
  clearTimeout(autoLoop.timer);
  autoLoop.timer = null;
  if (btnAskContinue) btnAskContinue.classList.remove('pending');
}

function parseReadDirectives(text) {
  if (!text) return [];
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*##READ\s+@?([^\s#]+)\s*$/i);
    if (m) out.push(m[1]);
  }
  return out;
}

async function fulfillReadDirectives(files) {
  if (!files || files.length === 0) return;
  toast('📖 IA pediu ' + files.length + ' arquivo(s): ' + files.join(', '), 'ok');

  if (!autoLoop.allowedFiles) autoLoop.allowedFiles = new Set();
  for (const f of files) autoLoop.allowedFiles.add(f);

  const parts = [];
  parts.push('# ARQUIVOS SOLICITADOS');
  parts.push('');
  parts.push('Aqui estão os arquivos que você pediu via ##READ. Continue a edição.');
  parts.push('');

  for (const fname of files) {
    let tab = null;
    for (const [, t] of state.tabs) if (t.name === fname) { tab = t; break; }

    if (!tab && state.rootDir) {
      try {
        const p = state.rootDir.replace(/[\\/]$/, '') + '/' + fname;
        const content = await invoke('read_file', { path: p });
        state.tabs.set(p, { path: p, name: fname, content, dirty: false });
        renderTabs();
        tab = state.tabs.get(p);
      } catch (e) {}
    }

    parts.push('### `' + fname + '`');
    if (!tab) {
      parts.push('_(arquivo não encontrado)_');
    } else {
      const lines = tab.content.split('\n');
      const w = String(lines.length).length;
      const numbered = lines.map((l, i) => String(i + 1).padStart(w, ' ') + '| ' + l).join('\n');
      parts.push('```');
      parts.push(numbered);
      parts.push('```');
    }
    parts.push('');
  }

  try {
    await invoke('send_to_deepseek', { payload: parts.join('\n') });
    try { await invoke('write_clipboard', { text: '' }); } catch (e) {}
    setTimeout(startAutoLoop, 1500);
  } catch (e) {
    toast('Erro enviando arquivos: ' + e, 'err');
  }
}

function applyAutoBlock(text) {
  const reads = parseReadDirectives(text);
  if (reads.length > 0) {
    fulfillReadDirectives(reads);
    return;
  }
  if (state.autoApply) autoApplyBlock(text);
  else { errorState.pendingFix = false; openDsedit(text); }
}

/* ---------- sendAsk ---------- */
async function sendAsk() {
  const text = askInput.value.trim();
  if (!text) { askInput.focus(); return; }

  try { await invoke('open_deepseek'); }
  catch (e) { toast('Erro abrindo DeepSeek: ' + e, 'err'); return; }

  // Envio automático de contexto na primeira mensagem
  const shouldSendContext = contextState.clean && !contextState.sent && state.rootDir;
  if (shouldSendContext) {
    toast('📦 Primeira mensagem: enviando contexto do projeto...', 'ok');
    const ctx = await buildProjectContext();
    if (ctx) {
      try {
        await invoke('send_to_deepseek', { payload: ctx });
        contextState.sent = true;
        contextState.lastSentAt = Date.now();
        updateContextBadge();
        toast(`📦 Contexto enviado: ${contextState.filesCount} arquivos`, 'ok');
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) { toast('Erro enviando contexto: ' + e, 'err'); }
    }
  }

  const payload = buildAskPayload(text);
  autoLoop.expectedFile = state.activePath ? state.activePath.split(/[\\/]/).pop() : null;
  autoLoop.allowedFiles = new Set();

  try {
    await invoke('send_to_deepseek', { payload });
    toast('🚀 Enviado — monitorando resposta...', 'ok');
    askInput.value = '';
    try { await invoke('write_clipboard', { text: '' }); } catch (e) {}
    setTimeout(startAutoLoop, 1500);
  } catch (e) { toast('Erro enviando: ' + e, 'err'); }
}

btnAskSend.addEventListener('click', sendAsk);

askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(); }
  if (e.key === 'Escape') { askInput.blur(); editor.focus(); }
});

/* ---------- Detecção de bloco incompleto (v2) ---------- */
function isBlockIncomplete(text) {
  if (!text) return false;
  if (text.indexOf('##DSEDIT') === -1) return false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let opens = 0, ends = 0;
  for (const l of lines) {
    const t = l.trim();
    if (t === '<<<<<<< SEARCH') opens++;
    if (t === '>>>>>>> REPLACE') ends++;
  }
  return opens > ends;
}

/* ---------- Botões manuais ---------- */
if (btnAskContinue) {
  btnAskContinue.addEventListener('click', async () => {
    stopAutoLoop();
    try {
      await invoke('open_deepseek');
      await invoke('send_to_deepseek', { payload: 'continuar' });
      startAutoLoop();
      toast('↻ "continuar" enviado, monitorando...', 'ok');
    } catch (e) { toast('Erro: ' + e, 'err'); }
  });
}

async function fetchLatestBlock() {
  toast('⬇ Puxando último bloco do chat...', 'ok');
  try {
    await invoke('open_deepseek');
    await new Promise(r => setTimeout(r, 600));
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      await invoke('fetch_latest_block');
      await new Promise(r => setTimeout(r, 900));
      let text = '';
      try { text = await invoke('read_clipboard'); } catch (e) {}
      if (text && text.includes('##DSEDIT')) {
        toast(`✓ Bloco capturado (tentativa ${tentativa})`, 'ok');
        applyAutoBlock(text);
        return;
      }
    }
    toast('Nenhum bloco detectado — abrindo modal', 'err');
    openDsedit('');
  } catch (e) { toast('Erro: ' + e, 'err'); openDsedit(''); }
}

if (btnFetch) btnFetch.addEventListener('click', fetchLatestBlock);

/* ---------- Diagnóstico ---------- */
if (btnDiag) {
  btnDiag.addEventListener('click', async () => {
    toast('🔧 Abrindo chat...', 'ok');
    try {
      await invoke('open_deepseek');
      await new Promise(r => setTimeout(r, 600));
      await invoke('send_to_deepseek', { payload: 'ping' });
      toast('🔧 Enviado. Abra DevTools do chat', 'ok');
    } catch (e) { toast('Erro: ' + e, 'err'); }
  });
}

/* ---------- Listener IPC ---------- */
listen('dsedit-block', (event) => {
  const payload = event.payload || '';
  if (!payload.trim()) return;
  if (autoLoop.running) return;
  if (!isBlockIncomplete(payload)) applyAutoBlock(payload);
});

/* ============================================================
   SELF-HOSTING
   ============================================================ */
function updateSelfBadge() {
  if (!selfBadge) return;
  const same = selfState.active;
  selfBadge.classList.toggle('show', same);
  if (same) {
    selfBadge.title = 'Editando o próprio DSedit — hot reload ativo';
    btnSelf && btnSelf.classList.add('self-active');
  } else {
    btnSelf && btnSelf.classList.remove('self-active');
  }
}

async function refreshSelfState() {
  const detected = await detectSelfProject();
  selfState.rootDir = detected;
  if (detected && state.rootDir) {
    const a = state.rootDir.replace(/\\/g,'/').toLowerCase();
    const b = detected.replace(/\\/g,'/').toLowerCase();
    selfState.active = (a === b);
  } else {
    selfState.active = false;
  }
  updateSelfBadge();
  console.log('[self] ativo=', selfState.active, 'root=', selfState.rootDir);
}

async function openSelfProject() {
  const root = await detectSelfProject();
  if (!root) { toast('Projeto DSedit não encontrado', 'err'); return; }
  state.rootDir = root;
  state.terminalCwd = root;
  await renderTree();
  await refreshSelfState();
  saveSession();
  toast('🛠️ Projeto DSedit aberto — edite e salve, o app recarrega', 'ok');
}

if (btnSelf) btnSelf.addEventListener('click', openSelfProject);
if (btnReloadSelf) {
  btnReloadSelf.addEventListener('click', () => {
    toast('🔄 Recarregando...', 'ok');
    setTimeout(() => location.reload(), 200);
  });
}

/* ============================================================
   TERMINAL
   ============================================================ */
async function togglePanel(force) {
  if (!panelWrap) return;
  const open = typeof force === 'boolean' ? force : !state.terminalOpen;
  state.terminalOpen = open;
  panelWrap.classList.toggle('open', open);

  if (open) {
    if (state.panelTab === 'terminal') {
      if (!hasTerminal()) {
        await createTerminal(terminalHost, state.terminalCwd || state.rootDir || null);
      } else {
        setTimeout(fitTerminal, 60);
      }
      setTimeout(focusTerminal, 100);
    }
    saveSession();
  } else {
    saveSession();
  }
}

document.querySelectorAll('.panel-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.panel;
    state.panelTab = tab;
    document.querySelectorAll('.panel-tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel-content').forEach(c => c.classList.toggle('active', c.dataset.panel === tab));
    if (tab === 'terminal') setTimeout(() => { fitTerminal(); focusTerminal(); }, 60);
  });
});

const btnTogglePanelEl = document.getElementById('btnTogglePanel');
if (btnTogglePanelEl) btnTogglePanelEl.addEventListener('click', () => togglePanel(false));

const btnToggleTermEl = document.getElementById('btnToggleTerm');
if (btnToggleTermEl) btnToggleTermEl.addEventListener('click', () => togglePanel());

const btnNewTerminalEl = document.getElementById('btnNewTerminal');
if (btnNewTerminalEl) {
  btnNewTerminalEl.addEventListener('click', async () => {
    await destroyTerminal();
    await createTerminal(terminalHost, state.terminalCwd || state.rootDir || null);
  });
}

const btnKillTerminalEl = document.getElementById('btnKillTerminal');
if (btnKillTerminalEl) {
  btnKillTerminalEl.addEventListener('click', async () => {
    await destroyTerminal();
    if (terminalHost) terminalHost.innerHTML = '<div style="padding:20px;color:var(--fg2);font-size:12px">Terminal encerrado. Use ⌨ Terminal ou o + para abrir um novo.</div>';
  });
}

document.querySelectorAll('.activity-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.activity-btn[data-view]').forEach(b => b.classList.toggle('active', b === btn));
    if (view === 'terminal') { togglePanel(true); return; }
    const title = document.getElementById('sideTitle');
    if (title) title.textContent = view === 'explorer' ? 'Explorer' : 'Search';
  });
});

/* ---------- Atalhos globais ---------- */
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // Zoom — Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomOut(); return; }
  if (mod && e.key === '0') { e.preventDefault(); zoomReset(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFolder(); }
  if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (state.activePath) closeTab(state.activePath);
  }
  if (mod && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    state.previewOpen ? closePreview() : openPreview();
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    openDsedit();
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleVoice();
  }
  if (mod && e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoLastApply();
  }
  if (mod && !e.shiftKey && !e.altKey && e.key === 'Enter') {
    e.preventDefault();
    askInput.focus();
    try { askInput.select(); } catch (err) {}
  }
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); togglePanel(); }
  if (e.key === 'F5') { e.preventDefault(); popoutPreview(); }
  if (e.key === 'F9') { e.preventDefault(); openSelfProject(); }
  if (e.key === 'F11' && state.previewOpen) {
    e.preventDefault();
    btnFullPreview && btnFullPreview.click();
  }
  if (e.key === 'Escape' && autoLoop.running) {
    stopAutoLoop();
    toast('⏹️ Auto-loop interrompido', 'ok');
  }
});

/* ---------- Botões ---------- */
document.getElementById('btnOpenFolder').addEventListener('click', openFolder);
document.getElementById('btnCommandPalette').addEventListener('click', openPalette);
document.getElementById('btnOpenDeepseek').addEventListener('click', () => invoke('open_deepseek'));

const btnOpenChatGPT = document.getElementById('btnOpenChatGPT');
if (btnOpenChatGPT) {
  btnOpenChatGPT.addEventListener('click', () => invoke('open_chatgpt'));
}

document.getElementById('btnImportAuth')?.addEventListener('click', async () => {
  const cookie = prompt(
    'Cole o valor do cookie ds_session_id (só "nome=valor"):'
  );
  if (!cookie?.trim()) return;

  const token = prompt(
    'Cole o campo "value" do userToken (o JWT/token longo):'
  );
  if (!token?.trim()) return;

  try {
    toast('Importando auth…', 'ok');
    await invoke('import_deepseek_auth', {
      cookie: cookie.trim(),
      token: token.trim(),
    });
    toast('✅ Auth importada — DeepSeek logado', 'ok');
  } catch (e) {
    toast('Erro: ' + e, 'err');
  }
});

/* ============================================================
   CHATGPT → DEEPSEEK (auto-push)
   ============================================================ */
const chatgptState = {
  autoPush: true,
  lastHash: '',
  lastText: '',
  cooldownUntil: 0,
};

function setChatGPTAutoPush(on) {
  chatgptState.autoPush = !!on;
  toast('💬 Auto-push ChatGPT: ' + (on ? 'LIGADO' : 'desligado'), 'ok');
  console.log('[chatgpt] auto-push =', on);
}

async function pushChatGPTToDeepSeek(text) {
  const clean = String(text || '').trim();
  if (clean.length < 20) return;
  const hash = hashStr(clean);
  if (hash === chatgptState.lastHash) return;
  if (Date.now() < chatgptState.cooldownUntil) return;
  chatgptState.lastHash = hash;
  chatgptState.lastText = clean;
  chatgptState.cooldownUntil = Date.now() + 3000;

  toast('💬 ChatGPT → DeepSeek (' + clean.length + ' chars)', 'ok');
  console.log('[chatgpt] enviando resposta para o DeepSeek:', clean.slice(0, 120) + '...');

  try {
    await invoke('open_deepseek');
    await new Promise(r => setTimeout(r, 400));
    // Envia o texto do ChatGPT como novo prompt pro DeepSeek
    await invoke('send_to_deepseek', { payload: clean });
    try { await invoke('write_clipboard', { text: '' }); } catch (e) {}
    // Inicia monitoramento da resposta do DeepSeek
    autoLoop.expectedFile = state.activePath ? state.activePath.split(/[\\/]/).pop() : null;
    autoLoop.allowedFiles = new Set();
    setTimeout(startAutoLoop, 1500);
  } catch (e) {
    toast('Erro enviando pro DeepSeek: ' + e, 'err');
    console.error('[chatgpt] push falhou:', e);
  }
}

listen('chatgpt-response', (event) => {
  const text = event.payload || '';
  if (!chatgptState.autoPush) return;
  pushChatGPTToDeepSeek(text);
});

/* ---------- Eventos do Rust ---------- */
listen('app-ready', () => toast('DSedit pronto', 'ok'));

/* ---------- Salvar sessão antes de fechar ---------- */
window.addEventListener('beforeunload', (e) => {
  saveSessionNow();
  if ([...state.tabs.values()].some(t => t.dirty)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ============================================================
   COMANDOS DE VOZ (Web Speech API · espelha Requisitos RF-V##)
   ============================================================ */
const voiceState = {
  supported: false,
  listening: false,
  recognition: null,
  lastAt: 0,
  cooldownMs: 900,
  lang: 'pt-BR',
  dictationMode: false,
  networkFails: 0,
  networkCooldownUntil: 0,
  networkBackoffMs: 3000,
  maxNetworkFails: 3,
};

const VOICE_COMMANDS = [
  { id:'ajuda',           prio:'must',   phrases:['ajuda','help','comandos de voz','o que posso falar','quais comandos'], run: voiceHelp },
  { id:'ligar-voz',       prio:'must',   phrases:['ligar voz','ativar voz','abrir microfone','ouvir'],                    run: () => { if (!voiceState.listening) toggleVoice(); } },
  { id:'desligar-voz',    prio:'must',   phrases:['desligar voz','desativar voz','fechar microfone','parar de ouvir'],    run: () => { if (voiceState.listening) toggleVoice(); } },

  { id:'abrir-pasta',     prio:'must',   phrases:['abrir pasta','abrir projeto','abrir diretorio','abrir diretório'],     run: openFolder },
  { id:'salvar',          prio:'must',   phrases:['salvar','salvar arquivo','salva','gravar'],                            run: saveActive },
  { id:'fechar-aba',      prio:'should', phrases:['fechar aba','fechar arquivo','fecha aba'],                            run: () => state.activePath && closeTab(state.activePath) },
  { id:'novo-arquivo',    prio:'could',  phrases:['novo arquivo','criar arquivo'],                                      run: newFileDialog },

  { id:'preview',         prio:'must',   phrases:['preview','previa','prévia','visualizar'],                             run: () => state.previewOpen ? closePreview() : openPreview() },
  { id:'executar',        prio:'must',   phrases:['executar','rodar','rodar preview','executar preview','run'],         run: popoutPreview },
  { id:'tela-cheia',      prio:'could',  phrases:['tela cheia','tela inteira','fullscreen'],                             run: () => btnFullPreview && btnFullPreview.click() },
  { id:'recarregar-prev', prio:'should', phrases:['recarregar preview','atualizar preview','recarregar visualizacao'], run: updatePreview },

  { id:'terminal',        prio:'must',   phrases:['terminal','abrir terminal','fechar terminal'],                       run: () => togglePanel() },
  { id:'novo-terminal',   prio:'should', phrases:['novo terminal','novo shell'],                                        run: () => btnNewTerminalEl && btnNewTerminalEl.click() },

  { id:'paleta',          prio:'must',   phrases:['paleta','comandos','command palette','abrir paleta'],                run: openPalette },
  { id:'fechar',          prio:'should', phrases:['cancelar','fechar','esc','escape'],                                  run: () => { closePalette(); closeDsedit(); } },

  { id:'deepseek',        prio:'must',   phrases:['abrir deepseek','deepseek','abrir chat'],                            run: () => invoke('open_deepseek') },
  { id:'perguntar',       prio:'must',   phrases:['perguntar','enviar pergunta','manda','mandar'],                      run: sendAsk },
  { id:'puxar',           prio:'must',   phrases:['puxar bloco','puxar resposta','pegar resposta','fetch'],              run: fetchLatestBlock },
  { id:'continuar',       prio:'must',   phrases:['continuar','continua'],                                              run: () => btnAskContinue && btnAskContinue.click() },
  { id:'corrigir',        prio:'should', phrases:['corrigir erros','corrige','fix erros','corrigir'],                   run: () => sendErrorsToDeepSeek(false) },
  { id:'contexto',        prio:'should', phrases:['enviar contexto','contexto','mapa do projeto','enviar mapa'],         run: () => sendProjectContext(false) },

  { id:'prompt-focar',    prio:'must',   phrases:['prompt','focar prompt','abrir prompt','barra de prompt','ir para prompt'], run: () => { askInput.focus(); askInput.select(); } },
  { id:'prompt-enviar',   prio:'must',   phrases:['enviar prompt','mandar prompt','enviar agora','envia prompt'],              run: sendAsk },
  { id:'prompt-limpar',   prio:'should', phrases:['limpar prompt','apagar prompt','limpa prompt'],                             run: () => { askInput.value = ''; askInput.focus(); } },
  { id:'testar-mic',      prio:'must',   phrases:['testar microfone','testar mic','teste do microfone','checar microfone'], run: testMic },
  { id:'diagnosticar-voz',prio:'must',   phrases:['diagnosticar voz','diagnostico de voz','diagnóstico de voz','diagnosticar microfone'], run: diagnoseVoice },
  { id:'diag-rede',       prio:'should', phrases:['diagnostico de rede','diagnóstico de rede','testar rede','checar rede'],  run: async () => { const r = await networkDiagnose(); const ok = r.filter(x => x.ok).length; toast(`🌐 Rede: ${ok}/${r.length} alvos OK (veja console)`, ok === r.length ? 'ok' : 'warn'); } },

  { id:'zoom-in',         prio:'should', phrases:['aumentar zoom','mais zoom','aumentar fonte','zoom mais'],                 run: zoomIn },
  { id:'zoom-out',        prio:'should', phrases:['diminuir zoom','menos zoom','diminuir fonte','zoom menos'],               run: zoomOut },
  { id:'zoom-reset',      prio:'should', phrases:['resetar zoom','zoom normal','zoom padrao','zoom padrão'],                run: zoomReset },
  { id:'dsedit',          prio:'must',   phrases:['colar bloco','dsedit','colar dsedit','analisar bloco'],              run: () => openDsedit() },
  { id:'auto-apply',      prio:'should', phrases:['auto apply','auto aplicar','alternar auto'],                         run: () => btnAutoApply && btnAutoApply.click() },
  { id:'auto-fix',        prio:'should', phrases:['auto fix','auto corrigir','alternar fix'],                           run: () => btnAutoFix && btnAutoFix.click() },
  { id:'auto-loop',       prio:'could',  phrases:['auto loop','alternar loop','ligar loop'],                            run: () => autoLoop.running ? stopAutoLoop() : startAutoLoop() },
  { id:'parar',           prio:'must',   phrases:['parar','para','stop'],                                               run: () => { stopAutoLoop(); toast('parado', 'ok'); } },

  { id:'self-abrir',      prio:'could',  phrases:['abrir projeto dsedit','projeto do dsedit','abrir self'],             run: openSelfProject },
  { id:'self-reload',     prio:'could',  phrases:['recarregar editor','reiniciar editor','reload self'],                run: () => location.reload() },

  { id:'ditar-on',        prio:'must',   phrases:['ditar','modo ditado','escrever por voz','ligar ditado'],             run: () => setDictation(true) },
  { id:'ditar-off',       prio:'must',   phrases:['parar ditado','desligar ditado','sair do ditado'],                   run: () => setDictation(false) },
];

function normVoice(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findVoiceCommand(text) {
  const n = normVoice(text);
  if (!n) return null;
  for (const c of VOICE_COMMANDS) for (const p of c.phrases) if (n === normVoice(p)) return c;
  for (const c of VOICE_COMMANDS) for (const p of c.phrases) if (n.includes(normVoice(p))) return c;
  return null;
}

function voiceHelp() {
  const sample = VOICE_COMMANDS.slice(0, 12).map(c => c.phrases[0]).join(' · ');
  toast('Voz — exemplos: ' + sample, 'ok');
  console.table(VOICE_COMMANDS.map(c => ({ id: c.id, prio: c.prio, diga: c.phrases[0] })));
}

function setDictation(on) {
  voiceState.dictationMode = !!on;
  toast(on ? 'Modo ditado LIGADO' : 'Modo ditado desligado', 'ok');
}

function insertInEditor(text) {
  if (!state.activePath) return;
  const tab = state.tabs.get(state.activePath);
  if (!tab) return;
  tab.content = (tab.content || '') + text;
  tab.dirty = true;
  editor.setValue(tab.content, tab.name);
  renderTabs();
}

function sendVoiceToPromptBar(text) {
  if (!askInput) return;
  askInput.focus();
  askInput.value = text;
  try { askInput.select(); } catch (e) {}
  try { askInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
}

let voiceHintTimer = null;
function showVoiceHint(text, ok, cmd) {
  const hint = document.getElementById('voiceHint');
  if (!hint) return;
  let html;
  if (voiceState.dictationMode) html = '<b>ditado</b> ' + escapeHtml(text);
  else if (cmd)                 html = '<b>' + escapeHtml(cmd.id) + '</b> · ' + escapeHtml(text);
  else                          html = '<span class="vno">?</span> ' + escapeHtml(text);
  hint.innerHTML = html;
  hint.classList.add('show');
  clearTimeout(voiceHintTimer);
  voiceHintTimer = setTimeout(() => hint.classList.remove('show'), ok ? 1400 : 2200);
}

function handleVoiceFinal(txt) {
  const now = Date.now();
  if (now - voiceState.lastAt < voiceState.cooldownMs) return;
  voiceState.lastAt = now;

  if (voiceState.dictationMode) { insertInEditor(txt + ' '); showVoiceHint(txt, true, null); return; }

  const cmd = findVoiceCommand(txt);
  if (cmd) {
    showVoiceHint(txt, true, cmd);
    try { cmd.run(); }
    catch (e) { toast('Erro em comando de voz: ' + e.message, 'err'); }
    return;
  }

  // Sem comando reconhecido → trata como PROMPT: foca e seleciona a barra.
  const clean = String(txt || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) { showVoiceHint(txt, false, null); return; }
  sendVoiceToPromptBar(clean);
  showVoiceHint(txt, true, { id: '→ prompt' });
}

function handleVoiceInterim(txt) {
  if (voiceState.dictationMode) { showVoiceHint(txt, false, null); return; }
  const cmd = findVoiceCommand(txt);
  if (cmd) showVoiceHint(txt, true, cmd);
}

function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    voiceState.supported = false;
    console.warn('[voice] SpeechRecognition indisponível (WebView2 sem suporte ou desabilitado)');
    return;
  }
  voiceState.supported = true;
  console.log('[voice] SpeechRecognition disponível');

  const rec = new SR();
  rec.lang = voiceState.lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;

  rec.onresult = (ev) => {
    // Se recebeu áudio, a rede está OK: zera o contador de falhas
    voiceState.networkFails = 0;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const txt = r[0] && r[0].transcript ? r[0].transcript : '';
      if (r.isFinal) handleVoiceFinal(txt); else handleVoiceInterim(txt);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    console.warn('[voice] erro:', e.error, e.message || '');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('🎤 Permissão negada — libere em Windows → Privacidade → Microfone', 'err');
      voiceState.listening = false;
      updateVoiceBtn();
    } else if (e.error === 'network') {
      voiceState.networkFails = (voiceState.networkFails || 0) + 1;
      const n = voiceState.networkFails;
      console.warn('[voice] network error #' + n + ' — reconhecedor do Chrome/WebView2 depende de servidores Google');
      if (n < voiceState.maxNetworkFails) {
        const wait = voiceState.networkBackoffMs * n;
        voiceState.networkCooldownUntil = Date.now() + wait;
        toast(`🎤 Erro de rede (${n}/${voiceState.maxNetworkFails}). Tentando em ${Math.round(wait/1000)}s…`, 'warn');
        // reinicia após backoff se ainda estiver escutando
        setTimeout(() => {
          if (voiceState.listening) { try { voiceState.recognition.start(); } catch (err) {} }
        }, wait);
      } else {
        voiceState.listening = false;
        updateVoiceBtn();
        toast('🎤 Erro de rede persistente. Web Speech API precisa alcançar servidores do Google. Rode "diagnóstico de rede" na paleta (Ctrl+K) para detalhes.', 'err');
        console.error('[voice] desligando após ' + n + ' falhas de rede consecutivas');
      }
    } else if (e.error === 'audio-capture') {
      toast('🎤 Nenhum microfone detectado no sistema', 'err');
      voiceState.listening = false;
      updateVoiceBtn();
    } else if (e.error === 'language-not-supported') {
      toast('🎤 Idioma pt-BR não suportado pelo reconhecedor', 'err');
    }
  };
  rec.onend = () => {
    if (voiceState.listening) {
      // não reconecta em loop durante o cooldown de rede
      if (Date.now() < (voiceState.networkCooldownUntil || 0)) return;
      try { rec.start(); } catch (e) {}
    }
  };

  voiceState.recognition = rec;
}

function updateVoiceBtn() {
  const btn = document.getElementById('voiceBtn');
  if (!btn) return;
  btn.classList.toggle('on', voiceState.listening);
  btn.textContent = voiceState.listening ? '🎤 ON' : '🎤';
}

async function requestMicPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    console.warn('[voice] mic permission denied:', e);
    return false;
  }
}

async function toggleVoice() {
  if (!voiceState.supported) {
    const ok = await testMic();
    if (ok) toast('Mic funciona mas Web Speech API ausente — fale para o DeepSeek não vai funcionar', 'warn');
    else toast('Voz não suportada neste ambiente', 'err');
    return;
  }
  voiceState.listening = !voiceState.listening;
  if (voiceState.listening) {
    const ok = await requestMicPermission();
    if (!ok) {
      toast('🎤 Permissão de microfone negada — Windows → Privacidade → Microfone', 'err');
      voiceState.listening = false;
      updateVoiceBtn();
      return;
    }
    voiceState.networkFails = 0;
    voiceState.networkCooldownUntil = 0;
    try {
      voiceState.recognition.start();
      toast('🎤 Ouvindo... diga "ajuda" ou fale um prompt', 'ok');
    } catch (e) {
      console.error('[voice] start fail:', e);
      toast('Erro microfone: ' + (e && (e.message || e.name) ? (e.message || e.name) : e), 'err');
      voiceState.listening = false;
    }
  } else {
    try { voiceState.recognition.stop(); } catch (e) {}
    toast('Voz desligada', 'ok');
  }
  updateVoiceBtn();
}

function ensureVoiceUI() {
  if (document.getElementById('voiceBtn')) return;

  const style = document.createElement('style');
  style.id = 'voiceStyles';
  style.textContent = [
    '#voiceDock{position:fixed;bottom:44px;right:20px;display:flex;flex-direction:column;gap:6px;z-index:150;align-items:flex-end}',
    '#voiceBtn{min-width:64px;height:52px;border-radius:26px;',
    'border:1px solid #2f3544;background:#16181d;color:#e6e8eb;font-size:18px;font-weight:800;',
    'letter-spacing:.5px;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;',
    'box-shadow:0 6px 18px rgba(0,0,0,.4);transition:transform .15s ease,border-color .15s ease}',
    '#voiceBtn:hover{transform:scale(1.05);border-color:#4d7cfe}',
    '#voiceBtn.on{background:linear-gradient(135deg,#e84c9b,#8e44ad);border-color:#e84c9b;color:#fff;font-size:13px}',
    '#voiceBtn.on::after{content:"";position:absolute;inset:-4px;border-radius:30px;border:2px solid #e84c9b;',
    'animation:voicePulse 1.2s infinite}',
    '#voiceBtn.unsupported{opacity:.5;cursor:not-allowed;border-color:#7a3a3a}',
    '@keyframes voicePulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.5);opacity:0}}',
    '#zoomDock{display:flex;gap:4px;background:#16181d;border:1px solid #2f3544;border-radius:10px;',
    'padding:4px 6px;box-shadow:0 6px 18px rgba(0,0,0,.4);align-items:center}',
    '#zoomDock button{width:34px;height:34px;border:0;background:transparent;color:#e6e8eb;',
    'font-size:18px;font-weight:800;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '#zoomDock button:hover{background:#2f3544;color:#fff}',
    '#zoomLabel{color:#9aa1ad;font-size:11px;font-weight:700;font-family:ui-monospace,monospace;',
    'min-width:42px;text-align:center;padding:0 2px}',
    '#voiceHint{position:fixed;bottom:120px;right:20px;max-width:340px;background:#16181d;',
    'border:1px solid #2f3544;border-radius:10px;padding:10px 14px;color:#e6e8eb;font-size:12px;',
    'z-index:150;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;font-family:ui-monospace,monospace}',
    '#voiceHint.show{display:block}',
    '#voiceHint b{color:#e84c9b}',
    '#voiceHint .vno{color:#f05252}',
  ].join('');
  document.head.appendChild(style);

  const dock = document.createElement('div');
  dock.id = 'voiceDock';

  const zoomDock = document.createElement('div');
  zoomDock.id = 'zoomDock';

  const btnZoomOut = document.createElement('button');
  btnZoomOut.textContent = '−';
  btnZoomOut.title = 'Diminuir zoom (Ctrl+-)';
  btnZoomOut.addEventListener('click', zoomOut);

  const zoomLabel = document.createElement('span');
  zoomLabel.id = 'zoomLabel';
  zoomLabel.textContent = Math.round((state.zoom || 1) * 100) + '%';

  const btnZoomIn = document.createElement('button');
  btnZoomIn.textContent = '+';
  btnZoomIn.title = 'Aumentar zoom (Ctrl+=)';
  btnZoomIn.addEventListener('click', zoomIn);

  const btnZoomReset = document.createElement('button');
  btnZoomReset.textContent = '⟲';
  btnZoomReset.title = 'Resetar zoom (Ctrl+0)';
  btnZoomReset.addEventListener('click', zoomReset);

  zoomDock.append(btnZoomOut, zoomLabel, btnZoomIn, btnZoomReset);

  const btn = document.createElement('button');
  btn.id = 'voiceBtn';
  btn.title = 'Voz (Ctrl+Shift+M) — clique para ativar/desativar';
  btn.textContent = '🎤';
  if (!voiceState.supported) {
    btn.classList.add('unsupported');
    btn.title = 'Microfone não suportado neste ambiente — clique para testar';
  }
  btn.addEventListener('click', toggleVoice);

  dock.append(zoomDock, btn);
  document.body.appendChild(dock);

  const hint = document.createElement('div');
  hint.id = 'voiceHint';
  document.body.appendChild(hint);
}

function bootVoice() {
  initVoice();
  ensureVoiceUI();
  updateVoiceBtn();
  updateZoomLabel();
  if (!voiceState.supported) console.warn('[voice] Web Speech API indisponivel neste ambiente');
  else console.log('[voice] pronto - Ctrl+Shift+M liga o mic; comandos diretos OU fala livre (vira prompt na barra do DeepSeek)');
  console.log('[zoom] ativo =', Math.round((state.zoom || 1) * 100) + '%');
}

async function diagnoseVoice() {
  toast('🔬 Diagnóstico de voz + rede…', 'ok');
  console.log('=== DSedit · Diagnóstico de Voz ===');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  console.log('SpeechRecognition:', SR ? 'disponível' : 'AUSENTE');
  console.log('Idioma:', voiceState.lang);
  console.log('Suporte:', voiceState.supported);
  const micOk = await testMic();
  console.log('Mic hardware:', micOk ? 'OK' : 'FALHOU');
  const net = await networkDiagnose();
  const gOk = net.find(r => /Google Speech/i.test(r.alvo))?.ok;
  const g2Ok = net.find(r => /Google \(geral\)/i.test(r.alvo))?.ok;
  console.log('Google Speech alcançável:', gOk);
  console.log('Google geral alcançável:', g2Ok);
  if (!SR) {
    toast('🔬 Voz indisponível: WebView2 sem SpeechRecognition', 'err');
  } else if (!gOk || !g2Ok) {
    toast('🔬 Mic OK, mas SEM acesso aos servidores Google — é por isso que dá "network". Veja o console.', 'err');
  } else if (!micOk) {
    toast('🔬 Servidores OK, mas mic falhou — cheque Windows → Privacidade → Microfone', 'err');
  } else {
    toast('🔬 Tudo OK — tente falar novamente (mic + rede + API)', 'ok');
  }
}

/* ---------- Boot ---------- */
renderTabs();

(async () => {
  try {
    const zs = localStorage.getItem('dsedit.zoom');
    if (zs) { const z = parseFloat(zs); if (z && z !== 1) applyZoom(z); }
  } catch (e) {}
  await restoreSession();
  await refreshSelfState();
  updateContextBadge();
  bootVoice();
  console.log('DSedit frontend pronto · self-hosting + contexto + terminal + voz + zoom');
})();