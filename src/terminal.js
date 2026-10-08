import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

let currentId = null;
let currentTerm = null;
let currentFit = null;
let unlistenFns = [];
let onDataUnsub = null;

export async function createTerminal(host, cwd) {
  // Mata o anterior
  await destroyTerminal();

  const term = new Terminal({
    fontFamily: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    allowProposedApi: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5',
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  host.innerHTML = '';
  term.open(host);
  fit.fit();

  const id = 'pty-' + Date.now();
  currentId = id;
  currentTerm = term;
  currentFit = fit;

  // Listeners de output
  const unOut = await listen(`pty-output-${id}`, (e) => {
    term.write(e.payload);
  });
  const unExit = await listen(`pty-exit-${id}`, () => {
    term.write('\r\n\x1b[33m[processo encerrado]\x1b[0m\r\n');
  });
  unlistenFns = [unOut, unExit];

  // Input do usuário
  onDataUnsub = term.onData((data) => {
    invoke('write_to_shell', { id, data }).catch(() => {});
  });

  // Resize automático
  const doFit = () => {
    try { fit.fit(); } catch(e) {}
    invoke('resize_shell', {
      id,
      cols: term.cols,
      rows: term.rows,
    }).catch(() => {});
  };
  term.onResize(doFit);

  // ResizeObserver
  const ro = new ResizeObserver(() => {
    clearTimeout(ro._t);
    ro._t = setTimeout(doFit, 80);
  });
  ro.observe(host);
  currentTerm._ro = ro;

  // Spawn do shell
  await invoke('spawn_shell', {
    id,
    cwd: cwd || null,
    cols: term.cols,
    rows: term.rows,
  });

  term.focus();

  return { id, term };
}

export async function destroyTerminal() {
  if (onDataUnsub) { try { onDataUnsub.dispose(); } catch(e) {} onDataUnsub = null; }
  for (const fn of unlistenFns) { try { fn(); } catch(e) {} }
  unlistenFns = [];

  if (currentTerm) {
    try { currentTerm._ro && currentTerm._ro.disconnect(); } catch(e) {}
    try { currentTerm.dispose(); } catch(e) {}
    currentTerm = null;
  }
  if (currentId) {
    try { await invoke('kill_shell', { id: currentId }); } catch(e) {}
    currentId = null;
  }
  currentFit = null;
}

export function fitTerminal() {
  if (currentFit) {
    try { currentFit.fit(); } catch(e) {}
  }
}

export function focusTerminal() {
  if (currentTerm) currentTerm.focus();
}

export function hasTerminal() {
  return currentTerm != null;
}

export function writeToTerminal(text) {
  if (currentTerm) currentTerm.write(text);
}