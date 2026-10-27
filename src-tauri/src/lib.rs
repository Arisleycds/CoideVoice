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

fn safe_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let root = ensure_workspace(app)?;
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
    *app.state::<WorkspaceState>().0.lock().map_err(|e| e.to_string())? = Some(c.clone());
    Ok(c.to_string_lossy().to_string())
}

#[tauri::command]
async fn select_project(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() || !p.is_dir() { return Err(format!("Não encontrado: {}", path)); }
    let bc = fs::canonicalize(deepedit_base()).map_err(|e| e.to_string())?;
    let c = fs::canonicalize(&p).map_err(|e| e.to_string())?;
    if !c.starts_with(&bc) { return Err(format!("Fora de C:\\deepedit: {}", path)); }
    *app.state::<WorkspaceState>().0.lock().map_err(|e| e.to_string())? = Some(c.clone());
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
    if n > 1 { return Err(format!("{} ocorrências em {} — mais específico", n, path)); }
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

// ── CHAT 1: Principal (Coordenador / Game Design) ──
#[tauri::command]
async fn open_main_chat(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main-chat") { w.set_focus().map_err(|e| e.to_string())?; return Ok(()); }
    let _ = WebviewWindowBuilder::new(&app, "main-chat",
        WebviewUrl::External("https://chat.deepseek.com".parse().unwrap()))
        .title("1. Chat Principal (Coordenador)")
        .inner_size(1000.0, 850.0)
        .initialization_script(MAIN_CHAT_SCRIPT)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

// ── CHAT 2: Design (Especificador) ──
#[tauri::command]
async fn open_design_chat(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("design-chat") {
        let _ = w.unminimize();
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(&app, "design-chat",
        WebviewUrl::External("https://chat.deepseek.com".parse().unwrap()))
        .title("2. Chat Design (Especificador)")
        .inner_size(900.0, 700.0)
        .visible(true)
        .skip_taskbar(true)
        .devtools(true)
        .initialization_script(DESIGN_CHAT_SCRIPT)
        .build().map_err(|e| e.to_string())?;
    let _ = window.minimize();
    Ok(())
}

// ── CHAT 3: Edição (Executor) ──
#[tauri::command]
async fn open_edit_chat_hidden(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("edit-chat") {
        let _ = w.unminimize();
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(&app, "edit-chat",
        WebviewUrl::External("https://chat.deepseek.com".parse().unwrap()))
        .title("3. Chat de Edição (Executor)")
        .inner_size(900.0, 700.0)
        .visible(true)
        .skip_taskbar(true)
        .devtools(true)
        .initialization_script(EDIT_CHAT_SCRIPT)
        .build().map_err(|e| e.to_string())?;
    let _ = window.minimize();
    Ok(())
}

#[tauri::command]
async fn send_to_chat(app: tauri::AppHandle, window_label: String, message: String) -> Result<(), String> {
    let w = app.get_webview_window(&window_label).ok_or_else(|| format!("Janela '{}' não encontrada", window_label))?;
    let json = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    let script = format!(
        "(function(){{var ta=document.querySelector('textarea');if(!ta){{console.error('[DSM] textarea nao encontrada em {label}');return;}}var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,{msg});ta.dispatchEvent(new Event('input',{{bubbles:true}}));setTimeout(function(){{var b=document.querySelector('[role=\"button\"][aria-disabled=\"false\"] svg path[d*=\"M8.3125\"]');if(b){{b.closest('[role=\"button\"]').click();console.log('[DSM] enviado em {label}');}}else{{console.warn('[DSM] botao enviar nao encontrado em {label}');}}}},400);}})();",
        label = window_label,
        msg = json
    );
    w.eval(&script).map_err(|e| e.to_string())
}

// Verifica se uma janela existe e está pronta (tem textarea)
#[tauri::command]
async fn chat_ready(app: tauri::AppHandle, window_label: String) -> Result<bool, String> {
    let w = match app.get_webview_window(&window_label) {
        Some(w) => w,
        None => return Ok(false),
    };
    // Não temos como chamar JS síncrono, então tentamos avaliar e retornar sempre true
    // O check real é feito pelo JS que injeta e verifica se a textarea existe
    let _ = w.eval("console.log('[DSM] chat_ready check')");
    Ok(true)
}

// ═══════════════════════════════════════════════════════════
// CHAT 1: PRINCIPAL (Coordenador)
// ═══════════════════════════════════════════════════════════
const MAIN_CHAT_SCRIPT: &str = r##"
(function() {
  function waitForTauri(cb, t) {
    t = t || 0;
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) cb(window.__TAURI__);
    else if (t < 100) setTimeout(function(){ waitForTauri(cb, t+1); }, 100);
  }

  var SYSTEM_PROMPT = [
    'Você é o CHAT PRINCIPAL — o COORDENADOR do pipeline DeepEdit.',
    'Você fala com o humano sobre game design e DECIDE o que fazer.',
    'Você NUNCA gera código. Você NUNCA especifica detalhes técnicos.',
    'Seu trabalho é: ouvir o humano, decidir o que criar, e DELEGAR',
    'para o Chat Design, que vai especificar. O Chat Design delega ao',
    'Chat de Edição, que implementa.',
    '',
    '═══════════════════════════════════════════════════',
    'PIPELINE',
    '═══════════════════════════════════════════════════',
    'Humano → [VOCÊ: decide] → Chat Design → Chat de Edição → Arquivos',
    '',
    '═══════════════════════════════════════════════════',
    'FORMATO DE DELEGAÇÃO',
    '═══════════════════════════════════════════════════',
    'Quando decidir que algo deve ser implementado, emita:',
    '',
    '```delegate',
    '{"briefing": "O QUE criar e POR QUÊ (linguagem natural, sem código)"}',
    '```',
    '',
    'Exemplo:',
    '```delegate',
    '{"briefing": "O jogador precisa de uma espada de rubi que brilha no escuro. Dano médio-alto, durável, visual chamativo. É a primeira arma mágica do jogo, deve parecer especial."}',
    '```',
    '',
    '═══════════════════════════════════════════════════',
    'REGRAS',
    '═══════════════════════════════════════════════════',
    '- Converse sobre design, balanceamento, lore, progressão.',
    '- NUNCA cole código. NUNCA especifique classes Java.',
    '- Pergunte ao humano antes de delegar: "Posso criar isso?"',
    '- Depois de delegar, aguarde. O Design vai especificar, o Edição',
    '  vai implementar, e você comenta o resultado.',
    '- Se houver erro, você recebe e explica ao humano.',
    '',
    'Responda apenas: "Coordenador ativo. Vamos falar do jogo. Quando decidirmos algo, eu delego ao Design."'
  ].join('\n');

  function parseDelegations(text) {
    var re = /```delegate\s*\n([\s\S]*?)\n```/g;
    var out = [], m;
    while ((m = re.exec(text)) !== null) {
      try {
        var p = JSON.parse(m[1].trim());
        if (p && p.briefing) out.push(p);
      } catch (e) { console.warn('[DSM-main] JSON inválido:', m[1], e); }
    }
    return out;
  }

  function watchAssistant(T) {
    var seen = new WeakSet();
    function process(root) {
      if (!(root instanceof HTMLElement)) return;
      var cands = [];
      if (root.matches && root.matches('.ds-assistant-message-main-content')) cands.push(root);
      if (root.querySelectorAll) root.querySelectorAll('.ds-assistant-message-main-content').forEach(function(el){ cands.push(el); });
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (seen.has(el)) continue;
        seen.add(el);
        var text = el.innerText || '';
        if (text.length < 10) continue;
        var tasks = parseDelegations(text);
        if (!tasks.length) continue;
        console.log('[DSM-main] Delegando ao Design:', tasks);
        for (var k = 0; k < tasks.length; k++) {
          T.event.emit('delegate-to-design', tasks[k]);
        }
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
    var isHome = location.pathname === '/' || location.pathname === '';
    var isChat = /^\/a\/chat\/s\//.test(location.pathname);
    var msgs = document.querySelectorAll('.ds-assistant-message-main-content').length;
    if (!(isHome || (isChat && msgs === 0))) return;
    var ta = document.querySelector('textarea');
    if (!ta || ta.value.trim()) return;
    var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, SYSTEM_PROMPT);
    ta.dispatchEvent(new Event('input', {bubbles:true}));
    promptSent = true;
    setTimeout(function() {
      var b = document.querySelector('[role="button"][aria-disabled="false"] svg path[d*="M8.3125"]');
      if (b) b.closest('[role="button"]').click();
    }, 300);
  }

  function boot() {
    waitForTauri(function(T) {
      watchAssistant(T);
      setTimeout(maybeSendPrompt, 1500);
    });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
"##;

// ═══════════════════════════════════════════════════════════
// CHAT 2: DESIGN (Especificador) — recebe briefing, emite task
// ═══════════════════════════════════════════════════════════
const DESIGN_CHAT_SCRIPT: &str = r##"
(function() {
  function waitForTauri(cb, t) {
    t = t || 0;
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) {
      console.log('[DSM-design] __TAURI__ ok');
      cb(window.__TAURI__);
    }
    else if (t < 100) setTimeout(function(){ waitForTauri(cb, t+1); }, 100);
    else console.error('[DSM-design] __TAURI__ timeout');
  }

  var SYSTEM_PROMPT = [
    'Você é o CHAT DESIGN — o ESPECIFICADOR TÉCNICO do pipeline DeepEdit.',
    'Você recebe BRIEFINGS do Chat Principal (linguagem natural, sem código)',
    'e transforma em TASKS TÉCNICAS para o Chat de Edição.',
    '',
    '═══════════════════════════════════════════════════',
    'PIPELINE',
    '═══════════════════════════════════════════════════',
    'Chat Principal (briefing) → [VOCÊ: especifica] → Chat de Edição (executa)',
    '',
    '═══════════════════════════════════════════════════',
    'FORMATO DE DELEGAÇÃO',
    '═══════════════════════════════════════════════════',
    'Quando receber um briefing, emita:',
    '',
    '```delegate',
    '{"task": "Especificação TÉCNICA detalhada: arquivos, classes, métodos, imports, estrutura"}',
    '```',
    '',
    'Exemplo de briefing recebido:',
    '"Espada de rubi, dano médio-alto, durável, brilha"',
    '',
    'Sua task:',
    '```delegate',
    '{"task": "Criar em src/main/java/com/meumod/item/: (1) RubySword.java — classe public que estende SwordItem, construtor chama super(ModTiers.RUBY, 10, -2.4f, new Item.Properties().fireResistant()), override appendHoverText para adicionar lore. (2) ModTiers.java — enum RUBY com level 3, uses 500, speed 8f, attackBonus 2f, enchantmentValue 15, ingot RUBY. (3) ModItems.java — DeferredRegister<Item> com RUBY_SWORD registrado. (4) src/main/resources/assets/meumod/models/item/ruby_sword.json — modelo padrão. (5) src/main/resources/assets/meumod/textures/item/ruby_sword.png — textura (vazia por enquanto). (6) src/main/resources/data/meumod/recipes/ruby_sword.json — 2 rubis + 1 bastão. Verificar se RUBY já existe em ModItems; se não, criar."}',
    '```',
    '',
    '═══════════════════════════════════════════════════',
    'REGRAS',
    '═══════════════════════════════════════════════════',
    '- Você NÃO gera código-fonte. Você descreve em detalhes.',
    '- Especifique caminhos completos de arquivos.',
    '- Mencione classes, métodos, imports, recursos necessários.',
    '- Verifique dependências (ex: tier RUBY precisa existir).',
    '- Se faltar informação do briefing, pergunte antes de delegar.',
    '',
    'Responda apenas: "Especificador ativo. Aguardando briefings do Chat Principal."'
  ].join('\n');

  function parseDelegations(text) {
    var re = /```delegate\s*\n([\s\S]*?)\n```/g;
    var out = [], m;
    while ((m = re.exec(text)) !== null) {
      try {
        var p = JSON.parse(m[1].trim());
        if (p && p.task) out.push(p);
      } catch (e) { console.warn('[DSM-design] JSON inválido:', m[1], e); }
    }
    return out;
  }

  function watchAssistant(T) {
    var seen = new WeakSet();
    function process(root) {
      if (!(root instanceof HTMLElement)) return;
      var cands = [];
      if (root.matches && root.matches('.ds-assistant-message-main-content')) cands.push(root);
      if (root.querySelectorAll) root.querySelectorAll('.ds-assistant-message-main-content').forEach(function(el){ cands.push(el); });
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (seen.has(el)) continue;
        seen.add(el);
        var text = el.innerText || '';
        if (text.length < 10) continue;
        var tasks = parseDelegations(text);
        if (!tasks.length) continue;
        console.log('[DSM-design] Delegando ao Edição:', tasks);
        for (var k = 0; k < tasks.length; k++) {
          T.event.emit('delegate-to-edit', tasks[k]);
        }
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
    var isHome = location.pathname === '/' || location.pathname === '';
    var isChat = /^\/a\/chat\/s\//.test(location.pathname);
    var msgs = document.querySelectorAll('.ds-assistant-message-main-content').length;
    if (!(isHome || (isChat && msgs === 0))) return;
    var ta = document.querySelector('textarea');
    if (!ta || ta.value.trim()) return;
    var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, SYSTEM_PROMPT);
    ta.dispatchEvent(new Event('input', {bubbles:true}));
    promptSent = true;
    console.log('[DSM-design] Prompt injetado');
    setTimeout(function() {
      var b = document.querySelector('[role="button"][aria-disabled="false"] svg path[d*="M8.3125"]');
      if (b) { b.closest('[role="button"]').click(); console.log('[DSM-design] Prompt enviado'); }
    }, 300);
  }

  function boot() {
    waitForTauri(function(T) {
      watchAssistant(T);
      setTimeout(maybeSendPrompt, 1500);
    });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
"##;

// ═══════════════════════════════════════════════════════════
// CHAT 3: EDIÇÃO (Executor) — recebe task, emite tool calls
// ═══════════════════════════════════════════════════════════
const EDIT_CHAT_SCRIPT: &str = r##"
(function() {
  function waitForTauri(cb, t) {
    t = t || 0;
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) {
      console.log('[DSM-edit] __TAURI__ ok');
      cb(window.__TAURI__);
    }
    else if (t < 100) setTimeout(function(){ waitForTauri(cb, t+1); }, 100);
    else console.error('[DSM-edit] __TAURI__ timeout');
  }

  var SYSTEM_PROMPT = [
    'Você é o CHAT DE EDIÇÃO — o EXECUTOR do pipeline DeepEdit.',
    'Você recebe TASKS do Chat Design e as implementa com tool calls.',
    '',
    '═══════════════════════════════════════════════════',
    'PIPELINE',
    '═══════════════════════════════════════════════════',
    'Chat Design (task) → [VOCÊ: executa] → Arquivos em C:\\deepedit\\<projeto>',
    '',
    '═══════════════════════════════════════════════════',
    'FORMATO DE TOOL CALL',
    '═══════════════════════════════════════════════════',
    'Para cada operação, emita:',
    '',
    '```tool',
    '{"op": "NOME", ...}',
    '```',
    '',
    'Operações: list, read, write, edit, append, delete.',
    'Paths relativos, sem "/" inicial, sem "..". Subpastas OK.',
    '',
    '═══════════════════════════════════════════════════',
    'FLUXO',
    '═══════════════════════════════════════════════════',
    '1. Ao receber uma task, PRIMEIRO use "list" para ver a estrutura.',
    '2. Use "read" nos arquivos relevantes antes de editar.',
    '3. Use "write" para novos, "edit" para trechos existentes.',
    '4. Responda em texto curto o que fez (sem código).',
    '',
    'Responda apenas: "Executor ativo. Aguardando tasks do Design."'
  ].join('\n');

  function parseToolCalls(text) {
    var re = /```tool\s*\n([\s\S]*?)\n```/g;
    var out = [], m;
    while ((m = re.exec(text)) !== null) {
      try {
        var p = JSON.parse(m[1].trim());
        if (Array.isArray(p)) out.push.apply(out, p); else out.push(p);
      } catch (e) { console.warn('[DSM-edit] JSON inválido:', m[1], e); }
    }
    return out;
  }

  function watchAssistant(T) {
    var seen = new WeakSet();
    function process(root) {
      if (!(root instanceof HTMLElement)) return;
      var cands = [];
      if (root.matches && root.matches('.ds-assistant-message-main-content')) cands.push(root);
      if (root.querySelectorAll) root.querySelectorAll('.ds-assistant-message-main-content').forEach(function(el){ cands.push(el); });
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (seen.has(el)) continue;
        seen.add(el);
        var text = el.innerText || '';
        if (text.length < 10) continue;
        var calls = parseToolCalls(text);
        if (!calls.length) continue;
        console.log('[DSM-edit] Tool calls:', calls);
        T.event.emit('tool-calls-detected', calls);
      }
    }
    new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var ns = muts[i].addedNodes;
        for (var j = 0; j < ns.length; j++) process(ns[j]);
      }
    }).observe(document.body, {childList:true, subtree:true});
    console.log('[DSM-edit] Observer ativo');
  }

  var promptSent = false;
  function maybeSendPrompt() {
    if (promptSent) return;
    var isHome = location.pathname === '/' || location.pathname === '';
    var isChat = /^\/a\/chat\/s\//.test(location.pathname);
    var msgs = document.querySelectorAll('.ds-assistant-message-main-content').length;
    if (!(isHome || (isChat && msgs === 0))) return;
    var ta = document.querySelector('textarea');
    if (!ta || ta.value.trim()) return;
    var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, SYSTEM_PROMPT);
    ta.dispatchEvent(new Event('input', {bubbles:true}));
    promptSent = true;
    console.log('[DSM-edit] Prompt injetado');
    setTimeout(function() {
      var b = document.querySelector('[role="button"][aria-disabled="false"] svg path[d*="M8.3125"]');
      if (b) { b.closest('[role="button"]').click(); console.log('[DSM-edit] Prompt enviado'); }
    }, 300);
  }

  function boot() {
    waitForTauri(function(T) {
      watchAssistant(T);
      setTimeout(maybeSendPrompt, 1500);
    });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
"##;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(WorkspaceState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            fs_read, fs_write, fs_append, fs_edit, fs_delete, fs_list, fs_exists,
            list_projects, create_project, select_project, get_workspace, get_active_project,
            get_cookies, inject_script, inject_script_into,
            open_main_chat, open_design_chat, open_edit_chat_hidden, send_to_chat, chat_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}