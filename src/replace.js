const { invoke } = window.__TAURI__.core;
export const replaceInFile = (path, o, n) => invoke('cmd_edit', { path, oldString: o, newString: n });
export const writeFile = (path, content) => invoke('cmd_write', { path, content });
export const readFile = (path, mode = 'auto') => invoke('cmd_read', { path, mode });
export const deletePath = path => invoke('cmd_delete', { path });
export const getTree = (maxDepth = 3) => invoke('cmd_tree', { maxDepth });
export function parseCommands(text) {
  const re = /@(read|write|edit|delete|tree)\s+(?:"([^"]+)"|'([^']+)')/g;
  return [...text.matchAll(re)].map(m => ({ command: m[1], path: m[2] || m[3] }));
}
