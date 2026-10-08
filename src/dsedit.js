/* Parser SEARCH/REPLACE do DSEDIT v2 */

const SENTINEL      = '##DSEDIT';
const SEARCH_MARK   = '<<<<<<< SEARCH';
const SEPARATOR     = '=======';
const REPLACE_MARK  = '>>>>>>> REPLACE';

/**
 * Normaliza texto pra comparação fuzzy (remove trailing whitespace,
 * unifica quebras de linha, limpa linhas vazias nas pontas).
 */
function normalizeForMatch(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Procura "search" em "text".
 * Ordem: exato → fuzzy (linha-a-linha ignorando trailing whitespace).
 * Retorna { start, end, method, ambiguous } ou null.
 */
function findSearch(text, search) {
  // 1. Match exato
  const exactIdx = text.indexOf(search);
  if (exactIdx !== -1) {
    const second = text.indexOf(search, exactIdx + 1);
    return {
      start: exactIdx,
      end: exactIdx + search.length,
      method: 'exact',
      ambiguous: second !== -1,
    };
  }

  // 2. Fuzzy linha-a-linha
  const textLines   = text.replace(/\r\n?/g, '\n').split('\n');
  const searchNorm  = normalizeForMatch(search).split('\n')
                        .map(l => l.replace(/[ \t]+$/, ''));

  if (searchNorm.length === 0) return null;

  let bestIdx = -1;
  let count   = 0;

  for (let i = 0; i <= textLines.length - searchNorm.length; i++) {
    let ok = true;
    for (let j = 0; j < searchNorm.length; j++) {
      if (textLines[i + j].replace(/[ \t]+$/, '') !== searchNorm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (bestIdx === -1) bestIdx = i;
      count++;
    }
  }

  if (bestIdx === -1) return null;

  // Converte linha → índice
  let start = 0;
  for (let i = 0; i < bestIdx; i++) start += textLines[i].length + 1;

  let end = start;
  for (let j = 0; j < searchNorm.length; j++) {
    end += textLines[bestIdx + j].length;
    if (j < searchNorm.length - 1) end += 1;
  }

  return {
    start,
    end,
    method: 'fuzzy',
    ambiguous: count > 1,
  };
}

/* ============================================================
   PARSER
   ============================================================ */
export function parseDsEdit(src) {
  const lines  = String(src).replace(/\r\n?/g, '\n').split('\n');
  const ops    = [];
  const errors = [];
  let file     = null;
  let i        = 0;

  // Acha o sentinel
  while (i < lines.length && !lines[i].includes(SENTINEL)) i++;
  if (i >= lines.length) return { ops, errors };
  i++;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (!t || t.startsWith('```')) { i++; continue; }

    // @file <nome>
    if (t.startsWith('@file')) {
      file = t.slice(5).trim().replace(/^["'`]|["'`]$/g, '');
      i++;
      continue;
    }

    // <<<<<<< SEARCH
    if (t === SEARCH_MARK) {
      i++;
      const searchLines = [];
      while (i < lines.length && lines[i].trim() !== SEPARATOR) {
        searchLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) { errors.push('SEARCH sem "======="'); break; }
      i++; // consome =======

      const replaceLines = [];
      while (i < lines.length && lines[i].trim() !== REPLACE_MARK) {
        replaceLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) { errors.push('SEARCH sem ">>>>>>> REPLACE"'); break; }
      i++; // consome >>>>>>> REPLACE

      if (!file) {
        errors.push('SEARCH/REPLACE sem @file anterior');
        continue;
      }

      ops.push({
        op: 'sr',
        file,
        search:  searchLines.join('\n'),
        replace: replaceLines.join('\n'),
      });
      continue;
    }

    i++;
  }

  return { ops, errors };
}

/* ============================================================
   APLICAÇÃO
   ============================================================ */

function applySearchReplace(text, op) {
  // SEARCH vazio = append no final
  if (op.search.length === 0) {
    const sep = text.endsWith('\n') ? '' : '\n';
    return { text: text + sep + op.replace, matchInfo: { method: 'append' } };
  }

  const found = findSearch(text, op.search);
  if (!found) {
    const preview = op.search.slice(0, 80).replace(/\n/g, '⏎');
    throw new Error(`SEARCH não encontrado: "${preview}..."`);
  }

  if (found.ambiguous) {
    console.warn('[dsedit] SEARCH ambíguo (múltiplas ocorrências) — usando a primeira');
  }

  return {
    text: text.slice(0, found.start) + op.replace + text.slice(found.end),
    matchInfo: found,
  };
}

export function applyOpsToFile(original, ops) {
  let text = original;
  for (const op of ops) {
    if (op.op === 'sr') {
      text = applySearchReplace(text, op).text;
    }
  }
  return text;
}

export function previewOps(ops, files) {
  const byFile = new Map();
  for (const o of ops) {
    if (!o.file) throw new Error('operação sem @file');
    if (!byFile.has(o.file)) byFile.set(o.file, []);
    byFile.get(o.file).push(o);
  }

  const result = {};
  for (const [file, list] of byFile) {
    const base = (file in files) ? files[file] : '';
    result[file] = applyOpsToFile(base, list);
  }
  return result;
}

/* ============================================================
   DIFF (inalterado)
   ============================================================ */
export function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const m = A.length, n = B.length;
  if (m * n > 4_000_000) {
    return [
      ...A.map(l => ({ type: 'del', text: l })),
      ...B.map(l => ({ type: 'add', text: l })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = A[i - 1] === B[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
      out.push({ type: 'eq', text: A[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ type: 'add', text: B[j - 1] }); j--;
    } else {
      out.push({ type: 'del', text: A[i - 1] }); i--;
    }
  }
  return out.reverse();
}