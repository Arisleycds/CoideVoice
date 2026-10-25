const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { getTree } from './replace.js';

let currentContext = [];
const el = {
  tokenCount: document.getElementById('token-count'),
  logOutput: document.getElementById('log-output'),
  contextDisplay: document.getElementById('context-display'),
  fileList: document.getElementById('file-list'),
  loginStatus: document.getElementById('login-status'),
  cookieInput: document.getElementById('cookie-input'),
  tokenLimit: document.getElementById('token-limit'),
};

function log(m, t = 'info') {
  const d = document.createElement('div');
  d.className = `log-entry log-${t}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${m}`;
  el.logOutput.appendChild(d);
  el.logOutput.scrollTop = el.logOutput.scrollHeight;
}
const est = t => Math.ceil(t.length / 4);

document.getElementById('btn-open-deepseek').onclick = async () => {
  try { await invoke('open_deepseek_window'); log('DeepSeek aberto', 'success'); }
  catch (e) { log(`Erro: ${e}`, 'error'); }
};

document.getElementById('btn-manage-context').onclick = () =>
  document.getElementById('context-panel').scrollIntoView({ behavior: 'smooth' });
document.getElementById('btn-manage-cookies').onclick = () =>
  document.getElementById('cookies-panel').scrollIntoView({ behavior: 'smooth' });

document.getElementById('btn-file-operations').onclick = async () => {
  document.getElementById('files-panel').scrollIntoView({ behavior: 'smooth' });
  try {
    const t = await getTree(3);
    el.fileList.innerHTML = `<pre class="tree-view">${t || '(vazio)'}</pre>`;
  } catch (e) { log(`Erro: ${e}`, 'error'); }
};

document.getElementById('btn-compress-context').onclick = () => {
  const lim = parseInt(el.tokenLimit.value) || 4000;
  let tot = 0, out = [];
  for (const m of currentContext) {
    const t = est(m.content);
    if (tot + t <= lim) { out.push(m); tot += t; }
    else { const r = lim - tot; if (r > 50) out.push({ ...m, content: m.content.slice(0, r*4) + '…' }); break; }
  }
  currentContext = out;
  el.contextDisplay.innerHTML = out.map(m => `<div class="context-message"><b>${m.role||'user'}:</b> ${m.content.slice(0,200)}</div>`).join('') || '<p class="placeholder">Vazio.</p>';
  el.tokenCount.textContent = tot;
  log(`Comprimido: ${tot} tokens`, 'success');
};
document.getElementById('btn-clear-context-panel').onclick = () => {
  currentContext = []; el.contextDisplay.innerHTML = '<p class="placeholder">Vazio.</p>';
  el.tokenCount.textContent = 0;
};

document.getElementById('btn-create-file').onclick = async () => {
  const p = prompt('Caminho:'); if (!p) return;
  try { const r = await invoke('cmd_write', { path: p, content: '' }); log(r.message, 'success'); }
  catch (e) { log(`${e}`, 'error'); }
};
document.getElementById('btn-edit-file').onclick = async () => {
  const p = prompt('Caminho:'); if (!p) return;
  const c = prompt('Conteúdo:'); if (c === null) return;
  try { const r = await invoke('cmd_write', { path: p, content: c }); log(r.message, 'success'); }
  catch (e) { log(`${e}`, 'error'); }
};
document.getElementById('btn-delete-file').onclick = async () => {
  const p = prompt('Caminho:'); if (!p) return;
  try { const r = await invoke('cmd_delete', { path: p }); log(r.message, 'success'); }
  catch (e) { log(`${e}`, 'error'); }
};

document.getElementById('btn-export-cookies').onclick = async () => {
  try { const c = await invoke('get_cookies'); el.cookieInput.value = JSON.stringify(c, null, 2); log(`Cookies: ${c.length}`, 'success'); }
  catch (e) { log(`${e}`, 'error'); }
};
document.getElementById('btn-import-cookies').onclick = async () => {
  try { await invoke('plugin:store|set', { key: 'dsm', value: JSON.parse(el.cookieInput.value) }); log('Salvos', 'success'); }
  catch (e) { log(`${e}`, 'error'); }
};
document.getElementById('btn-check-login').onclick = async () => {
  try {
    const c = await invoke('get_cookies');
    const ok = c.some(x => /session|token/.test(x));
    el.loginStatus.textContent = ok ? '✅ Logado' : '❌ Não';
    el.loginStatus.className = ok ? 'status-success' : 'status-error';
  } catch (e) { log(`${e}`, 'error'); }
};

listen('command-executed', e => {
  log(`✅ ${e.payload.command} "${e.payload.path}"`, 'success');
  if (e.payload.tokens_saved) log(`💰 ${e.payload.tokens_saved} tokens economizados`, 'info');
});
listen('command-error', e => log(`❌ @${e.payload.cmd}: ${e.payload.error}`, 'error'));

log('DeepSeek Manager iniciado', 'success');
