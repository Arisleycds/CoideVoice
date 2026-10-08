import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';

import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

const languageConf = new Compartment();

function languageFor(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['html','htm','xhtml','vue'].includes(ext)) return html();
  if (['css','scss','sass','less'].includes(ext))  return css();
  if (['js','mjs','cjs','jsx','ts','tsx'].includes(ext)) return javascript();
  if (['json'].includes(ext)) return json();
  if (['md','markdown'].includes(ext)) return markdown();
  return [];
}

export function createEditor(parent, opts = {}) {
  const { onChange, onSave, onPosChange, onPalette } = opts;

  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        { key: 'Mod-s', run: () => { onSave?.(); return true; } },
        { key: 'Mod-k', run: () => { onPalette?.(); return true; } },
      ]),
      languageConf.of([]),
      oneDark,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange?.(u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const pos = u.state.selection.main.head;
          const line = u.state.doc.lineAt(pos);
          onPosChange?.({ line: line.number, col: pos - line.from + 1 });
        }
      }),
      EditorView.theme({
        '&': { height: '100%', background: '#0b0d11' },
        '.cm-content': { padding: '10px 0' },
        '.cm-gutters': { background: '#0b0d11', borderRight: '1px solid #232733', color: '#6b7280' },
        '.cm-activeLineGutter': { background: '#16181d', color: '#9aa1ad' },
        '.cm-activeLine': { background: 'rgba(97,175,239,.05)' },
        '.cm-cursor': { borderLeftColor: '#61afef' },
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text, filename = '') => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: languageConf.reconfigure(languageFor(filename)),
      });
    },
    setLanguage: (filename) => {
      view.dispatch({ effects: languageConf.reconfigure(languageFor(filename)) });
    },
    focus: () => view.focus(),
  };
}
