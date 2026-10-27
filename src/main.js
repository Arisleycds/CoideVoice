const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;
const listen = TAURI?.event?.listen;

let currentPath = '.';
let pendingOps = [];
let autoRun = false;

function log(msg, type = 'info') {
  const out = document.getElementById('log-output');
  if (!out) { console.log(`[${type}] ${msg}`); return; }
  const d = document.createElement('div');
  d.className = `log-entry log-${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  out.appendChild(d);
  out.scrollTop = out.scrollHeight;
}
function $(id) { return document.getElementById(id); }
function bind(id, ev, fn) {
  const el = $(id);
  if (!el) { console.warn(`[DeepEdit] #${id} não encontrado`); return; }
  el.addEventListener(ev, fn);
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

async function loadProjects() {
  const el = $('projects-list');
  try {
    const projects = await invoke('list_projects');
    if (!projects.length) {
      el.innerHTML = '<p class="placeholder">Nenhum projeto. Crie um novo.</p>';
      return;
    }
    el.innerHTML = projects.map(p => `
      <div class="project-row ${p.is_active ? 'active' : ''}">
        <div class="project-info">
          <span class="project-name">${esc(p.name)}</span>
          <span class="project-meta">${p.file_count} arquivo(s) • ${esc(p.path)}</span>
        </div>
        <button class="btn btn-small" data-path="${esc(p.path)}">${p.is_active ? '✅ Ativo' : 'Abrir'}</button>
      </div>
    `).join('');
    el.querySelectorAll('button[data-path]').forEach(b => {
      b.onclick = async () => {
        try {
          const ws = await invoke('select_project', { path: b.dataset.path });
          log(`Projeto ativo: ${ws}`, 'success');
          await refreshAll();
        } catch (e) { log(`❌ ${e}`, 'error'); }
      };
    });
  } catch (e) {
    el.innerHTML = `<p class="placeholder">Erro: ${esc(String(e))}</p>`;
  }
}

async function updateBadge() {
  const badge = $('project-badge');
  try {
    const active = await invoke('get_active_project');
    if (active) {
      badge.textContent = `📁 ${active.name}`;
      badge.className = 'project-badge active';
    } else {
      badge.textContent = 'Nenhum projeto';
      badge.className = 'project-badge';
    }
  } catch {}
}

async function loadFiles(path = '.') {
  currentPath = path;
  const el = $('file-list');
  const bc = $('breadcrumb');
  try {
    const r = await invoke('fs_list', { path });
    bc.textContent = '/' + (path === '.' ? '' : path);
    if (!r.entries.length) {
      el.innerHTML = '<p class="placeholder">Pasta vazia.</p>';
      return;
    }
    el.innerHTML = r.entries.map(e => `
      <div class="file-item ${e.is_dir ? 'is-dir' : ''}" data-path="${esc(e.path)}" data-dir="${e.is_dir}">
        <span class="file-icon">${e.is_dir ? '📁' : '📄'}</span>
        <span class="file-name">${esc(e.path.split('/').pop() || e.path)}</span>
        <span class="file-size">${e.is_dir ? '' : e.size + 'b'}</span>
      </div>
    `).join('');
    el.querySelectorAll('.file-item').forEach(row => {
      row.onclick = async () => {
        const p = row.dataset.path;
        if (row.dataset.dir === 'true') await loadFiles(p);
        else {
          try {
            const r = await invoke('fs_read', { path: p });
            log(`📖 ${p} (${r.message})`, 'info');
          } catch (e) { log(`❌ ${e}`, 'error'); }
        }
      };
    });
  } catch (e) {
    el.innerHTML = `<p class="placeholder">Erro: ${esc(String(e))}</p>`;
  }
}

async function refreshAll() {
  await updateBadge();
  await loadProjects();
  await loadFiles('.');
}

function renderPending() {
  const el = $('pending-ops');
  const btnRun = $('btn-run-pending');
  const btnClear = $('btn-clear-pending');
  if (!pendingOps.length) {
    el.innerHTML = '<p class="placeholder">Nenhuma operação.</p>';
    btnRun.disabled = true;
    btnClear.disabled = true;
    return;
  }
  el.innerHTML = pendingOps.map(op => `
    <div class="op-row">
      <span class="op-badge op-${op.op}">${op.op}</span>
      <span class="op-path">${esc(op.path || '')}</span>
    </div>
  `).join('');
  btnRun.disabled = false;
  btnClear.disabled = false;
}

async function executeOp(op) {
  switch (op.op) {
    case 'read':   return invoke('fs_read',   { path: op.path });
    case 'write':  return invoke('fs_write',  { path: op.path, content: op.content });
    case 'append': return invoke('fs_append', { path: op.path, content: op.content });
    case 'edit':   return invoke('fs_edit',   { path: op.path, oldString: op.old, newString: op.new });
    case 'delete': return invoke('fs_delete', { path: op.path });
    case 'list':   return invoke('fs_list',   { path: op.path || '.' });
    default: throw new Error(`op desconhecida: ${op.op}`);
  }
}

async function runAllPending() {
  if (!pendingOps.length) return;
  const snapshot = [...pendingOps];
  pendingOps = [];
  renderPending();
  const failures = [];
  for (const op of snapshot) {
    try {
      const r = await executeOp(op);
      log(`✅ ${op.op} ${op.path}: ${r.message}`, 'success');
    } catch (e) {
      failures.push({ op, error: String(e) });
      log(`❌ ${op.op} ${op.path}: ${e}`, 'error');
    }
  }
  if (failures.length > 0) {
    log(`⚠️ ${failures.length} falha(s) — fallback para chat principal`, 'warning');
    try {
      await invoke('open_main_chat');
      await new Promise(r => setTimeout(r, 2000));
      const ctx = failures.map(f => `- ${f.op.op} ${f.op.path}: ${f.error}`).join('\n');
      await invoke('send_to_chat', {
        windowLabel: 'main-chat',
        message: `O chat de edição falhou:\n\n${ctx}\n\nMe ajude a resolver.`
      });
    } catch (e) { log(`Fallback falhou: ${e}`, 'error'); }
  }
  await loadFiles(currentPath);
}

function bindAll() {
  bind('btn-open-projects', 'click', () => {
    $('projects-panel').scrollIntoView({ behavior: 'smooth' });
    loadProjects();
  });

  bind('btn-open-main-chat', 'click', async () => {
    try { await invoke('open_main_chat'); log('1️⃣ Chat Principal aberto', 'success'); }
    catch (e) { log(`❌ ${e}`, 'error'); }
  });

  bind('btn-open-design-chat', 'click', async () => {
    try { await invoke('open_design_chat'); log('2️⃣ Chat Design aberto', 'success'); }
    catch (e) { log(`❌ ${e}`, 'error'); }
  });

  bind('btn-open-edit-chat', 'click', async () => {
    try { await invoke('open_edit_chat_hidden'); log('3️⃣ Chat de Edição aberto (minimizado)', 'success'); }
    catch (e) { log(`❌ ${e}`, 'error'); }
  });

  bind('btn-refresh', 'click', refreshAll);

  bind('btn-new-project', 'click', async () => {
    const name = prompt('Nome do novo projeto:');
    if (!name) return;
    try {
      const p = await invoke('create_project', { name });
      log(`Projeto criado: ${p}`, 'success');
      await refreshAll();
    } catch (e) { log(`❌ ${e}`, 'error'); }
  });

  bind('btn-run-pending', 'click', runAllPending);

  bind('btn-clear-pending', 'click', () => {
    pendingOps = [];
    renderPending();
    log('Fila limpa', 'info');
  });

  bind('btn-auto-run', 'change', (e) => {
    autoRun = e.target.checked;
    log(`Auto-run: ${autoRun ? 'ON' : 'OFF'}`, 'info');
  });
}

async function setupListeners() {
  if (!listen) return;

  // Tool calls do chat de edição
  await listen('tool-calls-detected', (e) => {
    const calls = e.payload || [];
    if (!calls.length) return;
    log(`🔧 ${calls.length} operação(ões) do Edição`, 'info');
    for (const op of calls) {
      pendingOps.push(op);
      log(`  + ${op.op} ${op.path || ''}`, 'info');
    }
    renderPending();
    if (autoRun) runAllPending();
  });

  // Principal → Design
  await listen('delegate-to-design', async (e) => {
    const briefing = e.payload?.briefing;
    if (!briefing) return;
    log(`📨 Principal delegou ao Design: "${briefing.slice(0, 60)}..."`, 'info');
    try {
      await invoke('open_design_chat');
      await new Promise(r => setTimeout(r, 3000));
      await invoke('send_to_chat', {
        windowLabel: 'design-chat',
        message: `BRIEFING DO CHAT PRINCIPAL:\n\n${briefing}\n\nEspecifique a task técnica.`
      });
      log('📤 Briefing enviado ao Design', 'success');
    } catch (err) {
      log(`❌ Falha ao delegar ao Design: ${err}`, 'error');
    }
  });

  // Design → Edição
  await listen('delegate-to-edit', async (e) => {
    const task = e.payload?.task;
    if (!task) return;
    log(`📨 Design delegou ao Edição: "${task.slice(0, 60)}..."`, 'info');
    try {
      await invoke('open_edit_chat_hidden');
      await new Promise(r => setTimeout(r, 3000));
      await invoke('send_to_chat', {
        windowLabel: 'edit-chat',
        message: `TASK DO CHAT DESIGN:\n\n${task}\n\nExecute com tool calls.`
      });
      log('📤 Task enviada ao Edição', 'success');
    } catch (err) {
      log(`❌ Falha ao delegar ao Edição: ${err}`, 'error');
    }
  });
}

async function boot() {
  if (!TAURI) { log('❌ window.__TAURI__ ausente', 'error'); return; }
  bindAll();
  await setupListeners();
  renderPending();
  await refreshAll();
  log('DeepEdit iniciado', 'success');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}