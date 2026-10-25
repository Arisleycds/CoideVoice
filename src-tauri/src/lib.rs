use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileOpResult {
    pub success: bool, pub command: String, pub path: String, pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub signatures: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tokens_estimate: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tokens_saved: Option<usize>,
}

fn get_workspace_root(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("workspace")
}

fn validate_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let root = get_workspace_root(app);
    let _ = fs::create_dir_all(&root);
    let cleaned = rel.replace("..", "").replace("\\", "/").trim_start_matches('/').to_string();
    let full = root.join(&cleaned);
    let cr = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if full.exists() {
        let c = fs::canonicalize(&full).map_err(|e| e.to_string())?;
        if !c.starts_with(&cr) { return Err(format!("Fora do workspace: {}", rel)); }
        Ok(c)
    } else {
        fs::create_dir_all(full.parent().ok_or("Inválido")?).map_err(|e| e.to_string())?;
        Ok(full)
    }
}

fn extract_sigs(content: &str) -> Vec<String> {
    let p = ["function ","const ","let ","var ","class ","export ","async function ","pub fn ","fn ","impl ","def "];
    content.lines().map(|l| l.trim()).filter(|t|
        !t.is_empty() && !t.starts_with("//") && !t.starts_with('#') && p.iter().any(|x| t.starts_with(x))
    ).map(|t| if t.len() > 120 { format!("{}...", &t[..120]) } else { t.to_string() }).collect()
}

fn est(s: &str) -> usize { (s.len() / 4).max(1) }

#[tauri::command]
async fn cmd_read(app: tauri::AppHandle, path: String, mode: Option<String>) -> Result<FileOpResult, String> {
    let full = validate_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let total = est(&content);
    let m = mode.unwrap_or_else(|| "auto".into());
    let use_sig = m == "signature" || (m == "auto" && total > 4000);
    if use_sig {
        let sigs = extract_sigs(&content);
        let st = sigs.join("\n");
        let stk = est(&st);
        Ok(FileOpResult { success: true, command: "@read".into(), path,
            message: format!("Grande ({} tokens). Assinatura ({} itens).", total, sigs.len()),
            content: Some(st), signatures: Some(sigs), tokens_estimate: Some(stk),
            tokens_saved: Some(total.saturating_sub(stk)) })
    } else {
        Ok(FileOpResult { success: true, command: "@read".into(), path,
            message: format!("Lido ({} tokens).", total), content: Some(content),
            signatures: None, tokens_estimate: Some(total), tokens_saved: None })
    }
}

#[tauri::command]
async fn cmd_write(app: tauri::AppHandle, path: String, content: String) -> Result<FileOpResult, String> {
    let full = validate_path(&app, &path)?;
    let new = !full.exists();
    fs::write(&full, &content).map_err(|e| e.to_string())?;
    Ok(FileOpResult { success: true,
        command: if new { "@write (novo)".into() } else { "@write (sobrescrito)".into() },
        path, message: format!("{} ({}b).", if new { "Criado" } else { "Sobrescrito" }, content.len()),
        content: None, signatures: None, tokens_estimate: Some(est(&content)), tokens_saved: None })
}

#[tauri::command]
async fn cmd_edit(app: tauri::AppHandle, path: String, old_string: String, new_string: String) -> Result<FileOpResult, String> {
    let full = validate_path(&app, &path)?;
    let c = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    if !c.contains(&old_string) { return Err(format!("Não encontrado: {}", path)); }
    let n = c.matches(&old_string).count();
    if n > 1 { return Err(format!("{} ocorrências; mais específico.", n)); }
    let nc = c.replacen(&old_string, &new_string, 1);
    fs::write(&full, &nc).map_err(|e| e.to_string())?;
    Ok(FileOpResult { success: true, command: "@edit".into(), path, message: "Editado.".into(),
        content: None, signatures: None, tokens_estimate: Some(est(&nc)),
        tokens_saved: Some(est(&c).saturating_sub(est(&nc))) })
}

#[tauri::command]
async fn cmd_delete(app: tauri::AppHandle, path: String) -> Result<FileOpResult, String> {
    let full = validate_path(&app, &path)?;
    if full.is_dir() { fs::remove_dir_all(&full).map_err(|e| e.to_string())?; }
    else { fs::remove_file(&full).map_err(|e| e.to_string())?; }
    Ok(FileOpResult { success: true, command: "@delete".into(), path, message: "Removido.".into(),
        content: None, signatures: None, tokens_estimate: None, tokens_saved: None })
}

#[tauri::command]
async fn cmd_tree(app: tauri::AppHandle, max_depth: Option<usize>) -> Result<String, String> {
    let root = get_workspace_root(&app);
    let _ = fs::create_dir_all(&root);
    let max = max_depth.unwrap_or(3);
    fn walk(d: &Path, dep: usize, m: usize, o: &mut String) {
        if dep > m { return; }
        let Ok(e) = fs::read_dir(d) else { return };
        let mut v: Vec<_> = e.flatten().collect();
        v.sort_by_key(|x| x.path());
        for en in v {
            let p = en.path();
            let n = p.file_name().unwrap_or_default().to_string_lossy();
            if n.starts_with('.') || n == "node_modules" || n == "target" { continue; }
            let i = "  ".repeat(dep);
            if p.is_dir() { o.push_str(&format!("{}{}/\n", i, n)); walk(&p, dep+1, m, o); }
            else { o.push_str(&format!("{}{} ({}b)\n", i, n, en.metadata().map(|x| x.len()).unwrap_or(0))); }
        }
    }
    let mut o = String::new();
    walk(&root, 0, max, &mut o);
    Ok(o)
}

#[tauri::command]
async fn get_cookies(window: WebviewWindow) -> Result<Vec<String>, String> {
    window.cookies().map(|c| c.iter().map(|x| x.to_string()).collect()).map_err(|e| e.to_string())
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
    let _ = WebviewWindowBuilder::new(&app, "deepseek",
        WebviewUrl::External("https://chat.deepseek.com".parse().unwrap()))
        .title("DeepSeek Chat — @commands")
        .inner_size(1200.0, 900.0)
        .initialization_script(INJECTED_SCRIPT)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

const INJECTED_SCRIPT: &str = r#"
(function() {
  const T = window.__TAURI__;
  if (!T) { console.warn('[DSM] __TAURI__ ausente'); return; }
  const RE = /@(read|write|edit|delete|tree)\s+(?:"([^"]+)"|'([^']+)')(?:\s+```(?:\w+)?\n([\s\S]*?)```)?/g;

  function hook() {
    document.querySelectorAll('button[type="submit"], button[aria-label*="end"]').forEach(b => {
      if (b.dataset.dsm) return;
      b.dataset.dsm = '1';
      b.addEventListener('click', async e => {
        const ta = document.querySelector('textarea');
        if (!ta || !/@(read|write|edit|delete|tree)/.test(ta.value)) return;
        e.preventDefault(); e.stopPropagation();
        await exec(ta.value, ta);
      }, true);
    });
  }

  async function exec(text, ta) {
    const m = [...text.matchAll(RE)][0];
    if (!m) return;
    const [, cmd, p1, p2, block] = m;
    const path = p1 || p2;
    try {
      let r;
      if (cmd === 'read') r = await T.core.invoke('cmd_read', { path, mode: 'auto' });
      else if (cmd === 'write') r = await T.core.invoke('cmd_write', { path, content: block || '' });
      else if (cmd === 'edit') {
        const p = (block || '').split('->');
        if (p.length !== 2) throw new Error('@edit requer ```a``` -> ```b```');
        r = await T.core.invoke('cmd_edit', { path, oldString: p[0].trim(), newString: p[1].trim() });
      }
      else if (cmd === 'delete') r = await T.core.invoke('cmd_delete', { path });
      else if (cmd === 'tree') {
        const t = await T.core.invoke('cmd_tree', { maxDepth: 3 });
        r = { success: true, command: '@tree', path: '.', message: 'Estrutura:', content: t };
      }
      ta.value = format(r);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      T.event.emit('command-executed', r);
    } catch (err) {
      ta.value = `⚠️ @${cmd} "${path}": ${err}`;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      T.event.emit('command-error', { cmd, path, error: String(err) });
    }
  }

  function format(r) {
    const o = [`✅ ${r.command} "${r.path}"`, r.message];
    if (r.tokens_estimate) o.push(`📊 ~${r.tokens_estimate} tokens`);
    if (r.tokens_saved) o.push(`💰 ${r.tokens_saved} tokens economizados`);
    if (r.content) o.push('', '```', r.content, '```');
    return o.join('\n');
  }

  function bar() {
    if (document.getElementById('dsm-bar')) return;
    const b = document.createElement('div');
    b.id = 'dsm-bar';
    b.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;display:flex;gap:6px;background:#fff;padding:8px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.15);font:12px sans-serif;';
    b.innerHTML = `
      <button data-c="tree">🌳</button><button data-c="read">📖</button>
      <button data-c="write">✍️</button><button data-c="edit">✏️</button>
      <button data-c="delete">🗑️</button>`;
    b.querySelectorAll('button').forEach(x => {
      x.style.cssText = 'padding:6px 10px;border:1px solid #ddd;border-radius:6px;background:#fafafa;cursor:pointer;';
      x.onclick = () => {
        const ta = document.querySelector('textarea');
        if (!ta) return;
        const t = { tree:'@tree', read:'@read "arq.ext"', write:'@write "novo.ext"\n```\nconteúdo\n```',
          edit:'@edit "arq.ext"\n```velho``` -> ```novo```', delete:'@delete "arq.ext"' }[x.dataset.c];
        ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
      };
    });
    document.body.appendChild(b);
  }

  function boot() { bar(); hook(); new MutationObserver(hook).observe(document.body, { childList: true, subtree: true }); }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_cookies, inject_script, open_deepseek_window,
            cmd_read, cmd_write, cmd_edit, cmd_delete, cmd_tree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
