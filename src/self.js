/* Modo self-hosting: programar o DSedit dentro do próprio DSedit */
import { invoke } from '@tauri-apps/api/core';

const IGNORED_DIRS = new Set([
  'target', 'node_modules', '.git', '.svn', '.hg',
  '__pycache__', 'dist', 'build', '.vite', '.next',
  '.cache', '.cargo', '.rustup',
]);

const IGNORED_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', '.DS_Store', 'Thumbs.db',
]);

const RELOAD_RULES = [
  { re: /[\\/]src-tauri[\\/]src[\\/][^\\/]+\.rs$/i, mode: 'rust',
    msg: '🦀 Rust modificado — tauri dev vai recompilar e reiniciar' },
  { re: /[\\/]src-tauri[\\/]Cargo\.toml$/i, mode: 'rust',
    msg: '🦀 Cargo.toml modificado — vai recompilar o app' },
  { re: /[\\/]src-tauri[\\/]tauri\.conf\.json$/i, mode: 'rust',
    msg: '⚙️ tauri.conf.json modificado — vai recompilar' },
  { re: /[\\/]index\.html$/i, mode: 'reload',
    msg: '🔄 index.html salvo — o app vai recarregar' },
  { re: /[\\/]src[\\/][^\\/]+\.(js|mjs|ts)$/i, mode: 'hmr',
    msg: '⚡ JS salvo — Vite faz hot reload' },
  { re: /[\\/]src[\\/][^\\/]+\.css$/i, mode: 'hmr',
    msg: '🎨 CSS salvo — Vite injeta instantaneamente' },
];

export const selfState = {
  active: false,
  rootDir: null,
  lastSelfSave: 0,
};

export async function detectSelfProject() {
  try { return await invoke('find_project_root'); }
  catch (e) { return null; }
}

export function isSelfFile(path, selfRoot) {
  if (!selfRoot || !path) return false;
  const norm = String(path).replace(/\\/g, '/').toLowerCase();
  const root = String(selfRoot).replace(/\\/g, '/').toLowerCase();
  return norm === root || norm.startsWith(root + '/');
}

export function reloadModeFor(path) {
  for (const r of RELOAD_RULES) {
    if (r.re.test(path)) return r;
  }
  return null;
}

export function shouldIgnoreEntry(entry) {
  if (entry.is_dir && IGNORED_DIRS.has(entry.name)) return true;
  if (!entry.is_dir && IGNORED_FILES.has(entry.name)) return true;
  return false;
}