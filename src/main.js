// src/main.js — Frontend principal do DeepSeek Manager
// Sem top-level await. Aguarda DOMContentLoaded. Usa window.__TAURI__.

// ═══════════════════════════════════════════════════════════
// BOOTSTRAP DO __TAURI__
// ═══════════════════════════════════════════════════════════
const TAURI = window.__TAURI__;
if (!TAURI) {
  console.error('[DSM] window.__TAURI__ ausente. Verifique withGlobalTauri: true no tauri.conf.json');
}
const invoke = TAURI?.core?.invoke;
const listen = TAURI?.event?.listen;

// ═══════════════════════════════════════════════════════════
// ESTADO
// ═══════════════════════════════════════════════════════════
let currentContext = [];
let pendingOps = [];
let autoRun = false;

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function log(msg, type = 'info') {
  const out = document.getElementById('log-output');
  if (!out) {
    console.log(`[${type}] ${msg}`);
    return;
  }
  const d = document.createElement('div');
  d.className = `log-entry log-${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  out.appendChild(d);
  out.scrollTop = out.scrollHeight;
}

function est(text) {
  return Math.ceil((text || '').length / 4);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function $(id) {
  return document.getElementById(id);
}

function bind(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`[DSM] Elemento #${id} não encontrado`);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

// ═══════════════════════════════════════════════════════════
// WORKSPACE
// ═══════════════════════════════════════════════════════════
async function refreshWorkspace() {
  try {
    const ws = await invoke('get_workspace');
    const elWs = $('workspace-path');
    if (elWs) elWs.textContent = ws;

    const r = await invoke('fs_list', { path: '.' });
    renderFileList(r.entries || []);
  } catch (e) {
    log(`Erro ao listar workspace: ${e}`, 'error');
  }
}

function renderFileList(entries) {
  const el = $('file-list');
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = '<p class="placeholder">Workspace vazio.</p>';
    return;
  }
  el.innerHTML = entries
    .map(
      (e) => `
      <div class="file-item ${e.is_dir ? 'is-dir' : ''}" data-path="${escapeHtml(e.path)}">
        <span class="file-icon">${e.is_dir ? '📁' : '📄'}</span>
        <span class="file-name">${escapeHtml(e.path)}</span>
        <span class="file-size">${e.is_dir ? '' : e.size + 'b'}</span>
      </div>`
    )
    .join('');
}

// ═══════════════════════════════════════════════════════════
// CONTEXTO
// ═══════════════════════════════════════════════════════════
function renderContext() {
  const el = $('context-display');
  if (!el) return;
  if (!currentContext.length) {
    el.innerHTML = '<p class="placeholder">Nenhum contexto.</p>';
    return;
  }
  el.innerHTML = currentContext
    .map(
      (m) =>
        `<div class="context-message"><span class="role">${m.role || 'user'}:</span> <span>${escapeHtml(
          (m.content || '').slice(0, 200)
        )}${(m.content || '').length > 200 ? '...' : ''}</span></div>`
    )
    .join('');
}

// ═══════════════════════════════════════════════════════════
// FILA DE OPERAÇÕES
// ═══════════════════════════════════════════════════════════
function renderPendingOps() {
  const el = $('pending-ops');
  const btnRun = $('btn-run-pending');
  const btnClear = $('btn-clear-pending');
  if (!el) return;

  if (!pendingOps.length) {
    el.innerHTML = '<p class="placeholder">Nenhuma operação pendente.</p>';
    if (btnRun) btnRun.disabled = true;
    if (btnClear) btnClear.disabled = true;
    return;
  }

  el.innerHTML = pendingOps
    .map(
      (op, i) => `
      <div class="op-row" data-index="${i}">
        <span class="op-badge op-${op.op}">${op.op}</span>
        <span class="op-path">${escapeHtml(op.path || '(sem path)')}</span>
        ${op.op === 'edit' ? '<span class="op-meta">old→new</span>' : ''}
        ${op.op === 'write' || op.op === 'append' ? `<span class="op-meta">${(op.content || '').length}b</span>` : ''}
      </div>`
    )
    .join('');
  if (btnRun) btnRun.disabled = false;
  if (btnClear) btnClear.disabled = false;
}

async function executeOp(op) {
  switch (op.op) {
    case 'read':
      return invoke('fs_read', { path: op.path });
    case 'write':
      return invoke('fs_write', { path: op.path, content: op.content });
    case 'append':
      return invoke('fs_append', { path: op.path, content: op.content });
    case 'edit':
      return invoke('fs_edit', { path: op.path, oldString: op.old, newString: op.new });
    case 'delete':
      return invoke('fs_delete', { path: op.path });
    case 'list':
      return invoke('fs_list', { path: op.path || '.' });
    default:
      throw new Error(`op desconhecida: ${op.op}`);
  }
}

async function runAllPending() {
  if (!pendingOps.length) return;
  const snapshot = [...pendingOps];
  pendingOps = [];
  renderPendingOps();
  for (const op of snapshot) {
    try {
      const r = await executeOp(op);
      log(`✅ ${op.op} ${op.path}: ${r.message}`, 'success');
    } catch (e) {
      log(`❌ ${op.op} ${op.path}: ${e}`, 'error');
    }
  }
  await refreshWorkspace();
}

// ═══════════════════════════════════════════════════════════
// BINDINGS
// ═══════════════════════════════════════════════════════════
function bindAll() {
  // ── Abrir DeepSeek ──
  bind('btn-open-deepseek', 'click', async () => {
    console.log('[DSM] btn-open-deepseek clicado');
    try {
      await invoke('open_deepseek_window');
      log('DeepSeek aberto', 'success');
    } catch (e) {
      log(`Erro ao abrir DeepSeek: ${e}`, 'error');
      console.error('[DSM] open_deepseek_window:', e);
    }
  });

  // ── Navegação ──
  bind('btn-manage-context', 'click', () => {
    const p = $('context-panel');
    if (p) p.scrollIntoView({ behavior: 'smooth' });
  });

  bind('btn-manage-cookies', 'click', () => {
    const p = $('cookies-panel');
    if (p) p.scrollIntoView({ behavior: 'smooth' });
  });

  bind('btn-file-operations', 'click', async () => {
    const p = $('files-panel');
    if (p) p.scrollIntoView({ behavior: 'smooth' });
    await refreshWorkspace();
  });

  // ── Contexto ──
  bind('btn-compress-context', 'click', () => {
    const lim = parseInt($('token-limit')?.value || '4000', 10) || 4000;
    let tot = 0;
    const out = [];
    for (const m of currentContext) {
      const t = est(m.content);
      if (tot + t <= lim) {
        out.push(m);
        tot += t;
      } else {
        const r = lim - tot;
        if (r > 50) out.push({ ...m, content: (m.content || '').slice(0, r * 4) + '…' });
        break;
      }
    }
    currentContext = out;
    renderContext();
    const tc = $('token-count');
    if (tc) tc.textContent = tot;
    log(`Contexto comprimido: ${tot} tokens`, 'success');
  });

  bind('btn-clear-context-panel', 'click', () => {
    currentContext = [];
    renderContext();
    const tc = $('token-count');
    if (tc) tc.textContent = '0';
    log('Contexto limpo', 'info');
  });

  // ── Arquivos ──
  bind('btn-create-file', 'click', async () => {
    const p = prompt('Caminho do novo arquivo:');
    if (!p) return;
    try {
      const r = await invoke('fs_write', { path: p, content: '' });
      log(`✅ ${r.message}: ${r.path}`, 'success');
      await refreshWorkspace();
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  bind('btn-edit-file', 'click', async () => {
    const p = prompt('Caminho do arquivo:');
    if (!p) return;
    try {
      const r = await invoke('fs_read', { path: p });
      const novo = prompt(`Conteúdo atual:\n\n${r.content}\n\nNovo conteúdo:`, r.content);
      if (novo === null) return;
      const w = await invoke('fs_write', { path: p, content: novo });
      log(`✅ ${w.message}: ${w.path}`, 'success');
      await refreshWorkspace();
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  bind('btn-delete-file', 'click', async () => {
    const p = prompt('Caminho para excluir:');
    if (!p) return;
    if (!confirm(`Excluir "${p}"?`)) return;
    try {
      const r = await invoke('fs_delete', { path: p });
      log(`✅ ${r.message}: ${r.path}`, 'success');
      await refreshWorkspace();
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  bind('btn-change-workspace', 'click', async () => {
    const p = prompt('Novo caminho do workspace (será criado se não existir):');
    if (!p) return;
    try {
      const ws = await invoke('set_workspace', { path: p });
      log(`Workspace alterado: ${ws}`, 'success');
      await refreshWorkspace();
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  // ── Cookies ──
  bind('btn-export-cookies', 'click', async () => {
    try {
      const c = await invoke('get_cookies');
      const input = $('cookie-input');
      if (input) input.value = JSON.stringify(c, null, 2);
      log(`Cookies exportados: ${c.length} itens`, 'success');
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  bind('btn-import-cookies', 'click', async () => {
    try {
      const input = $('cookie-input');
      const c = JSON.parse(input?.value || '[]');
      await invoke('plugin:store|set', { key: 'dsm_cookies', value: c });
      log('Cookies salvos', 'success');
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  bind('btn-check-login', 'click', async () => {
    try {
      const c = await invoke('get_cookies');
      const ok = c.some((x) => /session|token/i.test(x));
      const el = $('login-status');
      if (el) {
        el.textContent = ok ? '✅ Logado' : '❌ Não logado';
        el.className = ok ? 'status-success' : 'status-error';
      }
    } catch (e) {
      log(`❌ ${e}`, 'error');
    }
  });

  // ── Fila de operações ──
  bind('btn-run-pending', 'click', runAllPending);

  bind('btn-clear-pending', 'click', () => {
    pendingOps = [];
    renderPendingOps();
    log('Fila limpa', 'info');
  });

  bind('btn-auto-run', 'change', (e) => {
    autoRun = e.target.checked;
    log(`Auto-run: ${autoRun ? 'ON' : 'OFF'}`, 'info');
  });
}

// ═══════════════════════════════════════════════════════════
// LISTENERS DE EVENTOS
// ═══════════════════════════════════════════════════════════
async function setupListeners() {
  if (!listen) {
    console.error('[DSM] listen indisponível');
    return;
  }

  try {
    await listen('tool-calls-detected', (event) => {
      const calls = event.payload || [];
      if (!calls.length) return;

      log(`🔧 ${calls.length} operação(ões) detectada(s)`, 'info');
      for (const op of calls) {
        pendingOps.push(op);
        log(`  + ${op.op} ${op.path || ''}`, 'info');
      }
      renderPendingOps();

      if (autoRun) {
        log('Auto-run ativo — executando', 'info');
        runAllPending();
      }
    });

    await listen('context-captured', (event) => {
      currentContext = event.payload || [];
      renderContext();
      const tc = $('token-count');
      if (tc) tc.textContent = currentContext.reduce((s, m) => s + est(m.content), 0);
      log(`Contexto: ${currentContext.length} mensagens`, 'success');
    });

    await listen('command-executed', (event) => {
      const r = event.payload;
      log(`✅ ${r.command} "${r.path}": ${r.message}`, 'success');
    });

    await listen('command-error', (event) => {
      log(`❌ @${event.payload.cmd}: ${event.payload.error}`, 'error');
    });

    console.log('[DSM] Listeners registrados');
  } catch (e) {
    console.error('[DSM] erro ao registrar listeners:', e);
  }
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
async function boot() {
  console.log('[DSM] Boot iniciando');

  if (!TAURI) {
    log('❌ window.__TAURI__ ausente — verifique withGlobalTauri', 'error');
    return;
  }

  bindAll();
  await setupListeners();
  renderPendingOps();

  try {
    await refreshWorkspace();
  } catch (e) {
    log(`Erro no workspace inicial: ${e}`, 'error');
  }

  try {
    const saved = await invoke('plugin:store|get', { key: 'dsm_cookies' });
    const input = $('cookie-input');
    if (saved && input) {
      input.value = JSON.stringify(saved, null, 2);
    }
  } catch {
    // sem cookies salvos
  }

  log('DeepSeek Manager iniciado', 'success');
}

// Aguarda DOM antes de inicializar
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}