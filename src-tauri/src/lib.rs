use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/* ============================================================
   TIPOS
   ============================================================ */
#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct ProjectFile {
    path: String,
    content: String,
    size: u64,
}

#[derive(Serialize)]
struct RepoOutline {
    file: String,
    lang: String,
    lines: u64,
    symbols: Vec<Symbol>,
}

#[derive(Serialize)]
struct Symbol {
    kind: String,
    name: String,
    line: u32,
    signature: String,
}

/* ============================================================
   CONSTANTES
   ============================================================ */
const IGNORED_DIR_NAMES: &[&str] = &[
    "node_modules", "target", ".git", ".svn", ".hg",
    "dist", "build", ".vite", ".next", ".nuxt",
    "__pycache__", ".cache", ".cargo", ".rustup",
    "coverage", ".nyc_output",
];

const IGNORED_FILE_NAMES: &[&str] = &[
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", ".DS_Store", "Thumbs.db",
];

/* ============================================================
   FILESYSTEM
   ============================================================ */
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| format!("write {}: {}", path, e))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("list {}: {}", path, e))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    if PathBuf::from(&path).exists() { return Err("Arquivo já existe".into()); }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() { fs::remove_dir_all(&p).map_err(|e| e.to_string()) }
    else { fs::remove_file(&p).map_err(|e| e.to_string()) }
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/* ============================================================
   HELPERS DE PROJETO
   ============================================================ */
fn is_binary_content(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8000)];
    sample.iter().any(|&b| b == 0)
}

fn walk_project(
    dir: &std::path::Path,
    root: &std::path::Path,
    out: &mut Vec<ProjectFile>,
    total: &mut u64,
    max_file_size: u64,
    max_total: u64,
) {
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED_DIR_NAMES.contains(&name.as_str()) { continue; }
        if IGNORED_FILE_NAMES.contains(&name.as_str()) { continue; }
        if name.starts_with('.') && name != ".env.example" { continue; }
        if *total >= max_total { return; }

        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let path = entry.path();

        if meta.is_dir() {
            walk_project(&path, root, out, total, max_file_size, max_total);
        } else if meta.is_file() {
            if meta.len() > max_file_size { continue; }
            if let Ok(bytes) = fs::read(&path) {
                if is_binary_content(&bytes) { continue; }
                if let Ok(content) = String::from_utf8(bytes) {
                    let rel = path
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default()
                        .replace('\\', "/");
                    *total += meta.len();
                    out.push(ProjectFile { path: rel, content, size: meta.len() });
                }
            }
        }
    }
}

#[tauri::command]
fn read_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() { return Err(format!("{} não é uma pasta", root)); }
    let mut out = Vec::new();
    let mut total = 0u64;
    walk_project(&root_path, &root_path, &mut out, &mut total, 512 * 1024, 2 * 1024 * 1024);
    out.sort_by(|a, b| {
        let score = |p: &str| -> u32 {
            let p = p.to_lowercase();
            if p.contains("readme") { 0 }
            else if p.ends_with("package.json") { 1 }
            else if p.ends_with("cargo.toml") { 2 }
            else if p.contains("src/") && !p.contains("src-tauri") { 3 }
            else if p.contains("src-tauri/src/") { 4 }
            else if p.ends_with(".rs") { 5 }
            else if p.ends_with(".js") || p.ends_with(".ts") { 6 }
            else if p.ends_with(".html") { 7 }
            else if p.ends_with(".css") { 8 }
            else { 100 }
        };
        score(&a.path).cmp(&score(&b.path)).then_with(|| a.path.cmp(&b.path))
    });
    Ok(out)
}

/* ============================================================
   REPO MAP
   ============================================================ */
fn detect_lang(path: &str) -> &'static str {
    let p = path.to_lowercase();
    if p.ends_with(".rs") { "rust" }
    else if p.ends_with(".ts") || p.ends_with(".tsx") { "ts" }
    else if p.ends_with(".js") || p.ends_with(".jsx") || p.ends_with(".mjs") { "js" }
    else if p.ends_with(".html") || p.ends_with(".htm") { "html" }
    else if p.ends_with(".css") { "css" }
    else if p.ends_with(".json") { "json" }
    else if p.ends_with(".toml") { "toml" }
    else if p.ends_with(".md") { "md" }
    else if p.ends_with(".py") { "py" }
    else if p.ends_with(".go") { "go" }
    else { "txt" }
}

fn extract_symbols(content: &str, lang: &str) -> Vec<Symbol> {
    let mut out = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    for (i, raw) in lines.iter().enumerate() {
        let line = raw.trim_start();
        let indent = raw.len() - line.len();
        if indent > 4 && lang != "css" { continue; }
        if line.is_empty() || line.starts_with("//") || line.starts_with('#')
           || line.starts_with("/*") || line.starts_with('*') { continue; }
        let lineno = (i + 1) as u32;
        let sig: String = raw.chars().take(120).collect();
        match lang {
            "rust" => {
                if line.starts_with("pub fn ") || line.starts_with("fn ") {
                    let name = line.split_whitespace().nth(if line.starts_with("pub") { 2 } else { 1 })
                        .unwrap_or("").split('(').next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "fn".into(), name, line: lineno, signature: sig });
                } else if line.starts_with("pub struct ") || line.starts_with("struct ") {
                    let name = line.split_whitespace().nth(if line.starts_with("pub") { 2 } else { 1 })
                        .unwrap_or("").split(&[' ', '{', '('][..]).next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "struct".into(), name, line: lineno, signature: sig });
                } else if line.starts_with("pub enum ") || line.starts_with("enum ") {
                    let name = line.split_whitespace().nth(if line.starts_with("pub") { 2 } else { 1 })
                        .unwrap_or("").split(&[' ', '{'][..]).next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "enum".into(), name, line: lineno, signature: sig });
                } else if line.starts_with("impl ") || line.starts_with("pub impl ") {
                    out.push(Symbol { kind: "impl".into(), name: sig.clone(), line: lineno, signature: sig });
                }
            }
            "js" | "ts" => {
                if line.starts_with("export function ") || line.starts_with("function ")
                   || line.starts_with("export async function ") || line.starts_with("async function ") {
                    let name = line.split("function").nth(1).unwrap_or("")
                        .split_whitespace().next().unwrap_or("").split('(').next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "function".into(), name, line: lineno, signature: sig });
                } else if line.starts_with("export const ") || line.starts_with("const ") {
                    if line.contains("=>") || line.contains("function") || line.contains("(") {
                        let name = line.split("const").nth(1).unwrap_or("")
                            .split_whitespace().next().unwrap_or("").split('=').next().unwrap_or("").trim().to_string();
                        out.push(Symbol { kind: "const".into(), name, line: lineno, signature: sig });
                    }
                } else if line.starts_with("class ") || line.starts_with("export class ") {
                    let name = line.split("class").nth(1).unwrap_or("")
                        .split_whitespace().next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "class".into(), name, line: lineno, signature: sig });
                }
            }
            "py" => {
                if line.starts_with("def ") || line.starts_with("async def ") {
                    let name = line.split("def").nth(1).unwrap_or("")
                        .split_whitespace().next().unwrap_or("").split('(').next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "def".into(), name, line: lineno, signature: sig });
                } else if line.starts_with("class ") {
                    let name = line.split("class").nth(1).unwrap_or("")
                        .split_whitespace().next().unwrap_or("").split(&[':', '('][..]).next().unwrap_or("").to_string();
                    out.push(Symbol { kind: "class".into(), name, line: lineno, signature: sig });
                }
            }
            "html" => {
                if line.contains("<script src=") {
                    let s = line.chars().take(100).collect::<String>();
                    out.push(Symbol { kind: "script-src".into(), name: s.clone(), line: lineno, signature: s });
                } else if line.contains("<link rel=\"stylesheet\"") {
                    let s = line.chars().take(100).collect::<String>();
                    out.push(Symbol { kind: "link".into(), name: s.clone(), line: lineno, signature: s });
                } else if line.starts_with("<title>") {
                    out.push(Symbol { kind: "title".into(), name: line.to_string(), line: lineno, signature: line.to_string() });
                }
            }
            "css" => {
                if line.starts_with('.') && line.ends_with('{') {
                    out.push(Symbol { kind: "class".into(), name: line.trim_end_matches('{').trim().to_string(), line: lineno, signature: sig });
                } else if line.starts_with('@') {
                    out.push(Symbol { kind: "at-rule".into(), name: line.chars().take(40).collect(), line: lineno, signature: sig });
                }
            }
            _ => {}
        }
    }
    out.truncate(40);
    out
}

#[tauri::command]
fn build_repo_map(root: String) -> Result<Vec<RepoOutline>, String> {
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() { return Err(format!("{} não é pasta", root)); }
    let mut file_paths: Vec<std::path::PathBuf> = Vec::new();
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if IGNORED_DIR_NAMES.contains(&name.as_str()) { continue; }
            if IGNORED_FILE_NAMES.contains(&name.as_str()) { continue; }
            if name.starts_with('.') && name != ".env.example" { continue; }
            let path = entry.path();
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { walk(&path, root, out); }
            else if meta.is_file() && meta.len() < 512 * 1024 { out.push(path); }
        }
    }
    walk(&root_path, &root_path, &mut file_paths);
    let mut out: Vec<RepoOutline> = Vec::new();
    for p in file_paths {
        let rel = p.strip_prefix(&root_path)
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default()
            .replace('\\', "/");
        let lang = detect_lang(&rel);
        if lang == "json" || lang == "md" || lang == "txt" {
            if !rel.contains("package.json") && !rel.contains("Cargo.toml")
               && !rel.contains("tauri.conf") && !rel.contains("README") { continue; }
        }
        let content = match fs::read_to_string(&p) { Ok(c) => c, Err(_) => continue };
        if is_binary_content(content.as_bytes()) { continue; }
        let lines = content.lines().count() as u64;
        let symbols = extract_symbols(&content, lang);
        out.push(RepoOutline { file: rel, lang: lang.to_string(), lines, symbols });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

/* ============================================================
   RAIZ DO PROJETO
   ============================================================ */
#[cfg(debug_assertions)]
#[tauri::command]
fn find_project_root() -> Result<String, String> {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..8 {
            let d = match dir { Some(d) => d, None => break };
            let pkg = d.join("package.json");
            if pkg.exists() {
                if let Ok(content) = fs::read_to_string(&pkg) {
                    if content.contains("\"name\": \"dsedit\"") || content.contains("\"name\":\"dsedit\"") {
                        return Ok(d.to_string_lossy().to_string());
                    }
                }
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let pkg = cwd.join("package.json");
        if pkg.exists() {
            if let Ok(content) = fs::read_to_string(&pkg) {
                if content.contains("\"name\": \"dsedit\"") || content.contains("\"name\":\"dsedit\"") {
                    return Ok(cwd.to_string_lossy().to_string());
                }
            }
        }
    }
    Err("projeto DSedit não encontrado".into())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
fn find_project_root() -> Result<String, String> {
    Err("self desabilitado nesta build".into())
}

#[tauri::command]
fn is_self_available() -> bool {
    cfg!(debug_assertions)
}

/* ============================================================
   PIN DA SESSÃO
   ============================================================ */
#[tauri::command]
fn save_pin(root: String, content: String) -> Result<String, String> {
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() { return Err(format!("{} não é pasta", root)); }
    let pin_dir = root_path.join(".dsedit");
    fs::create_dir_all(&pin_dir).map_err(|e| format!("mkdir .dsedit: {}", e))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let path = pin_dir.join(format!("pin-{}.md", stamp));
    fs::write(&path, &content).map_err(|e| format!("write pin: {}", e))?;
    let latest = pin_dir.join("pin-latest.md");
    let _ = fs::write(&latest, &content);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_pin(root: String) -> Result<String, String> {
    let latest = std::path::PathBuf::from(&root).join(".dsedit").join("pin-latest.md");
    if !latest.exists() { return Err("Nenhum pin encontrado".into()); }
    fs::read_to_string(&latest).map_err(|e| format!("read pin: {}", e))
}

#[tauri::command]
fn list_pins(root: String) -> Result<Vec<String>, String> {
    let pin_dir = std::path::PathBuf::from(&root).join(".dsedit");
    if !pin_dir.is_dir() { return Ok(Vec::new()); }
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&pin_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("pin-") && name.ends_with(".md") && name != "pin-latest.md" {
                out.push(name);
            }
        }
    }
    out.sort(); out.reverse();
    Ok(out)
}

/* ============================================================
   EXTRAIR CONVERSA DO CHAT
   ============================================================ */
#[tauri::command]
async fn grab_conversation(app: tauri::AppHandle) -> Result<String, String> {
    let wv = app.get_webview_window("deepseek").ok_or("Janela do DeepSeek não está aberta")?;
    let script = r#"(function(){ try { var messages=[]; var seen=new WeakSet(); var selectors=['[class*="message"]','[class*="Message"]','[class*="markdown"]','.ds-markdown','[data-message-author-role]']; var nodes=[]; for(var i=0;i<selectors.length;i++){var found=document.querySelectorAll(selectors[i]); for(var j=0;j<found.length;j++){if(!seen.has(found[j])){seen.add(found[j]);nodes.push(found[j]);}}} nodes.sort(function(a,b){return a.getBoundingClientRect().top-b.getBoundingClientRect().top;}); for(var k=0;k<nodes.length;k++){var el=nodes[k]; var text=(el.innerText||el.textContent||'').trim(); if(!text||text.length<5)continue; var role='unknown'; var cls=(el.className||'').toString().toLowerCase(); var parent=el.closest('[data-message-author-role]'); if(parent)role=parent.getAttribute('data-message-author-role'); else if(cls.indexOf('user')!==-1)role='user'; else if(cls.indexOf('assistant')!==-1||cls.indexOf('bot')!==-1)role='assistant'; messages.push({role:role,text:text,len:text.length});} var filtered=[]; for(var m=0;m<messages.length;m++){var isDup=false; for(var n=0;n<messages.length;n++){if(m===n)continue; if(messages[n].text.indexOf(messages[m].text)!==-1&&messages[n].len>messages[m].len){isDup=true;break;}} if(!isDup)filtered.push(messages[m]);} return JSON.stringify({ok:true,count:filtered.length,messages:filtered});} catch(e){return JSON.stringify({ok:false,error:String(e)});}})();"#;
    let _ = wv.eval(&format!(
        "var __dsedit_conv = {}; if (__dsedit_conv) {{ try {{ navigator.clipboard.writeText(__dsedit_conv); }} catch(e) {{}} }}",
        script
    ));
    std::thread::sleep(std::time::Duration::from_millis(400));
    Ok("extração disparada".into())
}

/* ============================================================
   TERMINAL (PTY)
   ============================================================ */
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

#[tauri::command]
fn spawn_shell(
    app: tauri::AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.remove(&id);
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {}", e))?;
    let shell = if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    };
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(c) = cwd { cmd.cwd(c); }
    cmd.env("TERM", "xterm-256color");
    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {}", e))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {}", e))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {}", e))?;
    let id_for_thread = id.clone();
    let id_for_exit   = id.clone();
    let app2 = app.clone();
    let ev_id = format!("pty-output-{}", id_for_thread);
    let ev_exit = format!("pty-exit-{}", id_for_exit);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app2.emit(&ev_id, chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit(&ev_exit, ());
    });
    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(id, PtySession { writer, master: pair.master });
    Ok(())
}

#[tauri::command]
fn write_to_shell(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("shell não encontrada")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_shell(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("shell não encontrada")?;
    s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn kill_shell(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    sessions.remove(&id);
    Ok(())
}

/* ============================================================
   DSEDIT INJETOR
   ============================================================ */
const DSEDIT_INJECT_SCRIPT: &str = r#"
(function(){
  try { if (window.top !== window.self) return; } catch(e){ return; }
  if (window.__DSEDIT_INJECTED__) return;
  window.__DSEDIT_INJECTED__ = true;

  function isChatDomain(){
    try { return location.hostname.endsWith('deepseek.com'); } catch(e){ return false; }
  }
  function hasChatInput(){
    return !!document.querySelector(
      'textarea[placeholder*="Message"],textarea[placeholder*="mensagem"],' +
      'textarea[placeholder*="DeepSeek"],textarea[placeholder*="Enviar"],' +
      'textarea[name="search"],textarea[rows="2"]'
    );
  }
  function hasChatHistory(){
    return document.querySelectorAll('.ds-markdown').length > 0
        || document.querySelectorAll('[class*="message"]').length > 1;
  }
  function isChatReady(){
    if (!isChatDomain()) return false;
    return hasChatInput() || hasChatHistory();
  }

  const seen = new Set();
  window.__dsedit_latest  = '';
  window.__dsedit_active  = false;

  function hash(s){
    let h = 2166136261;
    for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }
  function forceCopy(text){
    if (!window.__dsedit_active) return false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.left = '-9999px';
      ta.setAttribute('readonly','');
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch(e){ return false; }
  }
  function send(block){
    if (!window.__dsedit_active) return;
    const id = hash(block);
    if (seen.has(id)) return;
    seen.add(id);
    window.__dsedit_latest = block;
    console.log('[DSedit] bloco detectado (' + block.length + ' chars)');
    const copied = forceCopy(block);
    console.log('[DSedit] forceCopy =', copied);
    try {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        window.__TAURI_INTERNALS__.invoke('dsedit_received', { payload: block })
          .then(function(){ console.log('[DSedit] IPC ok'); })
          .catch(function(e){ console.warn('[DSedit] IPC falhou:', e); });
      }
    } catch(e){}
  }
  function scan(){
    if (!window.__dsedit_active) return;
    document.querySelectorAll('pre').forEach(function(p){
      const txt = p.textContent || '';
      if (txt.indexOf('##DSEDIT') === -1 && txt.indexOf('##READ') === -1) return;
      if (txt.length < 15) return;
      send(txt);
    });
    if (window.__dsedit_latest.indexOf('##READ') === -1) {
      const allText = document.body.textContent || '';
      const idx = allText.indexOf('##READ');
      if (idx !== -1) {
        const chunk = allText.slice(idx, idx + 2000);
        const lines = chunk.split('\n');
        const out = [];
        for (let i = 0; i < lines.length && i < 20; i++) {
          const t = lines[i].trim();
          if (i > 0 && !t.startsWith('@file') && t !== '##READ' && t !== '') break;
          out.push(lines[i]);
        }
        const readBlock = out.join('\n').trim();
        if (readBlock.indexOf('@file') !== -1) send(readBlock);
      }
    }
  }
  function chatIsClean(){
    try {
      if (document.querySelectorAll('.ds-markdown').length > 0) return false;
      if (document.querySelectorAll('[class*="message"]').length > 3) return false;
      if (document.body.textContent.indexOf('##DSEDIT') !== -1) return false;
      return true;
    } catch(e){ return false; }
  }
  function reportStatus(){
    if (!window.__dsedit_active) return;
    const clean = chatIsClean();
    try {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        window.__TAURI_INTERNALS__.invoke('dsedit_chat_status', { clean }).catch(function(){});
      }
    } catch(e){}
  }

  let observerAttached = false;
  let intervalScan = null, intervalStatus = null;

  function activate(){
    if (window.__dsedit_active) return;
    window.__dsedit_active = true;
    console.log('[DSedit] injetor ativo (chat pronto)');
    if (!observerAttached && document.body){
      observerAttached = true;
      new MutationObserver(function(){
        clearTimeout(window.__dseditTimer);
        window.__dseditTimer = setTimeout(scan, 500);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (!intervalScan)   intervalScan   = setInterval(scan, 4000);
    if (!intervalStatus) intervalStatus = setInterval(reportStatus, 3000);
    setTimeout(scan, 400);
    reportStatus();
  }
  function deactivate(){
    if (!window.__dsedit_active) return;
    window.__dsedit_active = false;
    if (intervalScan){ clearInterval(intervalScan); intervalScan = null; }
    if (intervalStatus){ clearInterval(intervalStatus); intervalStatus = null; }
    console.log('[DSedit] injetor em espera (fora do chat)');
  }
  function checkState(){
    if (isChatReady()) activate(); else deactivate();
  }

  function start(){
    if (!document.body){ setTimeout(start, 200); return; }
    setInterval(checkState, 1500);
    checkState();
    console.log('[DSedit] watcher de login instalado');
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(checkState, 800); });
  } else {
    setTimeout(checkState, 800);
  }

  let lastUrl = location.href;
  setInterval(function(){
    if (location.href !== lastUrl){
      lastUrl = location.href;
      checkState();
    }
  }, 1000);

  start();

  window.__dsedit_scan = function(){
    if (window.__dsedit_active) scan();
    return window.__dsedit_latest || '';
  };
  window.__dsedit_force_copy = function(){
    if (!window.__dsedit_active) return false;
    if (!window.__dsedit_latest) scan();
    if (!window.__dsedit_latest) return false;
    return forceCopy(window.__dsedit_latest);
  };
})();
"#;

/* Script leve que roda na janela de login. Só avisa quando o chat
   logado aparecer — não lê mensagens, não mexe em clipboard. */
const LOGIN_WATCH_SCRIPT: &str = r#"
(function(){
  try { if (window.top !== window.self) return; } catch(e){ return; }
  if (window.__DSEDIT_LOGIN_WATCH__) return;
  window.__DSEDIT_LOGIN_WATCH__ = true;

  function logged(){
    try {
      if (!location.hostname.endsWith('deepseek.com')) return false;
      const ta = document.querySelector(
        'textarea[placeholder*="Message"],textarea[placeholder*="mensagem"],' +
        'textarea[placeholder*="DeepSeek"],textarea[rows="2"]'
      );
      return !!ta;
    } catch(e){ return false; }
  }

  let n = 0;
  const t = setInterval(function(){
    n++;
    if (logged()){
      clearInterval(t);
      try {
        if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
          window.__TAURI_INTERNALS__.invoke('dsedit_login_done').catch(function(){});
        }
      } catch(e){}
    }
    if (n > 1200) clearInterval(t);
  }, 1000);
})();
"#;

#[tauri::command]
fn dsedit_received(app: tauri::AppHandle, payload: String) -> Result<(), String> {
    app.emit_to("main", "dsedit-block", payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn dsedit_chat_status(app: tauri::AppHandle, clean: bool) -> Result<(), String> {
    app.emit_to("main", "chat-status", clean).map_err(|e| e.to_string())
}

/* ============================================================
   CHATGPT INJETOR (só resposta do assistente)
   ============================================================ */
const CHATGPT_INJECT_SCRIPT: &str = r#"
(function(){
  try { if (window.top !== window.self) return; } catch(e){ return; }
  if (window.__CHATGPT_INJECTED__) return;
  window.__CHATGPT_INJECTED__ = true;

  const seen = new Set();
  let lastLen = 0;

  function hash(s){
    let h = 2166136261;
    for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  function isChatGPTHost(){
    try { return location.hostname.endsWith('chatgpt.com') || location.hostname.endsWith('chat.openai.com'); }
    catch(e){ return false; }
  }

  function findAssistantMessages(){
    const out = [];
    document.querySelectorAll('[data-markdown-text-style="assistant-message"]').forEach(function(el){
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.length > 20) out.push({ el: el, text: txt });
    });
    if (out.length === 0) {
      document.querySelectorAll('[data-message-author-role="assistant"]').forEach(function(el){
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.length > 20) out.push({ el: el, text: txt });
      });
    }
    return out;
  }

  function isTurnComplete(el){
    let node = el;
    for (let i = 0; i < 12 && node; i++){
      node = node.parentElement;
      if (!node) break;
      const state = node.getAttribute && node.getAttribute('data-talvt-turn-state');
      if (state === 'complete') return true;
      if (state === 'in_progress') return false;
    }
    return true;
  }

  function send(text){
    const id = hash(text);
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 200) {
      const arr = Array.from(seen);
      for (let i = 0; i < 100; i++) seen.delete(arr[i]);
    }
    console.log('[DSedit/ChatGPT] resposta detectada (' + text.length + ' chars)');
    try {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        window.__TAURI_INTERNALS__.invoke('chatgpt_response_ready', { text: text })
          .then(function(){ console.log('[DSedit/ChatGPT] IPC ok'); })
          .catch(function(e){ console.warn('[DSedit/ChatGPT] IPC falhou:', e); });
      }
    } catch(e){}
  }

  function scan(){
    if (!isChatGPTHost()) return;
    const msgs = findAssistantMessages();
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (!isTurnComplete(last.el)) return;
    if (last.text.length < 20) return;
    if (last.text.length === lastLen && seen.has(hash(last.text))) return;
    lastLen = last.text.length;
    send(last.text);
  }

  function start(){
    if (!document.body){ setTimeout(start, 300); return; }
    new MutationObserver(function(){
      clearTimeout(window.__cgpt_timer);
      window.__cgpt_timer = setTimeout(scan, 900);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(scan, 4000);
    setTimeout(scan, 1500);
    console.log('[DSedit/ChatGPT] injetor de resposta ativo');
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(start, 800); });
  } else {
    setTimeout(start, 800);
  }
})();
"#;

#[tauri::command]
fn chatgpt_response_ready(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.emit_to("main", "chatgpt-response", text).map_err(|e| e.to_string())
}

/* ============================================================
   INJEÇÃO DE COOKIE NATIVO (WebView2)
   ============================================================ */
#[cfg(target_os = "windows")]
fn inject_cookies_webview2(
    pw: &tauri::webview::PlatformWebview,
    cookie_str: &str,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, HSTRING, PCWSTR};

    unsafe {
        let controller = pw.controller();
        let core = controller
            .CoreWebView2()
            .map_err(|e| format!("CoreWebView2: {:?}", e))?;

        let core2: ICoreWebView2_2 = core
            .cast()
            .map_err(|e| format!("cast ICoreWebView2_2: {:?}", e))?;
        let mgr = core2
            .CookieManager()
            .map_err(|e| format!("CookieManager: {:?}", e))?;

        let mut ok = 0usize;
        for pair in cookie_str.split(';') {
            let pair = pair.trim();
            if pair.is_empty() { continue; }
            let (name, value) = match pair.split_once('=') {
                Some((n, v)) => (n.trim(), v.trim()),
                None => continue,
            };
            if name.is_empty() { continue; }

            let name_h   = HSTRING::from(name);
            let value_h  = HSTRING::from(value);
            let domain_h = HSTRING::from(".deepseek.com");
            let path_h   = HSTRING::from("/");

            let cookie = match mgr.CreateCookie(
                PCWSTR(name_h.as_ptr()),
                PCWSTR(value_h.as_ptr()),
                PCWSTR(domain_h.as_ptr()),
                PCWSTR(path_h.as_ptr()),
            ) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let _ = cookie.SetIsHttpOnly(true);
            let _ = cookie.SetIsSecure(true);
            let _ = cookie.SetSameSite(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE);

            if mgr.AddOrUpdateCookie(&cookie).is_ok() { ok += 1; }
        }
        eprintln!("[dsedit] cookies injetados: {}", ok);
    }
    Ok(())
}
/* ============================================================
   ENVIO AO DEEPSEEK
   ============================================================ */
#[tauri::command]
async fn send_to_deepseek(app: tauri::AppHandle, payload: String) -> Result<(), String> {
    let wv = app.get_webview_window("deepseek").ok_or("Janela do DeepSeek não está aberta")?;
    let text_lit = serde_json::to_string(&payload).map_err(|e| format!("json: {}", e))?;
    let js = format!(r#"(function(){{
    const TEXT = {text};
    const MAX_ATTEMPTS = 25, RETRY_DELAY = 350;
    const SELECTORS = ['textarea[placeholder*="DeepSeek"]','textarea[placeholder*="Message"]','textarea[placeholder*="mensagem"]','textarea[name="search"]','textarea[rows="2"]','textarea'];
    function findTextarea() {{
        for (const sel of SELECTORS) {{
            const nodes = document.querySelectorAll(sel);
            for (const el of nodes) {{ if (!el) continue; if (el.offsetParent === null) continue; const r = el.getBoundingClientRect(); if (r.width < 60 || r.height < 12) continue; return el; }}
        }}
        return null;
    }}
    function fillAndSend(ta) {{
        const proto = ta instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(ta, '');
        ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
        setter.call(ta, TEXT);
        ta.dispatchEvent(new Event('input', {{ bubbles: true, cancelable: true }}));
        ta.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));
        ta.focus();
        setTimeout(function() {{
            const r = ta.getBoundingClientRect();
            const c = document.querySelectorAll('button, [role="button"], div[tabindex="0"], svg[role="button"]');
            let best = null, bestScore = -1;
            for (const b of c) {{
                const br = b.getBoundingClientRect();
                if (br.width === 0 || br.height === 0) continue;
                if (br.left < r.right - 100) continue;
                if (br.top > r.bottom + 60) continue;
                if (br.bottom < r.top - 40) continue;
                if (b.disabled) continue;
                const html = (b.innerHTML || '').toLowerCase(), aria = (b.getAttribute('aria-label') || '').toLowerCase(), title = (b.getAttribute('title') || '').toLowerCase(), cls = (b.className || '').toString().toLowerCase();
                let s = 0;
                if (html.includes('send')) s += 5;
                if (html.includes('submit')) s += 3;
                if (html.includes('arrow')) s += 4;
                if (aria.includes('send')) s += 6;
                if (aria.includes('enviar')) s += 6;
                if (title.includes('send')) s += 5;
                if (cls.includes('send')) s += 4;
                if (s > bestScore) {{ bestScore = s; best = b; }}
            }}
            if (best && bestScore > 0) {{ best.click(); return; }}
            const ev = {{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }};
            ta.dispatchEvent(new KeyboardEvent('keydown', ev));
            ta.dispatchEvent(new KeyboardEvent('keypress', ev));
            ta.dispatchEvent(new KeyboardEvent('keyup', ev));
        }}, 220);
    }}
    let attempts = 0;
    function trySend() {{
        attempts++;
        const ta = findTextarea();
        if (!ta) {{ if (attempts < MAX_ATTEMPTS) {{ setTimeout(trySend, RETRY_DELAY); return; }} return; }}
        fillAndSend(ta);
    }}
    setTimeout(trySend, 120);
}})();"#, text = text_lit);
    wv.eval(&js).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn fetch_latest_block(app: tauri::AppHandle) -> Result<String, String> {
    let wv = app.get_webview_window("deepseek").ok_or("Janela do DeepSeek não está aberta")?;
    let _ = wv.eval(
        "try { \
            if (typeof window.__dsedit_scan === 'function') window.__dsedit_scan(); \
            setTimeout(function(){ \
                if (typeof window.__dsedit_force_copy === 'function') { \
                    var ok = window.__dsedit_force_copy(); \
                    console.log('[DSedit] force_copy retornou', ok); \
                } \
            }, 200); \
        } catch(e) { console.error('[DSedit] eval erro:', e); }"
    );
    Ok("scan disparado".into())
}

/* ------------------------------------------------------------
   JANELA DE LOGIN (sem injetor pesado)
   ------------------------------------------------------------ */
#[tauri::command]
async fn open_deepseek_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("deepseek-login") {
        let _ = w.set_focus();
        return Ok(());
    }
    let url: tauri::Url = "https://chat.deepseek.com"
        .parse()
        .map_err(|_| "URL inválida".to_string())?;

    let mut builder = WebviewWindowBuilder::new(&app, "deepseek-login", WebviewUrl::External(url))
        .title("Login DeepSeek")
        .inner_size(700.0, 900.0)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
               .initialization_script(LOGIN_WATCH_SCRIPT)
        .data_directory("deepseek-login-data".into());

    #[cfg(target_os = "windows")]
    {
        builder = builder.additional_browser_args(
            "--ignore-certificate-errors \
             --disable-features=msEdgeTrackingPrevention"
        );
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn dsedit_login_done(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit_to("main", "deepseek-login-done", ());
    if let Some(w) = app.get_webview_window("deepseek-login") {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let _ = w.close();
        });
    }
    Ok(())
}

/* ------------------------------------------------------------
   PERMISSÃO DE MICROFONE (WebView2)
   ------------------------------------------------------------ */
#[cfg(target_os = "windows")]
fn enable_microphone_permission(pw: &tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PermissionRequestedEventHandler;


    unsafe {
        let controller = pw.controller();
        let core = controller
            .CoreWebView2()
            .map_err(|e| format!("CoreWebView2: {:?}", e))?;

        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                if args.PermissionKind(&mut kind).is_ok()
                    && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    eprintln!("[dsedit] permissão de microfone concedida");
                }
            }
            Ok(())
        }));

        let mut token = 0i64;
        core.add_PermissionRequested(&handler, &mut token)
            .map_err(|e| format!("add_PermissionRequested: {:?}", e))?;
        eprintln!("[dsedit] handler de permissão registrado");
    }
    Ok(())
}

/* ------------------------------------------------------------
   JANELA DO CHAT (com injetor)
   ------------------------------------------------------------ */
#[tauri::command]
async fn open_deepseek(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("deepseek") { let _ = w.set_focus(); return Ok(()); }
    let url = "https://chat.deepseek.com".parse().map_err(|_| "URL inválida".to_string())?;
    let win = WebviewWindowBuilder::new(&app, "deepseek", WebviewUrl::External(url))
        .title("DeepSeek")
        .inner_size(700.0, 900.0)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        .initialization_script(DSEDIT_INJECT_SCRIPT)
        .data_directory("deepseek-data".into())
        .build()
        .map_err(|e| e.to_string())?;

    win.with_webview(|pw| {
        #[cfg(target_os = "windows")]
        if let Err(e) = enable_microphone_permission(&pw) {
            eprintln!("[dsedit] falha ao registrar permissão de microfone: {}", e);
        }
    }).map_err(|e| e.to_string())?;

    Ok(())
}

/* ------------------------------------------------------------
   JANELA DO CHATGPT (só leitura de resposta)
   ------------------------------------------------------------ */
#[tauri::command]
async fn open_chatgpt(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("chatgpt") { let _ = w.set_focus(); return Ok(()); }
    let url = "https://chatgpt.com".parse().map_err(|_| "URL inválida".to_string())?;
    WebviewWindowBuilder::new(&app, "chatgpt", WebviewUrl::External(url))
        .title("ChatGPT")
        .inner_size(700.0, 900.0)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        .initialization_script(CHATGPT_INJECT_SCRIPT)
        .data_directory("chatgpt-data".into())
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------
   IMPORTAÇÃO DE AUTH (cookie + userToken)
   ------------------------------------------------------------ */
#[tauri::command]
async fn import_deepseek_auth(
    app: tauri::AppHandle,
    cookie: String,
    token: String,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("deepseek") {
        let _ = w.close();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let url = "https://chat.deepseek.com"
        .parse()
        .map_err(|_| "URL inválida".to_string())?;

    let token_lit = serde_json::to_string(&token).map_err(|e| e.to_string())?;
    let pre = format!(r#"
(function(){{
  try {{
    if (!location.hostname.endsWith('deepseek.com')) return;
    localStorage.setItem('userToken', JSON.stringify({{
      value: {},
      __version: '0'
    }}));
    console.log('[dsedit] userToken injetado');
  }} catch(e) {{ console.warn('[dsedit] pre-script:', e); }}
}})();
"#, token_lit);

    let win = WebviewWindowBuilder::new(&app, "deepseek", WebviewUrl::External(url))
        .title("DeepSeek")
        .inner_size(700.0, 900.0)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        .initialization_script(&pre)
        .initialization_script(DSEDIT_INJECT_SCRIPT)
        .data_directory("deepseek-data".into())
        .build()
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(std::time::Duration::from_millis(1400)).await;

    let c = cookie.clone();
    win.with_webview(move |pw| {
        #[cfg(target_os = "windows")]
        {
            if let Err(e) = inject_cookies_webview2(&pw, &c) {
                eprintln!("[dsedit] falha cookie: {}", e);
            }
            if let Err(e) = enable_microphone_permission(&pw) {
                eprintln!("[dsedit] falha permissão microfone: {}", e);
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = (&pw, &c);
    }).map_err(|e| e.to_string())?;

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    win.eval("location.reload()").map_err(|e| e.to_string())?;

    Ok(())
}

/* ============================================================
   CLIPBOARD
   ============================================================ */
#[tauri::command]
async fn read_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().map_err(|e| format!("clipboard: {}", e))
}

#[tauri::command]
async fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| format!("clipboard: {}", e))
}

/* ============================================================
   PREVIEW EM JANELA PRÓPRIA
   ============================================================ */
#[tauri::command]
async fn open_preview_window(
    app: tauri::AppHandle,
    html: String,
    title: String,
) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let id = format!("preview-{}", stamp);
    let mut tmp = std::env::temp_dir();
    tmp.push(format!("dsedit-preview-{}.html", stamp));
    std::fs::write(&tmp, &html).map_err(|e| format!("write temp: {}", e))?;
    let url = tauri::Url::from_file_path(&tmp).map_err(|_| "URL inválida".to_string())?;
    WebviewWindowBuilder::new(&app, &id, WebviewUrl::External(url))
        .title(title)
        .inner_size(1280.0, 820.0)
        .resizable(true)
        .fullscreen(false)
        .build()
        .map_err(|e| format!("build window: {}", e))?;
    Ok(())
}

/* ============================================================
   RUN
   ============================================================ */
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, list_dir,
            create_file, create_dir, delete_path, rename_path,
            read_project_files, build_repo_map, find_project_root, is_self_available,
            save_pin, load_pin, list_pins, grab_conversation,
            spawn_shell, write_to_shell, resize_shell, kill_shell,
            open_deepseek, open_deepseek_login, dsedit_login_done, import_deepseek_auth,
            open_chatgpt, chatgpt_response_ready,
            dsedit_received, dsedit_chat_status,
            send_to_deepseek, fetch_latest_block,
            read_clipboard, write_clipboard,
            open_preview_window
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = handle.emit("app-ready", "DSedit pronto");
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro rodando app");
}