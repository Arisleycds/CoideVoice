// src/conversa.js — Painel de Conversa do DeepEdit (2 chats)
const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;
const listen = TAURI?.event?.listen;

const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input');
const btnSend = document.getElementById('btnSend');
const statusEl = document.getElementById('status');
const typingEl = document.getElementById('typing');
const connBadge = document.getElementById('conn-badge');

let busy = false;
let chatReady = false;

function setStatus(txt, cls = '') {
  statusEl.textContent = txt;
  statusEl.className = cls;
}

function setConnection(online) {
  connBadge.textContent = online ? 'online' : 'offline';
  connBadge.className = 'badge' + (online ? ' active' : '');
}

function timestamp() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function addMsg(role, text, meta) {
  const d = document.createElement('div');
  d.className = `msg msg-${role}`;
  d.textContent = text;
  if (meta) {
    const m = document.createElement('span');
    m.className = 'msg-meta';
    m.textContent = meta;
    d.appendChild(m);
  }
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}

function addSystem(text, cls = '') {
  const d = document.createElement('div');
  d.className = `msg msg-system ${cls}`;
  d.textContent = text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}

function setTyping(text) { typingEl.textContent = text || ''; }

// ── Enviar mensagem ao Conversador ──
async function enviar() {
  const txt = inputEl.value.trim();
  if (!txt || busy) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';

  addMsg('user', txt, timestamp());
  busy = true;
  btnSend.disabled = true;
  setTyping('Conversador está pensando...');
  setStatus('Aguardando conversador', 'busy');

  try {
    await invoke('open_conversador_chat');

    // Espera o conversador confirmar "pronto" (até 20s)
    let waited = 0;
    while (!chatReady && waited < 20000) {
      await new Promise(r => setTimeout(r, 300));
      waited += 300;
    }
    if (!chatReady) {
      addSystem('Conversador não confirmou pronto em 20s. Enviando mesmo assim...', 'warn');
    }

    await invoke('send_to_chat', {
      windowLabel: 'conversador-chat',
      message: txt
    });
    setTyping('');
  } catch (e) {
    addSystem('Erro ao enviar: ' + e, 'error');
    setTyping('');
    busy = false;
    btnSend.disabled = false;
    setStatus('Erro', 'error');
  }
}

btnSend.addEventListener('click', enviar);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    enviar();
  }
  if (e.key === 'Escape') {
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(140, inputEl.scrollHeight) + 'px';
});

// ── Callback chamado pelo main.js via inject_script_into ──
window.__onDeepEditEvent = function(kind, payload) {
  console.log('[conversa] evento:', kind, payload);

  switch (kind) {
    case 'ready':
      setConnection(true);
      setStatus('Pronto', 'ok');
      break;

    case 'main-response': {
      const text = payload.text || '';
      addMsg('main', text, timestamp());
      busy = false;
      btnSend.disabled = false;
      setTyping('');
      setStatus('Pronto', 'ok');
      break;
    }

    case 'edit-response': {
      const text = (payload.text || '').slice(0, 500);
      addMsg('edit', '⚙️ Edição: ' + text);
      break;
    }

    case 'pipeline': {
      const stage = payload.stage || '';
      const text = (payload.text || '').slice(0, 300);
      const status = payload.status || 'info';
      let cls = '';
      if (status === 'success') cls = 'ok';
      else if (status === 'error') cls = 'error';
      else if (status === 'warning') cls = 'warn';
      addSystem(`→ ${stage}: ${text}`, cls);
      break;
    }

    case 'reading': {
      const d = document.createElement('div');
      d.className = 'msg msg-system';
      d.id = 'reading-indicator';
      d.textContent = '📖 Lendo ' + (payload.path || 'arquivo') + '...';
      chatEl.appendChild(d);
      chatEl.scrollTop = chatEl.scrollHeight;
      break;
    }

    case 'read-done': {
      const ind = document.getElementById('reading-indicator');
      if (ind) {
        ind.textContent = '📖 ' + payload.path + ' lido (' + payload.size + ')';
        ind.className = 'msg msg-system ok';
        setTimeout(() => { if (ind.parentNode) ind.remove(); }, 3000);
      }
      break;
    }

    case 'read-error': {
      const ind = document.getElementById('reading-indicator');
      if (ind) {
        ind.textContent = '❌ Erro ao ler ' + payload.path;
        ind.className = 'msg msg-system error';
        setTimeout(() => { if (ind.parentNode) ind.remove(); }, 5000);
      }
      break;
    }

    case 'auto-fix': {
      addSystem(`🔧 Auto-correção: reenviando ${payload.count} operação(ões)`, 'warn');
      break;
    }

    case 'edit-done': {
      addSystem('✅ ' + (payload.resumo || 'Operações concluídas'), 'ok');
      busy = false;
      btnSend.disabled = false;
      setTyping('');
      setStatus('Pronto', 'ok');
      break;
    }

    case 'edit-error': {
      addSystem(`⚠️ ${payload.falhas} falha(s):\n${payload.detalhes || ''}`, 'error');
      busy = false;
      btnSend.disabled = false;
      setTyping('');
      setStatus('Erro', 'error');
      break;
    }

    default:
      console.log('[conversa] evento desconhecido:', kind, payload);
  }
};

// ── Listeners de readiness e respostas ──
(async function setup() {
  if (!listen) {
    console.error('[conversa] __TAURI__.event.listen indisponível');
    setConnection(false);
    return;
  }

  try {
    await listen('main-ready', () => {
      chatReady = true;
      setStatus('Conversador pronto', 'ok');
      addSystem('Conversador conectado.', 'ok');
    });

    await listen('edit-ready', () => {
      addSystem('Edição conectada.', '');
    });

    setConnection(true);
    console.log('[conversa] Listeners registrados');
  } catch (e) {
    console.error('[conversa] Erro ao registrar listeners:', e);
    setConnection(false);
  }
})();

// ── Mensagem inicial ──
addSystem(
  'Bem-vindo ao DeepEdit.\n\n' +
  'Como funciona:\n' +
  '• Você fala aqui → o Conversador decide e especifica\n' +
  '• A Edição implementa automaticamente\n' +
  '• Se algo falhar, o Conversador recebe o erro e decide\n\n' +
  'Digite o que você quer criar.',
  'ok'
);

setTimeout(() => inputEl.focus(), 300);