const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;
const listen = TAURI?.event?.listen;

const INDEX_FILE = '_deepedit_index.json';
const SMALL_FILE_LIMIT = 1000;
const INDEX_MSG_LIMIT = 12000;

let currentPath = '.';
let pendingOps = [];
let previewFile = null;
let pipelineHistory = [];
let autoPreviewOn = true;
let lastTask = null;
let fileIndex = {};
let indexDirty = false;
let contextSent = false;
let previewPort = null;

const chatReady = {
  'conversador-chat': false,
  'edit-chat': false
};
const pendingMessages = {
  'conversador-chat': [],
  'edit-chat': []
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
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

function addPipelineEntry(stage, text, status = 'info') {
  pipelineHistory.unshift({ stage, text, status, time: new Date().toLocaleTimeString() });
  if (pipelineHistory.length > 200) pipelineHistory.pop();
  renderPipeline();
  notifyConversa('pipeline', { stage, text, status });
}

function renderPipeline() {
  const el = $('pipeline-log');
  if (!el) return;
  if (!pipelineHistory.length) {
    el.innerHTML = '<p class="placeholder">Nenhum evento ainda.</p>';
    return;
  }
  el.innerHTML = pipelineHistory.map(e => `
    <div class="pipeline-entry pipeline-${e.status}">
      <span class="pipeline-time">${e.time}</span>
      <span class="pipeline-stage">${esc(e.stage)}</span>
      <span class="pipeline-text">${esc(e.text)}</span>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════
// ENVIO (readiness + chunks)
// ═══════════════════════════════════════════════════════════
async function sendWhenReady(windowLabel, message) {
  log(`📤 sendWhenReady(${windowLabel}, ${message.length}b) ready=${chatReady[windowLabel]}`, 'info');
  if (chatReady[windowLabel]) {
    return invoke('send_to_chat', { windowLabel, message });
  }
  return new Promise((resolve, reject) => {
    pendingMessages[windowLabel].push({ message, resolve, reject });
    log(`⏳ Aguardando ${windowLabel}...`, 'info');
  });
}

async function flushPending(windowLabel) {
  const q = pendingMessages[windowLabel];
  if (!q.length) return;
  log(`📤 flushPending(${windowLabel}) ${q.length}`, 'info');
  for (const item of q) {
    try {
      await invoke('send_to_chat', { windowLabel, message: item.message });
      log(`✅ Enviado a ${windowLabel}`, 'success');
      item.resolve();
    } catch (e) {
      log(`❌ Falha a ${windowLabel}: ${e}`, 'error');
      item.reject(e);
    }
  }
  pendingMessages[windowLabel] = [];
}

async function waitReadyAndSend(label, message) {
  try { await invoke('wait_for_chat_ready', { windowLabel: label, maxMs: 30000 }); } catch (e) {}

  // Edição: task em UM ÚNICO envio
  if (label === 'edit-chat') {
    return sendWhenReady(label, message);
  }

  // Conversador: divide se > 1500
  if (message.length > 1500) {
    const chunks = [];
    for (let i = 0; i < message.length; i += 1500) chunks.push(message.slice(i, i + 1500));
    log(`📤 ${label}: ${message.length} chars em ${chunks.length} chunks`, 'info');
    for (let i = 0; i < chunks.length; i++) {
      const prefix = `[Parte ${i+1}/${chunks.length}] `;
      await sendWhenReady(label, prefix + chunks[i]);
      log(`  ✅ Chunk ${i+1}/${chunks.length}`, 'info');
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
    }
    return;
  }
  return sendWhenReady(label, message);
}

async function notifyConversa(kind, payload) {
  try {
    await invoke('inject_script_into', {
      windowLabel: 'conversa',
      script: `window.__onDeepEditEvent && window.__onDeepEditEvent(${JSON.stringify(kind)}, ${JSON.stringify(payload || {})})`
    });
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
// INDEXAÇÃO
// ═══════════════════════════════════════════════════════════
function extractSignatures(content, ext) {
  const sigs = [];
  let m;
  if (['js', 'ts', 'jsx', 'tsx', 'mjs'].includes(ext)) {
    const fnRe = /(?:function|const|let|var)\s+(\w+)\s*(?:=\s*)?(?:\([^)]*\)\s*=>|\([^)]*\)\s*\{|\{)/g;
    while ((m = fnRe.exec(content)) !== null) sigs.push(m[1]);
    const clsRe = /class\s+(\w+)/g;
    while ((m = clsRe.exec(content)) !== null) sigs.push('class ' + m[1]);
  } else if (['py'].includes(ext)) {
    const defRe = /def\s+(\w+)/g;
    while ((m = defRe.exec(content)) !== null) sigs.push(m[1]);
    const clsRe = /class\s+(\w+)/g;
    while ((m = clsRe.exec(content)) !== null) sigs.push('class ' + m[1]);
  } else if (['rs'].includes(ext)) {
    const fnRe = /fn\s+(\w+)/g;
    while ((m = fnRe.exec(content)) !== null) sigs.push(m[1]);
    const structRe = /struct\s+(\w+)/g;
    while ((m = structRe.exec(content)) !== null) sigs.push('struct ' + m[1]);
  } else if (['java'].includes(ext)) {
    const methodRe = /(?:public|private|protected)\s+\w+\s+(\w+)\s*\(/g;
    while ((m = methodRe.exec(content)) !== null) sigs.push(m[1]);
    const classRe = /class\s+(\w+)/g;
    while ((m = classRe.exec(content)) !== null) sigs.push('class ' + m[1]);
  } else if (['css', 'scss', 'sass'].includes(ext)) {
    const clsRe = /\.([\w-]+)\s*\{/g;
    while ((m = clsRe.exec(content)) !== null) sigs.push('.' + m[1]);
  } else if (['html', 'htm'].includes(ext)) {
    const tagRe = /<(canvas|script|style|div|section|main|header|footer)/g;
    while ((m = tagRe.exec(content)) !== null) sigs.push('<' + m[1] + '>');
  }
  return [...new Set(sigs)].slice(0, 20);
}

function extractDescription(content) {
  const lines = content.split('\n').slice(0, 10);
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('<!--')) {
      return t.replace(/^[\/\*#<!\-\s]+|[\/\*>\s]+$/g, '').slice(0, 100);
    }
  }
  return '';
}

async function indexFile(path) {
  try {
    const r = await invoke('fs_read', { path });
    const content = r.content || '';
    const ext = path.split('.').pop().toLowerCase();
    fileIndex[path] = {
      type: ext,
      functions: extractSignatures(content, ext),
      description: extractDescription(content),
      size: content.length,
      mtime: Date.now()
    };
  } catch (e) {
    fileIndex[path] = { type: '?', functions: [], description: '', size: 0, error: String(e) };
  }
}

async function saveIndex() {
  try {
    const data = {
      generated_at: new Date().toISOString(),
      project: (await invoke('get_active_project'))?.name || '(sem projeto)',
      files: fileIndex
    };
    await invoke('fs_write', { path: INDEX_FILE, content: JSON.stringify(data, null, 2) });
    log(`📇 Índice salvo em ${INDEX_FILE}`, 'success');
  } catch (e) {
    log(`Erro ao salvar índice: ${e}`, 'warning');
  }
}

async function loadIndex() {
  try {
    const r = await invoke('fs_read', { path: INDEX_FILE });
    const data = JSON.parse(r.content);
    if (data && data.files) {
      fileIndex = data.files;
      log(`📇 Índice carregado (${Object.keys(fileIndex).length} arquivos)`, 'info');
      return true;
    }
  } catch (e) {}
  return false;
}

async function indexProject(force = false) {
  if (!force && await loadIndex()) return Object.keys(fileIndex).length;
  try {
    const allFiles = [];
    async function scan(path) {
      const r = await invoke('fs_list', { path });
      for (const e of r.entries) {
        if (e.is_dir) await scan(e.path);
        else allFiles.push(e.path);
      }
    }
    await scan('.');
    fileIndex = {};
    for (const f of allFiles) await indexFile(f);
    indexDirty = false;
    await saveIndex();
    log(`📇 Indexados ${allFiles.length} arquivos`, 'info');
    return allFiles.length;
  } catch (e) {
    log(`Erro ao indexar: ${e}`, 'error');
    return 0;
  }
}

function formatIndexForConversador() {
  const lines = [];
  const icons = {
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜', mjs: '📜',
    html: '🌐', htm: '🌐',
    css: '🎨', scss: '🎨', sass: '🎨',
    json: '⚙️', yaml: '⚙️', yml: '⚙️', toml: '⚙️',
    md: '📝', txt: '📝',
    py: '🐍', rs: '🦀', java: '☕',
    png: '🖼️', jpg: '🖼️', svg: '🖼️', gif: '🖼️'
  };
  for (const [path, info] of Object.entries(fileIndex)) {
    const icon = icons[info.type] || '📄';
    let line = `${icon} ${path} (${info.size}b)`;
    if (info.description) line += ` — ${info.description}`;
    if (info.functions && info.functions.length > 0) {
      line += `\n   funções: ${info.functions.join(', ')}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function sendContextToConversador() {
  try {
    const count = await indexProject();
    const active = await invoke('get_active_project');
    const projectName = active?.name || '(sem projeto)';
    const index = formatIndexForConversador();

    let msg =
      '📂 CONTEXTO DO PROJETO\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      'Projeto: ' + projectName + '\n' +
      'Arquivos: ' + count + '\n' +
      'Relatório: ' + INDEX_FILE + '\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '📇 ÍNDICE (arquivo → funções):\n' + index + '\n\n';

    const smallFiles = Object.entries(fileIndex)
      .filter(([p, i]) => i.size > 0 && i.size < SMALL_FILE_LIMIT && !p.endsWith('.png') && !p.endsWith('.jpg') && !p.endsWith('.svg'));

    if (smallFiles.length > 0) {
      msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
             '📄 ARQUIVOS PEQUENOS (conteúdo completo):\n' +
             '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
      for (const [p] of smallFiles) {
        try {
          const r = await invoke('fs_read', { path: p });
          let content = r.content || '';
          if (content.length > SMALL_FILE_LIMIT) content = content.slice(0, SMALL_FILE_LIMIT) + '\n... (truncado)';
          msg += '📄 ' + p + ':\n```\n' + content + '\n```\n\n';
        } catch (e) {}
      }
    }

    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
           'Use {"path": "..."} para ler um arquivo grande.\n' +
           'Use {"task": "..."} para criar/editar.\n' +
           'NÃO peça para o humano colar arquivos.';

    if (msg.length > INDEX_MSG_LIMIT) {
      msg = msg.slice(0, INDEX_MSG_LIMIT - 100) + '\n... (índice truncado)';
    }

    await invoke('send_to_chat', { windowLabel: 'conversador-chat', message: msg });
    log(`📇 Contexto: ${count} arquivos, ${smallFiles.length} pequenos completos`, 'info');
  } catch (e) {
    log('Erro ao enviar contexto: ' + e, 'warning');
  }
}

// ═══════════════════════════════════════════════════════════
// PROJETOS
// ═══════════════════════════════════════════════════════════
async function loadProjects() {
  const el = $('projects-list');
  if (!el) return;
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
          fileIndex = {};
          contextSent = false;
          previewPort = null;
          await refreshAll();
          if (chatReady['conversador-chat']) await sendContextToConversador();
        } catch (e) { log(`❌ ${e}`, 'error'); }
      };
    });
  } catch (e) {
    el.innerHTML = `<p class="placeholder">Erro: ${esc(String(e))}</p>`;
  }
}

async function updateBadge() {
  const badge = $('project-badge');
  if (!badge) return;
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

// ═══════════════════════════════════════════════════════════
// ARQUIVOS
// ═══════════════════════════════════════════════════════════
async function loadFiles(path = '.') {
  currentPath = path;
  const el = $('file-list');
  const bc = $('breadcrumb');
  if (!el) return;
  try {
    const r = await invoke('fs_list', { path });
    if (bc) bc.textContent = '/' + (path === '.' ? '' : path);
    const entries = r.entries.filter(e => e.path !== INDEX_FILE);
    if (!entries.length) {
      el.innerHTML = '<p class="placeholder">Pasta vazia.</p>';
      return;
    }
    el.innerHTML = entries.map(e => `
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
  await loadPreviewFiles();
}

// ═══════════════════════════════════════════════════════════
// OPERAÇÕES
// ═══════════════════════════════════════════════════════════
function renderPending() {
  const el = $('pending-ops');
  const btnClear = $('btn-clear-pending');
  if (!el) return;
  if (!pendingOps.length) {
    el.innerHTML = '<p class="placeholder">Nenhuma operação.</p>';
    if (btnClear) btnClear.disabled = true;
    return;
  }
  el.innerHTML = pendingOps.map(op => `
    <div class="op-row">
      <span class="op-badge op-${op.op}">${op.op}</span>
      <span class="op-path">${esc(op.path || '')}</span>
      <span class="op-size">${op.content ? op.content.length + 'b' : ''}</span>
    </div>
  `).join('');
  if (btnClear) btnClear.disabled = false;
}

async function executeOp(op) {
  const CHUNK_SIZE = 1500;

  switch (op.op) {
    case 'read':
      return invoke('fs_read', { path: op.path });

    case 'search': {
      const r = await invoke('fs_search', {
        path: op.path,
        query: op.query,
        contextLines: op.context || 2
      });
      let out = `MATCHES DE "${op.query}" EM ${op.path} (${r.matches.length}):\n\n`;
      for (const m of r.matches) {
        out += `--- linha ${m.line} ---\n`;
        out += m.context.join('\n');
        out += '\n\n';
      }
      return { success: true, op: 'search', path: op.path, message: r.message, content: out };
    }

    case 'replace': {
      const r = await invoke('fs_replace', {
        path: op.path,
        rules: op.rules || [],
        dryRun: op.dry_run || false,
        backup: op.backup !== false
      });
      if (r.rules_missed.length > 0) {
        log(`⚠️ ${r.rules_missed.length} regra(s) não encontrada(s)`, 'warning');
      }
      return { success: true, op: 'replace', path: op.path, message: r.message };
    }

    case 'write': {
      const content = op.content || '';
      if (content.length <= CHUNK_SIZE) {
        return invoke('fs_write', { path: op.path, content });
      }
      const chunks = [];
      for (let i = 0; i < content.length; i += CHUNK_SIZE) {
        chunks.push(content.slice(i, i + CHUNK_SIZE));
      }
      log(`📦 ${op.path}: ${content.length} chars em ${chunks.length} partes`, 'info');
      const first = await invoke('fs_write', { path: op.path, content: chunks[0] });
      log(`  ✅ write 1/${chunks.length}`, 'success');
      for (let i = 1; i < chunks.length; i++) {
        await invoke('fs_append', { path: op.path, content: chunks[i] });
        log(`  ✅ append ${i+1}/${chunks.length}`, 'success');
      }
      return { success: true, op: 'write', path: op.path, message: `${content.length} bytes em ${chunks.length} partes` };
    }

    case 'append':
      return invoke('fs_append', { path: op.path, content: op.content });

    case 'edit':
      return invoke('fs_edit', { path: op.path, oldString: op.old, newString: op.new });

    case 'delete':
      return invoke('fs_delete', { path: op.path });

    case 'list':
      return invoke('fs_list', { path: op.path || '.' });

    case 'noop':
      return { success: true, op: 'noop', path: '', message: 'noop' };

    default:
      throw new Error(`op desconhecida: ${op.op}`);
  }
}

async function autoRunPending() {
  if (!pendingOps.length) return;
  const snapshot = [...pendingOps];
  pendingOps = [];
  renderPending();

  // Git snapshot ANTES de executar
  const hasWrites = snapshot.some(op =>
    ['write', 'append', 'edit', 'replace', 'delete'].includes(op.op)
  );
  if (hasWrites) {
    try {
      const msg = `Antes de: ${(lastTask || 'task').slice(0, 60).replace(/\n/g, ' ')}`;
      const r = await invoke('git_snapshot', { message: msg });
      if (r.oid) log(`💾 ${r.message}`, 'success');
      else log(`💾 ${r.message}`, 'info');
    } catch (e) {
      log(`⚠️ Git snapshot falhou: ${e}`, 'warning');
    }
  }

  const failures = [];
  const succeeded = [];
  const writtenHtmls = [];
  const modifiedFiles = new Set();
  const reads = [];
  const searches = [];

  for (const op of snapshot) {
    try {
      if (op.op === 'read') {
        const r = await executeOp(op);
        reads.push({ path: op.path, content: r.content || '', size: r.message });
        log(`✅ read ${op.path}: ${r.message}`, 'success');
        succeeded.push({ op, result: r });
        continue;
      }
      if (op.op === 'search') {
        const r = await executeOp(op);
        searches.push({ path: op.path, query: op.query, content: r.content || '', count: r.message });
        log(`🔍 search "${op.query}" em ${op.path}: ${r.message}`, 'success');
        succeeded.push({ op, result: r });
        continue;
      }
      if (op.op === 'noop') {
        succeeded.push({ op, result: { message: 'noop' } });
        continue;
      }
      const r = await executeOp(op);
      log(`✅ ${op.op} ${op.path || ''}: ${r.message}`, 'success');
      succeeded.push({ op, result: r });
      if (op.path) modifiedFiles.add(op.path);
      if ((op.op === 'write' || op.op === 'append' || op.op === 'edit' || op.op === 'replace') &&
          op.path && (op.path.endsWith('.html') || op.path.endsWith('.htm'))) {
        writtenHtmls.push(op.path);
      }
    } catch (e) {
      failures.push({ op, error: String(e) });
      log(`❌ ${op.op} ${op.path || ''}: ${e}`, 'error');
    }
  }

  // Devolve reads ao Edição
  for (const r of reads) {
    log(`📤 Devolvendo ${r.path} ao Edição`, 'info');
    try {
      await invoke('send_to_chat', {
        windowLabel: 'edit-chat',
        message: 'CONTEÚDO DE ' + r.path + ' (' + r.size + '):\n\n' + r.content +
          '\n\nAgora emita o edit/replace com o código NOVO. NÃO emita outro read.'
      });
    } catch (e) { log(`❌ Falha ao devolver ${r.path}: ${e}`, 'error'); }
  }

  // Devolve searches ao Edição
  for (const s of searches) {
    log(`📤 Devolvendo search "${s.query}" ao Edição`, 'info');
    try {
      await invoke('send_to_chat', {
        windowLabel: 'edit-chat',
        message: 'RESULTADO DA BUSCA:\n\n' + s.content +
          '\n\nAgora emita o edit/replace com o trecho exato. NÃO emita outro search se já tem o que precisa.'
      });
    } catch (e) { log(`❌ Falha ao devolver search: ${e}`, 'error'); }
  }

  // Reindexa + salva _deepedit_index.json
  if (modifiedFiles.size > 0) {
    log(`📇 Reindexando ${modifiedFiles.size} arquivo(s)...`, 'info');
    for (const f of modifiedFiles) {
      try { await indexFile(f); } catch (e) {}
    }
    indexDirty = true;
    try { await saveIndex(); } catch (e) {}
  }

  // Atualiza preview se HTML foi escrito
  if (writtenHtmls.length > 0) {
    try {
      await loadPreviewFiles();
      if (autoPreviewOn && previewFile) await renderPreview(previewFile);
    } catch (e) { log(`⚠️ Preview: ${e}`, 'warning'); }
  }

  try { await loadFiles(currentPath); } catch (e) {}

  // Feedback final
  if (failures.length === 0) {
    addPipelineEntry('✅ Executado', `${succeeded.length} operação(ões)`, 'success');
    notifyConversa('edit-done', {
      total: succeeded.length,
      resumo: succeeded.map(s => `${s.op.op} ${s.op.path || ''}`).join('; ')
    });
    updateStatusBadge('ok');
    await reportToConversador(snapshot, succeeded, []);
  } else {
    addPipelineEntry('⚠️ Falhas', `${failures.length} erro(s)`, 'error');
    notifyConversa('edit-error', {
      falhas: failures.length,
      detalhes: failures.map(f => `${f.op.op} ${f.op.path || ''}: ${f.error}`).join('\n')
    });
    updateStatusBadge('warn');
    await tryAutoFix(snapshot, succeeded, failures);
  }
}

async function tryAutoFix(snapshot, succeeded, failures) {
  const failedOps = failures.map(f => f.op);
  log(`🔧 Auto-correção (${failedOps.length} op)`, 'warning');
  addPipelineEntry('🔧 Auto-correção', `Reenviando ${failedOps.length} op`, 'warning');
  notifyConversa('auto-fix', { count: failedOps.length });
  const retryMsg =
    'CORRIGIR: As operações abaixo falharam. Refaça apenas elas:\n' +
    failures.map(f => `- ${f.op.op} ${f.op.path}: ${f.error}`).join('\n') +
    '\n\nEmita novamente JSON com {"op": "replace"/"write", ...}.';
  try {
    await invoke('open_edit_chat_hidden');
    await waitReadyAndSend('edit-chat', retryMsg);
  } catch (e) {
    log(`❌ Auto-correção falhou: ${e}`, 'error');
    await reportToConversador(snapshot, succeeded, failures);
  }
}

async function reportToConversador(snapshot, succeeded, failures) {
  const resumo = succeeded.map(s => `${s.op.op} ${s.op.path || ''} (${s.result.message})`).join('\n');
  const errs = failures.map(f => `${f.op.op} ${f.op.path || ''}: ${f.error}`).join('\n');
  const msg =
    'RESULTADO DA EDIÇÃO:\n' +
    'Sucesso:\n' + (resumo || '(nenhum)') + '\n' +
    'Falhas:\n' + (errs || '(nenhuma)') + '\n' +
    'Task original:\n' + (lastTask || '(desconhecida)').slice(0, 500) + '\n' +
    'Comente o resultado com o humano.';
  try {
    await invoke('open_conversador_chat');
    await waitReadyAndSend('conversador-chat', msg);
    log('📤 Resultado ao Conversador', 'info');

    if (indexDirty && chatReady['conversador-chat']) {
      const index = formatIndexForConversador();
      await invoke('send_to_chat', {
        windowLabel: 'conversador-chat',
        message: '📇 ÍNDICE ATUALIZADO:\n\n' + index
      });
      indexDirty = false;
    }
  } catch (e) {
    log(`❌ ${e}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// PREVIEW (servidor HTTP local estilo Live Server)
// ═══════════════════════════════════════════════════════════
async function loadPreviewFiles() {
  const select = $('preview-file-select');
  if (!select) return;
  try {
    const htmls = [];
    async function scan(path) {
      const res = await invoke('fs_list', { path });
      for (const e of res.entries) {
        if (e.is_dir) await scan(e.path);
        else if (e.path.endsWith('.html') || e.path.endsWith('.htm')) htmls.push(e.path);
      }
    }
    await scan('.');
    const cur = select.value;
    select.innerHTML = '<option value="">— Selecione um HTML —</option>' +
      htmls.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    if (cur && htmls.includes(cur)) select.value = cur;
    if (!previewFile && htmls.length) {
      previewFile = htmls[0];
      select.value = previewFile;
      await renderPreview(previewFile);
    }
  } catch (e) { log(`Erro ao listar HTMLs: ${e}`, 'error'); }
}

async function renderPreview(path) {
  const container = $('preview-container');
  if (!container || !path) return;

  if (!previewPort) {
    try {
      previewPort = await invoke('start_preview_server');
      log(`🌐 Preview server: http://localhost:${previewPort}`, 'success');
    } catch (e) {
      log(`❌ Falha ao iniciar preview server: ${e}`, 'error');
      container.innerHTML = `<p class="placeholder">Erro ao iniciar preview: ${esc(String(e))}</p>`;
      return;
    }
  }

  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.src = `http://localhost:${previewPort}/${path}`;
  container.appendChild(iframe);
  log(`👁️ Preview: http://localhost:${previewPort}/${path}`, 'success');
}

function updateStatusBadge(status) {
  const b = $('status-badge');
  if (!b) return;
  if (status === 'ok') { b.textContent = '✅ Pronto'; b.className = 'status-badge status-ok'; }
  else if (status === 'warn') { b.textContent = '⚠️ Erros'; b.className = 'status-badge status-warn'; }
  else { b.textContent = '⏳ Processando...'; b.className = 'status-badge status-busy'; }
}

// ═══════════════════════════════════════════════════════════
// BINDINGS
// ═══════════════════════════════════════════════════════════
function bindAll() {
  bind('btn-open-conversa', 'click', async () => {
    try { await invoke('open_conversa_panel'); log('Conversa aberta', 'success'); }
    catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-open-projects', 'click', () => {
    $('projects-panel')?.scrollIntoView({ behavior: 'smooth' });
    loadProjects();
  });
  bind('btn-open-conversador', 'click', async () => {
    try { await invoke('open_conversador_chat'); log('Conversador aberto', 'success'); }
    catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-open-edit', 'click', async () => {
    try { await invoke('open_edit_chat_hidden'); log('Edição aberta', 'success'); }
    catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-refresh', 'click', refreshAll);
  bind('btn-new-project', 'click', async () => {
    const name = prompt('Nome do novo projeto:');
    if (!name) return;
    try {
      const p = await invoke('create_project', { name });
      log(`Projeto criado: ${p}`, 'success');
      fileIndex = {};
      contextSent = false;
      previewPort = null;
      await refreshAll();
      if (chatReady['conversador-chat']) await sendContextToConversador();
    } catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-refresh-context', 'click', async () => {
    if (!chatReady['conversador-chat']) {
      log('⚠️ Conversador não está pronto', 'warning');
      return;
    }
    await sendContextToConversador();
  });
  bind('btn-clear-pending', 'click', () => { pendingOps = []; renderPending(); });
  bind('preview-file-select', 'change', (e) => {
    previewFile = e.target.value || null;
    if (previewFile) renderPreview(previewFile);
  });
  bind('btn-refresh-preview', 'click', async () => {
    await loadPreviewFiles();
    if (previewFile) await renderPreview(previewFile);
  });

  // Botões Git (se existirem no HTML)
  bind('btn-git-snapshot', 'click', async () => {
    try {
      const r = await invoke('git_snapshot', { message: 'Snapshot manual' });
      log(`💾 ${r.message}`, 'success');
    } catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-git-undo', 'click', async () => {
    if (!confirm('Desfazer a última edição da IA?')) return;
    try {
      const r = await invoke('git_undo_last');
      log(`↩️ ${r.message}`, 'success');
      await refreshAll();
    } catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-git-status', 'click', async () => {
    try {
      const r = await invoke('git_status');
      log(`📊 ${r.message}`, 'info');
    } catch (e) { log(`❌ ${e}`, 'error'); }
  });
  bind('btn-git-log', 'click', async () => {
    try {
      const r = await invoke('git_log', { limit: 10 });
      log(`📜 ${r.message}`, 'info');
    } catch (e) { log(`❌ ${e}`, 'error'); }
  });
}

// ═══════════════════════════════════════════════════════════
// LISTENERS
// ═══════════════════════════════════════════════════════════
async function setupListeners() {
  if (!listen) return;

  await listen('main-ready', async () => {
    chatReady['conversador-chat'] = true;
    log('✅ Conversador pronto', 'success');
    flushPending('conversador-chat');
    if (contextSent) {
      log('📇 Contexto já enviado', 'info');
      return;
    }
    contextSent = true;
    await sendContextToConversador();
  });
  await listen('edit-ready', () => { chatReady['edit-chat'] = true; log('✅ Edição pronta', 'success'); flushPending('edit-chat'); });

  await listen('main-response', (e) => {
    const text = e.payload?.text || '';
    addPipelineEntry('Conversador', text.slice(0, 200), 'success');
    notifyConversa('main-response', { text });
  });
  await listen('edit-response', (e) => {
    const text = e.payload?.text || '';
    addPipelineEntry('Edição', text.slice(0, 200), 'info');
    notifyConversa('edit-response', { text });
  });

  await listen('read-request', async (e) => {
    const path = e.payload?.path;
    if (!path) return;
    notifyConversa('reading', { path });
    log(`📖 Lendo ${path}...`, 'info');
    try {
      const r = await invoke('fs_read', { path });
      await waitReadyAndSend('conversador-chat',
        'CONTEÚDO DE ' + path + ' (' + r.message + '):\n\n' + r.content +
        '\n\nNÃO peça outro read. Analise e continue.'
      );
      log(`✅ ${path} lido (${r.message})`, 'success');
      notifyConversa('read-done', { path, size: r.message });
    } catch (err) {
      log(`❌ Erro ao ler ${path}: ${err}`, 'error');
      await waitReadyAndSend('conversador-chat',
        'ERRO ao ler ' + path + ': ' + err + '\n\nDecida o que fazer.'
      );
      notifyConversa('read-error', { path, error: String(err) });
    }
  });

  await listen('search-request', async (e) => {
    const { path, query, context } = e.payload || {};
    if (!path || !query) return;
    log(`🔍 Buscando "${query}" em ${path}...`, 'info');
    try {
      const r = await invoke('fs_search', { path, query, contextLines: context || 2 });
      let out = `MATCHES DE "${query}" EM ${path} (${r.matches.length}):\n\n`;
      for (const m of r.matches) {
        out += `--- linha ${m.line} ---\n` + m.context.join('\n') + '\n\n';
      }
      await waitReadyAndSend('conversador-chat',
        out + '\nAnalise os matches. NÃO peça outro search se já tem o que precisa.'
      );
      log(`✅ ${r.matches.length} match(es)`, 'success');
    } catch (err) {
      log(`❌ Erro no search: ${err}`, 'error');
      await waitReadyAndSend('conversador-chat', 'ERRO no search: ' + err);
    }
  });

  await listen('tool-calls-detected', (e) => {
    const calls = e.payload || [];
    if (!calls.length) return;
    log(`🔧 ${calls.length} operação(ões)`, 'info');
    for (const op of calls) {
      pendingOps.push(op);
      log(`  + ${op.op} ${op.path || ''} (${(op.content || '').length}b)`, 'info');
    }
    renderPending();
    updateStatusBadge('busy');
    autoRunPending();
  });

  await listen('delegate-to-edit', async (e) => {
    const task = e.payload?.task || e.payload?.briefing;
    if (!task) return;
    lastTask = task;
    log(`📨 Conversador → Edição (${task.length} chars)`, 'info');
    addPipelineEntry('Conversador → Edição', task.slice(0, 200), 'info');
    notifyConversa('pipeline', { stage: 'Conversador → Edição', text: task, status: 'info' });
    try {
      await invoke('open_edit_chat_hidden');
      await waitReadyAndSend('edit-chat',
        'TASK DO CONVERSADOR:\n\n' + task + '\n\n' +
        'EXECUTE. Emita JSON com {"op": "write"/"replace"/"search", ...}. ' +
        'Se > 1500 chars, divida em write + append.'
      );
    } catch (err) { log(`❌ ${err}`, 'error'); }
  });

  await listen('main-retry-correction', async (e) => {
    const fb = e.payload?.feedback;
    if (!fb) return;
    log('🔄 Conversador gerou código — pedindo correção', 'warning');
    try { await waitReadyAndSend('conversador-chat', fb); } catch (err) {}
  });

  await listen('edit-retry-correction', async (e) => {
    const fb = e.payload?.feedback;
    if (!fb) return;
    log('🔄 Edição gerou código — pedindo correção', 'warning');
    try { await waitReadyAndSend('edit-chat', fb); } catch (err) {}
  });
}

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════
async function boot() {
  if (!TAURI) { console.error('__TAURI__ ausente'); return; }
  bindAll();
  await setupListeners();
  renderPending();
  renderPipeline();
  updateStatusBadge('ok');
  await refreshAll();
  log('DeepEdit pronto (2 chats, JSON, preview Live Server, Git)', 'success');
  notifyConversa('ready', {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}