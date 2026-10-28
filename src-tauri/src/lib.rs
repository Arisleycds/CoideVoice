use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FsEntry { pub path: String, pub is_dir: bool, pub size: u64 }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FsResult {
    pub success: bool, pub op: String, pub path: String, pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub entries: Option<Vec<FsEntry>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectInfo {
    pub name: String, pub path: String, pub is_active: bool, pub file_count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchMatch {
    pub line: usize,
    pub text: String,
    pub context: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub success: bool,
    pub path: String,
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReplaceRule {
    pub buscar: String,
    pub substituir: String,
    #[serde(default)]
    pub regex: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReplaceResult {
    pub success: bool,
    pub path: String,
    pub changed: bool,
    pub message: String,
    pub rules_applied: usize,
    pub rules_missed: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
}

pub struct WorkspaceState(pub Mutex<Option<PathBuf>>);

const DEEPEDIT_BASE: &str = "C:\\deepedit";

fn deepedit_base() -> PathBuf { PathBuf::from(DEEPEDIT_BASE) }
fn ensure_deepedit_base() -> Result<PathBuf, String> {
    let b = deepedit_base();
    fs::create_dir_all(&b).map_err(|e| e.to_string())?;
    Ok(b)
}
fn workspace_root(app: &tauri::AppHandle) -> PathBuf {
    if let Some(s) = app.try_state::<WorkspaceState>() {
        if let Ok(g) = s.0.lock() {
            if let Some(p) = g.as_ref() { return p.clone(); }
        }
    }
    deepedit_base()
}
fn ensure_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let r = workspace_root(app);
    fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    Ok(r)
}
fn ensure_active_project(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = ensure_deepedit_base()?;
    let root = ensure_workspace(app)?;
    let root_canon = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let base_canon = fs::canonicalize(&base).map_err(|e| e.to_string())?;
    if root_canon == base_canon {
        let default_path = base.join("default");
        fs::create_dir_all(&default_path).map_err(|e| e.to_string())?;
        let default_canon = fs::canonicalize(&default_path).map_err(|e| e.to_string())?;
        let state = app.state::<WorkspaceState>();
        *state.0.lock().map_err(|e| e.to_string())? = Some(default_canon.clone());
        return Ok(default_canon);
    }
    Ok(root)
}
fn safe_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let root = ensure_active_project(app)?;
    let rc = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if Path::new(rel).is_absolute() { return Err(format!("Path absoluto: {}", rel)); }
    let cleaned = rel.replace('\\', "/").split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>().join("/");
    if cleaned.is_empty() { return Ok(rc); }
    let full = root.join(&cleaned);
    if full.exists() {
        let c = fs::canonicalize(&full).map_err(|e| e.to_string())?;
        if !c.starts_with(&rc) { return Err(format!("Fora do workspace: {}", rel)); }
        return Ok(c);
    }
    let parent = full.parent().ok_or("Path inválido")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let pc = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !pc.starts_with(&rc) { return Err(format!("Fora do workspace: {}", rel)); }
    Ok(full)
}

// ═══════════════════════════════════════════════════════════
// COMANDOS FS
// ═══════════════════════════════════════════════════════════
#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let base = ensure_deepedit_base()?;
    let active = workspace_root(&app);
    let ac = fs::canonicalize(&active).ok();
    let mut out = Vec::new();
    for e in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if !p.is_dir() { continue; }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        let fc = fs::read_dir(&p).map(|rd| rd.flatten().filter(|x| x.path().is_file()).count() as u64).unwrap_or(0);
        let c = fs::canonicalize(&p).ok();
        let ia = match (&ac, &c) { (Some(a), Some(b)) => a == b, _ => false };
        out.push(ProjectInfo { name, path: p.to_string_lossy().to_string(), is_active: ia, file_count: fc });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
#[tauri::command]
async fn create_project(app: tauri::AppHandle, name: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Nome inválido".into());
    }
    let base = ensure_deepedit_base()?;
    let p = base.join(&name);
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    let c = fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let state = app.state::<WorkspaceState>();
    *state.0.lock().map_err(|e| e.to_string())? = Some(c.clone());
    // Inicializa Git
    let _ = git_init_at(&c);
    Ok(c.to_string_lossy().to_string())
}
#[tauri::command]
async fn select_project(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() || !p.is_dir() { return Err(format!("Não encontrado: {}", path)); }
    let bc = fs::canonicalize(deepedit_base()).map_err(|e| e.to_string())?;
    let c = fs::canonicalize(&p).map_err(|e| e.to_string())?;
    if !c.starts_with(&bc) { return Err(format!("Fora de C:\\deepedit: {}", path)); }
    let state = app.state::<WorkspaceState>();
    *state.0.lock().map_err(|e| e.to_string())? = Some(c.clone());
    Ok(c.to_string_lossy().to_string())
}
#[tauri::command]
async fn get_workspace(app: tauri::AppHandle) -> Result<String, String> {
    Ok(workspace_root(&app).to_string_lossy().to_string())
}
#[tauri::command]
async fn get_active_project(app: tauri::AppHandle) -> Result<Option<ProjectInfo>, String> {
    let active = workspace_root(&app);
    if !active.exists() { return Ok(None); }
    let bc = fs::canonicalize(deepedit_base()).ok();
    let ac = fs::canonicalize(&active).ok();
    if bc.is_some() && bc == ac { return Ok(None); }
    let name = active.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let fc = fs::read_dir(&active).map(|rd| rd.flatten().filter(|x| x.path().is_file()).count() as u64).unwrap_or(0);
    Ok(Some(ProjectInfo { name, path: active.to_string_lossy().to_string(), is_active: true, file_count: fc }))
}
#[tauri::command]
async fn fs_read(app: tauri::AppHandle, path: String) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    Ok(FsResult { success: true, op: "read".into(), path, message: format!("{} bytes", content.len()), content: Some(content), entries: None })
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
        message: format!("{} bytes {}", content.len(), if existed { "sobrescritos" } else { "criados" }),
        content: None, entries: None,
    })
}
#[tauri::command]
async fn fs_append(app: tauri::AppHandle, path: String, content: String) -> Result<FsResult, String> {
    use std::io::Write;
    let full = safe_path(&app, &path)?;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&full).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(FsResult { success: true, op: "append".into(), path, message: format!("{} bytes anexados", content.len()), content: None, entries: None })
}
#[tauri::command]
async fn fs_edit(app: tauri::AppHandle, path: String, old_string: String, new_string: String) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let n = content.matches(&old_string).count();
    if n == 0 { return Err(format!("Trecho não encontrado em {}", path)); }
    if n > 1 { return Err(format!("{} ocorrências em {} — inclua mais contexto", n, path)); }
    let nc = content.replacen(&old_string, &new_string, 1);
    fs::write(&full, &nc).map_err(|e| e.to_string())?;
    Ok(FsResult { success: true, op: "edit".into(), path, message: "1 substituição".into(), content: None, entries: None })
}
#[tauri::command]
async fn fs_delete(app: tauri::AppHandle, path: String) -> Result<FsResult, String> {
    let full = safe_path(&app, &path)?;
    if full.is_dir() { fs::remove_dir_all(&full).map_err(|e| e.to_string())?; }
    else { fs::remove_file(&full).map_err(|e| e.to_string())?; }
    Ok(FsResult { success: true, op: "delete".into(), path, message: "removido".into(), content: None, entries: None })
}
#[tauri::command]
async fn fs_list(app: tauri::AppHandle, path: Option<String>) -> Result<FsResult, String> {
    let rel = path.unwrap_or_else(|| ".".into());
    let full = safe_path(&app, &rel)?;
    if !full.is_dir() { return Err(format!("{} não é pasta", rel)); }
    let root = ensure_workspace(&app)?;
    let mut entries = Vec::new();
    for e in fs::read_dir(&full).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let rp = p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().to_string();
        entries.push(FsEntry { path: rp, is_dir: p.is_dir(), size });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(FsResult { success: true, op: "list".into(), path: rel, message: format!("{} entradas", entries.len()), content: None, entries: Some(entries) })
}
#[tauri::command]
async fn fs_exists(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    Ok(safe_path(&app, &path).map(|p| p.exists()).unwrap_or(false))
}

// ═══════════════════════════════════════════════════════════
// SEARCH (economia de tokens)
// ═══════════════════════════════════════════════════════════
#[tauri::command]
async fn fs_search(
    app: tauri::AppHandle,
    path: String,
    query: String,
    context_lines: Option<usize>,
) -> Result<SearchResult, String> {
    let full = safe_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let ctx = context_lines.unwrap_or(2);
    let query_lower = query.to_lowercase();
    let mut matches = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.to_lowercase().contains(&query_lower) {
            let start = i.saturating_sub(ctx);
            let end = (i + ctx + 1).min(lines.len());
            let context: Vec<String> = lines[start..end]
                .iter()
                .enumerate()
                .map(|(j, l)| {
                    let ln = start + j + 1;
                    let marker = if start + j == i { "→" } else { " " };
                    format!("{} {:4}: {}", marker, ln, l)
                })
                .collect();
            matches.push(SearchMatch { line: i + 1, text: line.to_string(), context });
        }
    }
    Ok(SearchResult {
        success: true, path, query,
        message: format!("{} match(es)", matches.len()),
        matches,
    })
}

// ═══════════════════════════════════════════════════════════
// REPLACE (batch, backup, dry-run)
// ═══════════════════════════════════════════════════════════
#[tauri::command]
async fn fs_replace(
    app: tauri::AppHandle,
    path: String,
    rules: Vec<ReplaceRule>,
    dry_run: Option<bool>,
    backup: Option<bool>,
) -> Result<ReplaceResult, String> {
    let full = safe_path(&app, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let dry = dry_run.unwrap_or(false);
    let bak = backup.unwrap_or(true);

    let mut new_content = content.clone();
    let mut applied = 0;
    let mut missed = Vec::new();

    for (i, rule) in rules.iter().enumerate() {
        let count = if rule.regex {
            match regex::Regex::new(&rule.buscar) {
                Ok(re) => {
                    let matches = re.find_iter(&new_content).count();
                    if matches > 0 {
                        new_content = re.replace_all(&new_content, rule.substituir.as_str()).to_string();
                    }
                    matches
                }
                Err(e) => {
                    missed.push(format!("Regra {}: regex inválido: {}", i + 1, e));
                    0
                }
            }
        } else {
            let parts: Vec<&str> = new_content.split(&rule.buscar).collect();
            let count = parts.len().saturating_sub(1);
            if count > 0 { new_content = parts.join(&rule.substituir); }
            count
        };
        if count > 0 { applied += 1; }
        else {
            let trecho = rule.buscar.lines().next().unwrap_or("").trim();
            let curto = if trecho.len() > 70 { &trecho[..70] } else { trecho };
            missed.push(format!("Regra {}: não encontrou \"{}\"", i + 1, curto));
        }
    }

    let changed = new_content != content;
    if !dry && changed {
        if bak {
            let bak_path = PathBuf::from(format!("{}.bak", full.display()));
            let _ = fs::copy(&full, &bak_path);
        }
        fs::write(&full, &new_content).map_err(|e| e.to_string())?;
    }

    Ok(ReplaceResult {
        success: true, path, changed,
        message: format!(
            "{} regra(s) aplicada(s), {} não encontrada(s), arquivo {}",
            applied, missed.len(),
            if changed { if dry { "seria alterado" } else { "alterado" } } else { "inalterado" }
        ),
        rules_applied: applied,
        rules_missed: missed,
    })
}

// ═══════════════════════════════════════════════════════════
// GIT (snapshot, undo, log, status)
// ═══════════════════════════════════════════════════════════
fn git_init_at(path: &Path) -> Result<git2::Repository, String> {
    if let Ok(repo) = git2::Repository::open(path) {
        return Ok(repo);
    }
    let repo = git2::Repository::init(path).map_err(|e| e.to_string())?;
    // .gitignore básico
    let gitignore = path.join(".gitignore");
    if !gitignore.exists() {
        let _ = fs::write(&gitignore,
            "node_modules/\ntarget/\ndist/\nbuild/\n*.bak\n_deepedit_index.json\n.next/\ncoverage/\n");
    }
    Ok(repo)
}

#[tauri::command]
async fn git_snapshot(app: tauri::AppHandle, message: String) -> Result<GitResult, String> {
    let root = ensure_active_project(&app)?;
    let repo = git_init_at(&root)?;
    
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    
    // Verifica se há mudanças
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let head = repo.head().ok();
    let parent = head.as_ref().and_then(|h| h.peel_to_commit().ok());
    
    // Se nada mudou, não commita
    if let Some(ref p) = parent {
        let parent_tree = p.tree().map_err(|e| e.to_string())?;
        if parent_tree.id() == tree_oid {
            return Ok(GitResult { success: true, message: "Nada a commitar (sem mudanças)".into(), oid: None });
        }
    }
    
    let sig = repo.signature()
        .or_else(|_| git2::Signature::now("DeepEdit", "bot@deepedit.local"))
        .map_err(|e| e.to_string())?;
    
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    
    Ok(GitResult { success: true, message: format!("Commit {}", &oid.to_string()[..8]), oid: Some(oid.to_string()) })
}

#[tauri::command]
async fn git_undo_last(app: tauri::AppHandle) -> Result<GitResult, String> {
    let root = ensure_active_project(&app)?;
    let repo = git2::Repository::open(&root).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| format!("Sem commits: {}", e))?;
    let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    let parent = commit.parent(0).map_err(|_| "Sem commit anterior para desfazer".to_string())?;
    repo.reset(parent.as_object(), git2::ResetType::Hard, None).map_err(|e| e.to_string())?;
    Ok(GitResult {
        success: true,
        message: format!("Voltou para commit {}", &parent.id().to_string()[..8]),
        oid: Some(parent.id().to_string()),
    })
}

#[tauri::command]
async fn git_status(app: tauri::AppHandle) -> Result<GitResult, String> {
    let root = ensure_active_project(&app)?;
    let repo = git2::Repository::open(&root).map_err(|e| e.to_string())?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut changed = Vec::new();
    for s in statuses.iter() {
        if let Some(path) = s.path() {
            changed.push(path.to_string());
        }
    }
    Ok(GitResult {
        success: true,
        message: if changed.is_empty() { "Limpo".into() } else { format!("{} arquivo(s) alterado(s): {}", changed.len(), changed.join(", ")) },
        oid: None,
    })
}

#[tauri::command]
async fn git_log(app: tauri::AppHandle, limit: Option<usize>) -> Result<GitResult, String> {
    let root = ensure_active_project(&app)?;
    let repo = git2::Repository::open(&root).map_err(|e| e.to_string())?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| format!("Sem commits: {}", e))?;
    let mut lines = Vec::new();
    let limit = limit.unwrap_or(10);
    for (i, oid) in revwalk.enumerate() {
        if i >= limit { break; }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let msg = commit.message().unwrap_or("(sem mensagem)");
        let first_line = msg.lines().next().unwrap_or("");
        lines.push(format!("{} {}", &oid.to_string()[..8], first_line));
    }
    Ok(GitResult {
        success: true,
        message: if lines.is_empty() { "(sem commits)".into() } else { lines.join("\n") },
        oid: None,
    })
}

// ═══════════════════════════════════════════════════════════
// JANELAS
// ═══════════════════════════════════════════════════════════
#[tauri::command]
async fn get_cookies(window: WebviewWindow) -> Result<Vec<String>, String> {
    window.cookies().map(|c| c.iter().map(|x| x.to_string()).collect()).map_err(|e| e.to_string())
}
#[tauri::command]
async fn inject_script(window: WebviewWindow, script: String) -> Result<(), String> {
    window.eval(&script).map_err(|e| e.to_string())
}
#[tauri::command]
async fn inject_script_into(app: tauri::AppHandle, window_label: String, script: String) -> Result<(), String> {
    let w = app.get_webview_window(&window_label).ok_or_else(|| format!("Janela '{}' não encontrada", window_label))?;
    w.eval(&script).map_err(|e| e.to_string())
}

fn criar_janela(app: &tauri::AppHandle, label: &str, title: &str, script: &str) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, label,
        WebviewUrl::External("https://chat.deepseek.com".parse().unwrap()))
        .title(title)
        .inner_size(900.0, 700.0)
        .visible(false)
        .skip_taskbar(true)
        .devtools(true)
        .initialization_script(script)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.show();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let _ = window.hide();
    Ok(())
}

#[tauri::command]
async fn open_conversa_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("conversa") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(&app, "conversa",
        WebviewUrl::App("conversa.html".parse().unwrap()))
        .title("DeepEdit — Conversa")
        .inner_size(700.0, 850.0)
        .visible(true)
        .devtools(true)
        .build().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}
#[tauri::command]
async fn open_conversador_chat(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("conversador-chat").is_some() { return Ok(()); }
    criar_janela(&app, "conversador-chat", "DeepSeek — Conversador", CONVERSADOR_CHAT_SCRIPT)
}
#[tauri::command]
async fn open_edit_chat_hidden(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("edit-chat").is_some() { return Ok(()); }
    criar_janela(&app, "edit-chat", "DeepSeek — Edição", EDIT_CHAT_SCRIPT)
}
#[tauri::command]
async fn wait_for_chat_ready(app: tauri::AppHandle, window_label: String, max_ms: u64) -> Result<bool, String> {
    let w = app.get_webview_window(&window_label)
        .ok_or_else(|| format!("Janela '{}' não encontrada", window_label))?;
    let start = std::time::Instant::now();
    let max = std::time::Duration::from_millis(max_ms);
    loop {
        if let Ok(url) = w.url() {
            if url.as_str().contains("deepseek.com") {
                std::thread::sleep(std::time::Duration::from_millis(500));
                return Ok(true);
            }
        }
        if start.elapsed() > max { return Ok(false); }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

#[tauri::command]
async fn send_to_chat(app: tauri::AppHandle, window_label: String, message: String) -> Result<(), String> {
    let w = app.get_webview_window(&window_label)
        .ok_or_else(|| format!("Janela '{}' não encontrada", window_label))?;
    let json = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    let label_json = serde_json::to_string(&window_label).unwrap();
    let script = format!(r#"
(function() {{
  var msg = {json};
  var label = {label_json};
  function trySend() {{
    var ta = document.querySelector('textarea[name="search"]') || document.querySelector('textarea');
    if (!ta) {{ console.error('[DSM-send] textarea em ' + label); return; }}
    ta.focus(); ta.click();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, msg);
    try {{
      ta.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: msg }}));
    }} catch (e) {{
      ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
    }}
    ta.dispatchEvent(new Event('change', {{ bubbles: true }}));
    setTimeout(function() {{
      var btn = document.querySelector('[role="button"]:not([aria-disabled="true"]) svg path[d*="M8.3125"]');
      if (btn) {{
        var button = btn.closest('[role="button"]');
        if (button && !button.getAttribute('aria-disabled')) {{
          button.click();
          console.log('[DSM-send] click em ' + label);
          return;
        }}
      }}
      var e = new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }});
      ta.dispatchEvent(e);
      console.log('[DSM-send] Enter em ' + label);
      setTimeout(function() {{
        if (ta.value.trim() !== '') {{
          var p = document.querySelector('[role="button"] svg path[d*="M8.3125"]');
          if (p) {{ p.closest('[role="button"]').click(); console.log('[DSM-send] fallback click em ' + label); }}
        }}
      }}, 500);
    }}, 400);
  }}
  var tries = 0;
  function waitFor() {{
    var ta = document.querySelector('textarea');
    if (ta) trySend();
    else if (tries < 100) {{ tries++; setTimeout(waitFor, 200); }}
    else console.error('[DSM-send] textarea nao apareceu em ' + label);
  }}
  waitFor();
}})();
"#, json = json, label_json = label_json);
    w.eval(&script).map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════════════════
// CONVERSADOR (JSON puro)
// ═══════════════════════════════════════════════════════════
const CONVERSADOR_CHAT_SCRIPT: &str = r##"
(function() {
  function __clean(text) {
    return text.replace(/\n?Copiar\n?/g, '\n').replace(/\n?Baixar\n?/g, '\n')
      .replace(/\n?Copy\n?/g, '\n').replace(/\n?Download\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  function __repair(s) { return s.replace(/([^\\])\n/g, '$1\\n').replace(/([^\\])\r/g, '$1\\r'); }
  function __safeParse(s) { try { return JSON.parse(s); } catch(e) { try { return JSON.parse(__repair(s)); } catch(e2) { return null; } } }
  function __parse(text, keys, tag) {
    var out = [];
    var clean = __clean(text);
    var jsonRe = /\{[\s\S]*?\}/g;
    var matches = [...clean.matchAll(jsonRe)];
    for (const m of matches) {
      const p = __safeParse(m[0]);
      if (!p) continue;
      for (const k of keys) {
        if (p[k]) { out.push(p); break; }
      }
    }
    if (out.length === 0) {
      for (const key of keys) {
        const re = new RegExp('"'+key+'"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', 'g');
        let m;
        while ((m = re.exec(clean)) !== null) {
          if (m[1] && m[1].length > 0) {
            const obj = {}; obj[key] = m[1]; out.push(obj);
          }
        }
      }
    }
    return out;
  }

  function waitForTauri(cb, t) {
    t = t || 0;
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) {
      console.log('[DSM-conv] ok'); cb(window.__TAURI__);
    } else if (t < 100) setTimeout(function(){ waitForTauri(cb, t+1); }, 100);
  }

  var SYSTEM_PROMPT = [
    'Você é o CONVERSADOR do DeepEdit.',
    '',
    '## FORMATO DE RESPOSTA',
    'Toda resposta é UM JSON. Sem crases, sem texto antes/depois.',
    '',
    'Para CONVERSAR:',
    '{"resposta": "texto"}',
    '',
    'Para BUSCAR um trecho (economia):',
    '{"op": "search", "path": "game.js", "query": "let speed", "context": 2}',
    '',
    'Para LER arquivo inteiro (raro):',
    '{"path": "game.js"}',
    '',
    'Para DELEGAR uma task:',
    '{"task": "criar jogo de entregas"}',
    '',
    '## REGRAS',
    '- NUNCA use crases (```).',
    '- Use apenas aspas duplas (") no JSON.',
    '- Uma resposta = um JSON.',
    '',
    '## PRIMEIRA RESPOSTA',
    '{"resposta": "Conversador ativo."}'
  ].join('\n');

  function watchAssistant(T) {
    var seen = new WeakSet();
    var pendingTimers = new WeakMap();
    var readyEmitted = sessionStorage.getItem('dsm-ready-conv') === 'true';
    var readSent = {};
    var searchSent = {};

    function process(root) {
      if (!(root instanceof HTMLElement)) return;
      var cands = [];
      if (root.matches && root.matches('.ds-assistant-message-main-content')) cands.push(root);
      if (root.querySelectorAll) root.querySelectorAll('.ds-assistant-message-main-content').forEach(function(el){ cands.push(el); });
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (seen.has(el)) continue;
        if (pendingTimers.has(el)) clearTimeout(pendingTimers.get(el));
        var timer = setTimeout(function() {
          pendingTimers.delete(el);
          if (seen.has(el)) return;
          var text = el.innerText || '';
          if (text.length < 10) return;

          var searchMatches = __parse(text, ['query'], 'DSM-conv-search').filter(x => x.query);
          var cleanText = text;
          for (const s of searchMatches) {
            if (s.query && !searchSent[s.query]) {
              T.event.emit('search-request', { path: s.path || '', query: s.query, context: s.context || 2 });
              searchSent[s.query] = true;
            }
          }
          var readMatches = __parse(text, ['path'], 'DSM-conv-read').filter(x => x.path);
          for (const r of readMatches) {
            if (r.path && !readSent[r.path]) {
              T.event.emit('read-request', { path: r.path });
              readSent[r.path] = true;
            }
          }
          var taskMatches = __parse(cleanText, ['task'], 'DSM-conv-task');
          var respMatches = __parse(cleanText, ['resposta'], 'DSM-conv-resp');
          var displayText = '';
          if (respMatches.length > 0 && respMatches[0].resposta) displayText = respMatches[0].resposta;
          else if (cleanText.length > 0 && taskMatches.length === 0) displayText = cleanText.replace(/\n{3,}/g, '\n\n').trim();
          if (displayText.length > 0) T.event.emit('main-response', { text: displayText });
          if (!readyEmitted && (/conversador ativo/i.test(text) || /conversador ativo/i.test(displayText))) {
            readyEmitted = true;
            sessionStorage.setItem('dsm-ready-conv', 'true');
            T.event.emit('main-ready', { ready: true });
          }
          if (taskMatches.length > 0) {
            seen.add(el);
            for (const t of taskMatches) T.event.emit('delegate-to-edit', t);
            return;
          }
          seen.add(el);
        }, 2000);
        pendingTimers.set(el, timer);
      }
    }
    new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var ns = muts[i].addedNodes;
        for (var j = 0; j < ns.length; j++) process(ns[j]);
      }
    }).observe(document.body, {childList:true, subtree:true});
  }

  var promptSent = false;
  function maybeSendPrompt() {
    if (promptSent) return;
    if (sessionStorage.getItem('dsm-prompt-conv') === 'true') return;
    var isHome = location.pathname === '/' || location.pathname === '';
    var isChat = /^\/a\/chat\/s\//.test(location.pathname);
    var msgs = document.querySelectorAll('.ds-assistant-message-main-content').length;
    if (!(isHome || (isChat && msgs === 0))) { setTimeout(maybeSendPrompt, 500); return; }
    var ta = document.querySelector('textarea');
    if (!ta) { setTimeout(maybeSendPrompt, 500); return; }
    if (ta.value.trim()) { setTimeout(maybeSendPrompt, 500); return; }
    ta.focus(); ta.click();
    var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, SYSTEM_PROMPT);
    try { ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: SYSTEM_PROMPT })); }
    catch (e) { ta.dispatchEvent(new Event('input', { bubbles: true })); }
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    promptSent = true;
    sessionStorage.setItem('dsm-prompt-conv', 'true');
    setTimeout(function() {
      var b = document.querySelector('[role="button"][aria-disabled="false"] svg path[d*="M8.3125"]');
      if (b) b.closest('[role="button"]').click();
      else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }, 500);
  }

  function boot() {
    waitForTauri(function(T) { watchAssistant(T); setTimeout(maybeSendPrompt, 1000); });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
"##;

// ═══════════════════════════════════════════════════════════
// EDIÇÃO (search + replace + write/append + E2)
// ═══════════════════════════════════════════════════════════
const EDIT_CHAT_SCRIPT: &str = r##"
(function() {
  function __clean(text) {
    return text.replace(/\n?Copiar\n?/g, '\n').replace(/\n?Baixar\n?/g, '\n')
      .replace(/\n?Copy\n?/g, '\n').replace(/\n?Download\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  function __repair(s) { return s.replace(/([^\\])\n/g, '$1\\n').replace(/([^\\])\r/g, '$1\\r'); }
  function __safeParse(s) { try { return JSON.parse(s); } catch(e) { try { return JSON.parse(__repair(s)); } catch(e2) { return null; } } }
  function __parse(text, keys, tag) {
    var out = [];
    var clean = __clean(text);
    var jsonRe = /\{[\s\S]*?\}/g;
    var matches = [...clean.matchAll(jsonRe)];
    for (const m of matches) {
      const p = __safeParse(m[0]);
      if (p && p.op) out.push(p);
    }
    if (out.length) return out;
    var opRe = /"op"\s*:\s*"(\w+)"/g;
    var opMatches = [...clean.matchAll(opRe)];
    for (let i = 0; i < opMatches.length; i++) {
      const opVal = opMatches[i][1];
      const startIdx = opMatches[i].index;
      const endIdx = (i + 1 < opMatches.length) ? opMatches[i + 1].index : clean.length;
      const segment = clean.slice(startIdx, endIdx);
      const obj = { op: opVal };
      const pathMatch = segment.match(/"path"\s*:\s*"([^"]+)"/);
      if (pathMatch) obj.path = pathMatch[1];
      const queryMatch = segment.match(/"query"\s*:\s*"([^"]+)"/);
      if (queryMatch) obj.query = queryMatch[1];
      if (opVal === 'write' || opVal === 'append') {
        const contentMatch = segment.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/);
        if (contentMatch) {
          let contentVal = contentMatch[1];
          try { contentVal = JSON.parse('"' + contentVal + '"'); } catch (e) {}
          obj.content = contentVal;
        }
      }
      if (opVal === 'edit') {
        const oldM = segment.match(/"old"\s*:\s*"([\s\S]*?)"/);
        const newM = segment.match(/"new"\s*:\s*"([\s\S]*?)"/);
        if (oldM) obj.old = oldM[1];
        if (newM) obj.new = newM[1];
      }
      if (opVal === 'replace') {
        const rulesM = segment.match(/"rules"\s*:\s*(\[[\s\S]*?\])/);
        if (rulesM) {
          try { obj.rules = JSON.parse(rulesM[1]); } catch (e) {}
        }
      }
      if (obj.path) out.push(obj);
    }
    return out;
  }

  function waitForTauri(cb, t) {
    t = t || 0;
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) {
      console.log('[DSM-edit] ok'); cb(window.__TAURI__);
    } else if (t < 100) setTimeout(function(){ waitForTauri(cb, t+1); }, 100);
  }

  var SYSTEM_PROMPT = [
    'Você é o EDITA do DeepEdit.',
    '',
    '## FORMATO DE RESPOSTA',
    'Toda resposta é UM JSON. Sem crases, sem texto antes/depois.',
    '',
    '## ECONOMIA DE TOKENS',
    'Para EDITAR arquivos existentes, use "replace" (NÃO use "write"):',
    '{"op": "replace", "path": "game.js", "rules": [{"buscar": "let speed = 100;", "substituir": "let speed = 200;"}]}',
    '',
    'Para BUSCAR um trecho antes de editar:',
    '{"op": "search", "path": "game.js", "query": "let speed", "context": 2}',
    '',
    'Para ESCREVER arquivo NOVO (não existe):',
    '{"op": "write", "path": "novo.js", "content": "..."}',
    '',
    'Para LER arquivo inteiro (raro):',
    '{"op": "read", "path": "game.js"}',
    '',
    'Para ANEXAR ao final:',
    '{"op": "append", "path": "game.js", "content": "..."}',
    '',
    '## REGRAS',
    '- NUNCA use crases (```).',
    '- Use apenas aspas duplas (") no JSON.',
    '- Se > 1500 chars e usar "write", DIVIDA em write + append.',
    '- Para editar, PREFIRA "replace" (não reescreve o arquivo inteiro).',
    '',
    '## FLUXO PARA EDITAR',
    '1. Emita {"op": "search", "path": "game.js", "query": "trecho"}.',
    '2. Receba os matches com contexto.',
    '3. Emita {"op": "replace", "path": "game.js", "rules": [{"buscar": "<exato>", "substituir": "<novo>"}]}.',
    '',
    '## PRIMEIRA RESPOSTA',
    '{"op": "noop", "resposta": "Executor ativo."}'
  ].join('\n');

  function watchAssistant(T) {
    var seen = new WeakSet();
    var pendingTimers = new WeakMap();
    var readyEmitted = sessionStorage.getItem('dsm-ready-edit') === 'true';

    function process(root) {
      if (!(root instanceof HTMLElement)) return;
      var cands = [];
      if (root.matches && root.matches('.ds-assistant-message-main-content')) cands.push(root);
      if (root.querySelectorAll) root.querySelectorAll('.ds-assistant-message-main-content').forEach(function(el){ cands.push(el); });
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (seen.has(el)) continue;
        if (pendingTimers.has(el)) clearTimeout(pendingTimers.get(el));
        var timer = setTimeout(function() {
          pendingTimers.delete(el);
          if (seen.has(el)) return;
          var text = el.innerText || '';
          if (text.length < 10) return;

          var calls = __parse(text, ['op'], 'DSM-edit');
          var realCalls = calls.filter(c => c.op && c.op !== 'noop');
          var noopCalls = calls.filter(c => c.op === 'noop');

          if (noopCalls.length > 0) {
            const resp = noopCalls[0].resposta || 'Executor ativo.';
            if (!readyEmitted) {
              readyEmitted = true;
              sessionStorage.setItem('dsm-ready-edit', 'true');
              T.event.emit('edit-ready', { ready: true });
            }
            T.event.emit('edit-response', { text: resp });
          }
          if (realCalls.length > 0) {
            seen.add(el);
            T.event.emit('edit-response', { text: text });
            if (!readyEmitted) {
              readyEmitted = true;
              sessionStorage.setItem('dsm-ready-edit', 'true');
              T.event.emit('edit-ready', { ready: true });
            }
            T.event.emit('tool-calls-detected', realCalls);
            return;
          }
          if (noopCalls.length === 0) {
            seen.add(el);
            T.event.emit('edit-response', { text: text });
            if (!readyEmitted && /executor ativo/i.test(text)) {
              readyEmitted = true;
              sessionStorage.setItem('dsm-ready-edit', 'true');
              T.event.emit('edit-ready', { ready: true });
            }
          }
        }, 2000);
        pendingTimers.set(el, timer);
      }
    }
    new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var ns = muts[i].addedNodes;
        for (var j = 0; j < ns.length; j++) process(ns[j]);
      }
    }).observe(document.body, {childList:true, subtree:true});
  }

  var promptSent = false;
  function maybeSendPrompt() {
    if (promptSent) return;
    if (sessionStorage.getItem('dsm-prompt-edit') === 'true') return;
    var isHome = location.pathname === '/' || location.pathname === '';
    var isChat = /^\/a\/chat\/s\//.test(location.pathname);
    var msgs = document.querySelectorAll('.ds-assistant-message-main-content').length;
    if (!(isHome || (isChat && msgs === 0))) { setTimeout(maybeSendPrompt, 500); return; }
    var ta = document.querySelector('textarea');
    if (!ta) { setTimeout(maybeSendPrompt, 500); return; }
    if (ta.value.trim()) { setTimeout(maybeSendPrompt, 500); return; }
    ta.focus(); ta.click();
    var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, SYSTEM_PROMPT);
    try { ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: SYSTEM_PROMPT })); }
    catch (e) { ta.dispatchEvent(new Event('input', { bubbles: true })); }
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    promptSent = true;
    sessionStorage.setItem('dsm-prompt-edit', 'true');
    setTimeout(function() {
      var b = document.querySelector('[role="button"][aria-disabled="false"] svg path[d*="M8.3125"]');
      if (b) b.closest('[role="button"]').click();
      else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }, 500);
  }

  function boot() {
    waitForTauri(function(T) { watchAssistant(T); setTimeout(maybeSendPrompt, 1000); });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
"##;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(WorkspaceState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            fs_read, fs_write, fs_append, fs_edit, fs_delete, fs_list, fs_exists,
            fs_search, fs_replace,
            git_snapshot, git_undo_last, git_status, git_log,
            list_projects, create_project, select_project, get_workspace, get_active_project,
            get_cookies, inject_script, inject_script_into,
            open_conversa_panel, open_conversador_chat, open_edit_chat_hidden,
            wait_for_chat_ready, send_to_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}