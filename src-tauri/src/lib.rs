use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl};

// ═══════════════════════════════════════════════════════════
// ESTRUTURAS
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FsEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FsResult {
    pub success: bool,
    pub op: String,
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<FsEntry>>,
}

// Estado global: workspace customizável
pub struct WorkspaceState(pub Mutex<Option<PathBuf>>);

// ═══════════════════════════════════════════════════════════
// WORKSPACE + SANDBOX
// ═══════════════════════════════════════════════════════════

fn workspace_root(app: &tauri::AppHandle) -> PathBuf {
    if let Some(state) = app.try_state::<WorkspaceState>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(p) = guard.as_ref() {
                return p.clone();
            }
        }
    }
    let docs = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    docs.join("DeepSeekManager").join("workspace")
}

fn ensure_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = workspace_root(app);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Valida path relativo e retorna caminho absoluto dentro do sandbox.
fn safe_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let root = ensure_workspace(app)?;
    let root_canon = fs::canonicalize(&root).map_err(|e| e.to_string())?;

    if Path::new(rel).is_absolute() {
        return Err(format!("Path absoluto não permitido: {}", rel));
    }

    // Remove componentes perigosos
    let cleaned = rel
        .replace('\\', "/")
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");

    if cleaned.is_empty() {
        // Path "." → retorna o próprio root
        return Ok(root_canon);
    }

    let full = root.join(&cleaned);

    if full.exists() {
        let canon = fs::canonicalize(&full).map_err(|e| e.to_string())?;
        if !canon.starts_with(&root_canon) {
            return Err(format!("Fora do workspace: {}", rel));
        }
        return Ok(canon);
    }

    let parent = full.parent().ok_or("Path inválido")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent_canon = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent_canon.starts_with(&root_canon) {
        return Err(format!("Fora do workspace: {}", rel));
    }
    Ok(full)
}

// ═══════════════════════════════════════════════════════════
// COMANDOS DE FILESYSTEM
// ═══════════════════════════════════════════════════════════

#[tauri::command]
async fn fs_read(app: tauri::AppHandle, path: String) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    Ok(FsResult {
        success: true,
        op: "read".into(),
        path,
        message: format!("{} bytes", content.len()),
        content: Some(content),
        entries: None,
    })
}

#[tauri::command]
async fn fs_write(app: tauri::AppHandle, path: String, content: String) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    let existed = full.exists();
    fs::write(&full, &content).map_err(|e| e.to_string())?;
    Ok(FsResult {
        success: true,
        op: if existed { "overwrite".into() } else { "create".into() },
        path,
        message: format!(
            "{} bytes {}",
            content.len(),
            if existed { "sobrescritos" } else { "criados" }
        ),
        content: None,
        entries: None,
    })
}

#[tauri::command]
async fn fs_append(app: tauri::AppHandle, path: String, content: String) -> Result<FsResult, String> {
    use std::io::Write;
    let full = safe_path(&app, &path)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&full)
        .map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(FsResult {
        success: true,
        op: "append".into(),
        path,
        message: format!("{} bytes anexados", content.len()),
        content: None,
        entries: None,
    })
}

#[tauri::command]
async fn fs_edit(
    app: tauri::AppHandle,
    path: String,
    old_string: String,
    new_string: String,
) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let count = content.matches(&old_string).count();
    if count == 0 {
        return Err(format!("Trecho não encontrado em {}", path));
    }
    if count > 1 {
        return Err(format!(
            "Trecho encontrado {} vezes em {} — seja mais específico",
            count, path
        ));
    }
    let new_content = content.replacen(&old_string, &new_string, 1);
    fs::write(&full, &new_content).map_err(|e| e.to_string())?;
    Ok(FsResult {
        success: true,
        op: "edit".into(),
        path,
        message: format!(
            "1 substituição ({} → {} bytes)",
            old_string.len(),
            new_string.len()
        ),
        content: None,
        entries: None,
    })
}

#[tauri::command]
async fn fs_delete(app: tauri::AppHandle, path: String) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    if full.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&full).map_err(|e| e.to_string())?;
    }
    Ok(FsResult {
        success: true,
        op: "delete".into(),
        path,
        message: "removido".into(),
        content: None,
        entries: None,
    })
}

#[tauri::command]
async fn fs_list(app: tauri::AppHandle, path: Option<String>) -> Result<FsResult, String> {
    let rel = path.unwrap_or_else(|| ".".into());
    let full = safe_path(&app, &rel)?;
    let root = ensure_workspace(&app)?;
    let mut entries = Vec::new();
    for e in fs::read_dir(&full).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let rel_p = p
            .strip_prefix(&root)
            .unwrap_or(&p)
            .to_string_lossy()
            .to_string();
        entries.push(FsEntry {
            path: rel_p,
            is_dir: p.is_dir(),
            size,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(FsResult {
        success: true,
        op: "list".into(),
        path: rel,
        message: format!("{} entradas", entries.len()),
        content: None,
        entries: Some(entries),
    })
}

#[tauri::command]
async fn fs_exists(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    Ok(safe_path(&app, &path).map(|p| p.exists()).unwrap_or(false))
}

// ═══════════════════════════════════════════════════════════
// WORKSPACE CONFIGURÁVEL
// ═══════════════════════════════════════════════════════════

#[tauri::command]
async fn set_workspace(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    let canon = fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let state = app.state::<WorkspaceState>();
    *state.0.lock().map_err(|e| e.to_string())? = Some(canon.clone());
    Ok(canon.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_workspace(app: tauri::AppHandle) -> Result<String, String> {
    Ok(workspace_root(&app).to_string_lossy().to_string())
}

// ═══════════════════════════════════════════════════════════
// COOKIES / INJEÇÃO / JANELA
// ═══════════════════════════════════════════════════════════

#[tauri::command]
async fn get_cookies(window: WebviewWindow) -> Result<Vec<String>, String> {
    window
        .cookies()
        .map(|c| c.iter().map(|x| x.to_string()).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn inject_script(window: WebviewWindow, script: String) -> Result<(), String> {
    window.eval(&script).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_deepseek_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("deepseek") {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let _ = WebviewWindowBuilder::new(
        &app,
        "deepseek",
        WebviewUrl::External("https://chat.deepseek.com".parse().unwrap()),
    )
    .title("DeepSeek Chat — Agente de Filesystem")
    .inner_size(1200.0, 900.0)
    .initialization_script(INJECTED_SCRIPT)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════
// SCRIPT INJETADO (roda na webview do DeepSeek)
// ═══════════════════════════════════════════════════════════

const INJECTED_SCRIPT: &str = r#"
(function() {
  // ── Espera __TAURI__ estar disponível (retry até 10s) ──
  function waitForTauri(cb, tries) {
    tries = tries || 0;
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) {
      cb(window.__TAURI__);
    } else if (tries < 100) {
      setTimeout(() => waitForTauri(cb, tries + 1), 100);
    } else {
      console.error('[DSM] __TAURI__ nunca apareceu após 10s');
    }
  }

  // ── Parser de blocos ```tool ──
  function parseToolCalls(text) {
    const re = /```tool\s*\n([\s\S]*?)\n```/g;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      try {
        const p = JSON.parse(raw);
        if (Array.isArray(p)) out.push(...p);
        else out.push(p);
      } catch (e) {
        console.warn('[DSM] JSON inválido em bloco tool:', raw, e);
      }
    }
    return out;
  }

  // ── Obtém texto da mensagem do assistente ──
  function getMessageText(node) {
    // Tenta os seletores conhecidos do DeepSeek
    const md = node.matches?.('.ds-assistant-message-main-content')
      ? node
      : node.querySelector?.('.ds-assistant-message-main-content');
    if (md) return md.innerText || '';

    // Fallback: qualquer .ds-markdown dentro da mensagem
    const anyMd = node.querySelector?.('.ds-markdown');
    if (anyMd) return anyMd.innerText || '';

    // Fallback final: texto bruto
    return node.innerText || '';
  }

  // ── Observa novas mensagens do assistente ──
  function watchAssistant(T) {
    const seen = new WeakSet();

    const process = (root) => {
      if (!(root instanceof HTMLElement)) return;
      // Considera o próprio root e seus descendentes
      const candidates = [];
      if (root.matches?.('.ds-assistant-message-main-content, .ds-markdown')) {
        candidates.push(root);
      }
      root.querySelectorAll?.('.ds-assistant-message-main-content, .ds-markdown').forEach(el => candidates.push(el));

      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);

        const text = getMessageText(el);
        if (!text || text.length < 10) continue;

        const calls = parseToolCalls(text);
        if (calls.length === 0) continue;

        console.log('[DSM] Tool calls detectadas:', calls);
        T.event.emit('tool-calls-detected', calls);
      }
    };

    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          process(node);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[DSM] Observer de tool calls ativo');

    // Processa mensagens já presentes (caso o script rode tarde)
    document.querySelectorAll('.ds-assistant-message-main-content, .ds-markdown').forEach(process);
  }

  // ── Toolbar flutuante ──
  function addToolbar() {
    if (document.getElementById('dsm-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'dsm-bar';
    bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;display:flex;gap:6px;background:#fff;padding:8px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.15);font:12px sans-serif;';
    bar.innerHTML = `
      <button data-c="ls">📂 ls</button>
      <button data-c="read">📖 read</button>
      <button data-c="write">✍️ write</button>
      <button data-c="edit">✏️ edit</button>
      <button data-c="delete">🗑 delete</button>
      <button data-c="list-ws">📁 workspace</button>`;
    bar.querySelectorAll('button').forEach(b => {
      b.style.cssText = 'padding:6px 10px;border:1px solid #ddd;border-radius:6px;background:#fafafa;cursor:pointer;font-size:12px;';
      b.onclick = () => {
        const ta = document.querySelector('textarea');
        if (!ta) return;
        const tpl = {
          ls:        'Liste o workspace:\n```tool\n{"op":"list","path":"."}\n```',
          read:      'Leia este arquivo:\n```tool\n{"op":"read","path":"caminho/arquivo.ext"}\n```',
          write:     'Crie este arquivo:\n```tool\n{"op":"write","path":"caminho/novo.ext","content":"CONTEÚDO AQUI"}\n```',
          edit:      'Edite este trecho:\n```tool\n{"op":"edit","path":"caminho.ext","old":"trecho antigo","new":"trecho novo"}\n```',
          delete:    'Delete:\n```tool\n{"op":"delete","path":"caminho.ext"}\n```',
          'list-ws': 'Liste o workspace inteiro recursivamente.',
        }[b.dataset.c];
        ta.value = tpl;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      };
    });
    document.body.appendChild(bar);
  }

  // ── Boot ──
  function boot() {
    addToolbar();
    waitForTauri((T) => {
      watchAssistant(T);
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot)
    : boot();
})();
"#;

// ═══════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(WorkspaceState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            // Filesystem
            fs_read, fs_write, fs_append, fs_edit, fs_delete, fs_list, fs_exists,
            // Workspace
            set_workspace, get_workspace,
            // DeepSeek
            get_cookies, inject_script, open_deepseek_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}