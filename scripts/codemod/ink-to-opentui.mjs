#!/usr/bin/env node
//
// ink-to-opentui.mjs — conservative ink -> opentui JSX codemod (pure Node).
//
// - Dry-run by default: prints a per-file change plan, writes nothing.
// - With --apply, writes changed files in place.
// - Renames <Box>/<Text> to <box>/<text>.
// - Moves known style props into style={{...}} and merges them into an
//   existing plain-object style attribute when present.
// - Anything that cannot be judged safely is reported as MANUAL and left
//   unchanged (per tag, or for the whole file).

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TAGS = { Box: 'box', Text: 'text' };

const STYLE_PROPS = new Set([
  'flexDirection',
  'padding',
  'margin',
  'gap',
  'justifyContent',
  'alignItems',
  'borderStyle',
  'borderColor',
  'backgroundColor',
  'width',
  'height',
  'flexGrow',
  'flexShrink',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);

const IDENT = /[A-Za-z0-9_$]/;
const IDENT_START = /[A-Za-z_$]/;
const isIdentStart = (c) => c !== undefined && IDENT_START.test(c);

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

// Builds a code mask over the source: code[i] === 1 means real code,
// 0 means string/template body/comment. comment[i] === 1 marks comments.
// Template literal interpolations are treated as code.
function buildMask(src) {
  const n = src.length;
  const code = new Uint8Array(n).fill(1);
  const comment = new Uint8Array(n);
  let i = 0;
  let lastCodeChar = '';
  let wordBuf = '';

  // '<' and '>' are deliberately absent: in JSX-bearing sources a '/' right
  // after a closing tag (`</View> ... /`) or an opening bracket would start
  // scanRegex, mask past the tag, and swallow everything up to the next
  // stray '/'. A regex literal after a comparison operator (`a < /re/`) is
  // not a shape real code writes.
  const REGEX_PRECEDING = new Set([
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '~',
    '^',
  ]);
  const REGEX_KEYWORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await',
  ]);

  const mask = (a, b, isComment) => {
    for (let x = a; x < b && x < n; x++) {
      code[x] = 0;
      if (isComment) comment[x] = 1;
    }
  };

  function scanString(quote) {
    const start = i;
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      if (c === '\n') break;
      i++;
    }
    mask(start, i);
    lastCodeChar = quote;
    wordBuf = '';
  }

  function scanTemplateBody() {
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        code[i] = 0;
        if (i + 1 < n) code[i + 1] = 0;
        i += 2;
        continue;
      }
      if (c === '`') {
        code[i] = 0;
        i++;
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        code[i] = 0;
        code[i + 1] = 0;
        i += 2;
        scanInterp();
        continue;
      }
      code[i] = 0;
      i++;
    }
  }

  function scanInterp() {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "'" || c === '"') {
        scanString(c);
        continue;
      }
      if (c === '`') {
        code[i] = 0;
        i++;
        scanTemplateBody();
        continue;
      }
      if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
        scanComment();
        continue;
      }
      if (c === '{') {
        depth++;
        i++;
        continue;
      }
      if (c === '}') {
        if (depth === 0) {
          code[i] = 0;
          i++;
          return;
        }
        depth--;
        i++;
        continue;
      }
      i++;
    }
  }

  function scanComment() {
    const start = i;
    if (src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
    }
    mask(start, i, true);
  }

  function regexAllowed() {
    if (wordBuf !== '') return REGEX_KEYWORDS.has(wordBuf);
    return REGEX_PRECEDING.has(lastCodeChar);
  }

  function scanRegex() {
    const start = i;
    i++;
    let inClass = false;
    let closed = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '\n') break;
      if (inClass) {
        if (c === ']') inClass = false;
        i++;
        continue;
      }
      if (c === '[') {
        inClass = true;
        i++;
        continue;
      }
      if (c === '/') {
        i++;
        closed = true;
        break;
      }
      i++;
    }
    if (!closed) {
      i = start + 1;
      return false;
    }
    while (i < n && /[dgimsuvy]/.test(src[i])) i++;
    mask(start, i);
    return true;
  }

  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"') {
      scanString(c);
      continue;
    }
    if (c === '`') {
      code[i] = 0;
      i++;
      scanTemplateBody();
      lastCodeChar = '`';
      wordBuf = '';
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      scanComment();
      wordBuf = '';
      continue;
    }
    if (c === '/' && regexAllowed() && scanRegex()) {
      lastCodeChar = '/';
      wordBuf = '';
      continue;
    }
    if (IDENT.test(c)) {
      wordBuf += c;
      lastCodeChar = c;
    } else {
      wordBuf = '';
      if (!/\s/.test(c)) lastCodeChar = c;
    }
    i++;
  }

  return { code, comment };
}

// Returns the index of the '}' matching the '{' at openIdx, or -1.
function scanBalanced(src, code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (!code[i]) continue;
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parses the opening tag that starts with '<' at lt. Returns
// { name, nameEnd, attrs, selfClosing, end } or { name, nameEnd, error }.
function parseOpenTag(src, code, comment, lt) {
  const n = src.length;
  let i = lt + 1;
  while (i < n && code[i] && IDENT.test(src[i])) i++;
  const name = src.slice(lt + 1, i);
  const nameEnd = i;
  const attrs = [];

  const skipInsignificant = () => {
    while (i < n) {
      if (code[i]) {
        if (/\s/.test(src[i])) {
          i++;
          continue;
        }
        return true;
      }
      if (comment[i]) {
        i++;
        continue;
      }
      return false;
    }
    return false;
  };

  for (;;) {
    if (!skipInsignificant()) {
      return {
        name,
        nameEnd,
        error:
          i >= n
            ? 'unterminated opening tag'
            : 'unexpected string in opening tag',
      };
    }
    const c = src[i];
    if (c === '>')
      return { name, nameEnd, attrs, selfClosing: false, end: i + 1 };
    if (c === '/' && src[i + 1] === '>') {
      return { name, nameEnd, attrs, selfClosing: true, end: i + 2 };
    }
    if (c === '{') {
      let p = i + 1;
      while (p < n && (comment[p] || (code[p] && /\s/.test(src[p])))) p++;
      if (src.slice(p, p + 3) !== '...') {
        return { name, nameEnd, error: 'expected spread attribute in {...}' };
      }
      const closeIdx = scanBalanced(src, code, i);
      if (closeIdx === -1) {
        return {
          name,
          nameEnd,
          error: 'unbalanced braces in spread attribute',
        };
      }
      attrs.push({ kind: 'spread', start: i, end: closeIdx + 1 });
      i = closeIdx + 1;
      continue;
    }
    if (!isIdentStart(c)) {
      return {
        name,
        nameEnd,
        error: `unexpected character in opening tag: ${JSON.stringify(c)}`,
      };
    }
    const ns = i;
    while (i < n && code[i] && /[A-Za-z0-9_$-]/.test(src[i])) i++;
    const aname = src.slice(ns, i);
    let q = i;
    while (q < n && code[q] && /\s/.test(src[q])) q++;
    if (src[q] === '=') {
      q++;
      while (q < n && code[q] && /\s/.test(src[q])) q++;
      const qc = src[q];
      if (qc === '"' || qc === "'") {
        let r = q + 1;
        while (r < n && src[r] !== qc) {
          if (src[r] === '\\') r++;
          r++;
        }
        if (r >= n)
          return {
            name,
            nameEnd,
            error: `unterminated value for attribute ${aname}`,
          };
        attrs.push({
          kind: 'string',
          name: aname,
          start: ns,
          end: r + 1,
          valueStart: q,
          valueEnd: r + 1,
        });
        i = r + 1;
      } else if (qc === '{') {
        const closeIdx = scanBalanced(src, code, q);
        if (closeIdx === -1) {
          return {
            name,
            nameEnd,
            error: `unbalanced braces in attribute ${aname}`,
          };
        }
        attrs.push({
          kind: 'expr',
          name: aname,
          start: ns,
          end: closeIdx + 1,
          innerStart: q + 1,
          innerEnd: closeIdx,
        });
        i = closeIdx + 1;
      } else {
        return {
          name,
          nameEnd,
          error: `malformed value for attribute ${aname}`,
        };
      }
    } else {
      attrs.push({ kind: 'boolean', name: aname, start: ns, end: i });
    }
  }
}

// Inspects an existing style object literal interior [start, end).
// Returns { keys } or { error } when the interior is too risky to merge.
function analyzeStyleObject(src, code, comment, start, end) {
  const keys = [];
  let i = start;

  const skipWs = () => {
    while (i < end) {
      if (code[i]) {
        if (/\s/.test(src[i])) {
          i++;
          continue;
        }
        return null;
      }
      if (comment[i]) return 'comment inside existing style object';
      return null;
    }
    return null;
  };

  for (;;) {
    let err = skipWs();
    if (err) return { error: err };
    if (i >= end) return { keys };
    if (!code[i]) {
      if (src[i] !== '"' && src[i] !== "'") {
        return { error: 'unsupported expression inside existing style object' };
      }
      const q = src[i];
      let r = i + 1;
      while (r < end && src[r] !== q) {
        if (src[r] === '\\') r++;
        r++;
      }
      if (r >= end)
        return { error: 'unterminated string inside existing style object' };
      keys.push(src.slice(i + 1, r));
      i = r + 1;
    } else {
      const c = src[i];
      if (c === '.' && src.slice(i, i + 3) === '...') {
        return { error: 'spread inside existing style object' };
      }
      if (!/[A-Za-z0-9_$]/.test(c)) {
        return { error: 'unsupported key inside existing style object' };
      }
      let r = i;
      while (r < end && code[r] && IDENT.test(src[r])) r++;
      keys.push(src.slice(i, r));
      i = r;
    }
    err = skipWs();
    if (err) return { error: err };
    if (i >= end || !code[i] || src[i] !== ':') {
      return { error: 'unsupported entry inside existing style object' };
    }
    i++;
    let depth = 0;
    let saw = false;
    while (i < end) {
      if (!code[i]) {
        if (comment[i])
          return { error: 'comment inside existing style object' };
        saw = true;
        i++;
        continue;
      }
      const c = src[i];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0)
          return { error: 'unbalanced value inside existing style object' };
        depth--;
      } else if (c === ',' && depth === 0) {
        break;
      }
      if (!/\s/.test(c)) saw = true;
      i++;
    }
    if (!saw) return { error: 'empty value inside existing style object' };
    if (i < end && code[i] && src[i] === ',') {
      i++;
      continue;
    }
  }
}

// Builds the style-collection plan for one opening tag, or null when there
// is nothing safe to collect (pushing a MANUAL note when applicable).
function planStyleCollection(src, code, comment, open, notes) {
  const attrs = open.attrs;
  const collectedIdx = [];
  let hasSpread = false;
  attrs.forEach((a, idx) => {
    if (a.kind === 'spread') hasSpread = true;
    else if (STYLE_PROPS.has(a.name)) collectedIdx.push(idx);
  });
  if (collectedIdx.length === 0) return null;

  const line = lineOf(src, open.start);
  const tag = `<${open.name}>`;
  const manual = (msg) => {
    notes.push({ line, msg: `${msg} on ${tag} — left for manual migration` });
    return null;
  };

  if (hasSpread) return manual('spread attribute(s) present');
  const seen = new Set();
  for (const idx of collectedIdx) {
    const nm = attrs[idx].name;
    if (seen.has(nm)) return manual(`duplicate style prop '${nm}'`);
    seen.add(nm);
  }
  const styleIdxs = [];
  attrs.forEach((a, idx) => {
    if (a.name === 'style') styleIdxs.push(idx);
  });
  if (styleIdxs.length > 1) return manual('multiple style attributes');

  const entries = [];
  for (const idx of collectedIdx) {
    const a = attrs[idx];
    let raw;
    if (a.kind === 'string') {
      raw = src.slice(a.valueStart, a.valueEnd);
      // A JSX string attribute and the JS string literal it gets pasted
      // into decode '\' escapes and '&…;' entities with opposite
      // semantics (JSX keeps a lone backslash literal and decodes
      // entities; JS re-parses escapes and keeps entities literal), so a
      // value carrying either marker cannot be copied verbatim into the
      // generated style object.
      const inner = raw.length >= 2 ? raw.slice(1, -1) : '';
      if (inner.includes('\\') || inner.includes('&')) {
        return manual(
          `style prop '${a.name}' has a string value with JSX-specific escape/entity semantics`,
        );
      }
    } else if (a.kind === 'expr') {
      raw = src.slice(a.innerStart, a.innerEnd).trim();
      if (raw === '')
        return manual(`empty expression for style prop '${a.name}'`);
    } else {
      return manual(`boolean shorthand style prop '${a.name}'`);
    }
    entries.push(`${a.name}: ${raw}`);
  }

  let slotIdx;
  let merged;
  if (styleIdxs.length === 1) {
    slotIdx = styleIdxs[0];
    const s = attrs[slotIdx];
    if (s.kind !== 'expr')
      return manual('existing style attribute is not an object expression');
    const inner = src.slice(s.innerStart, s.innerEnd);
    const t = inner.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) {
      return manual('existing style attribute is not a plain object literal');
    }
    const objOpen = s.innerStart + inner.indexOf('{');
    const objClose = s.innerStart + inner.lastIndexOf('}');
    const analysis = analyzeStyleObject(
      src,
      code,
      comment,
      objOpen + 1,
      objClose,
    );
    if (analysis.error)
      return manual(`existing style object: ${analysis.error}`);
    const collectedNames = collectedIdx.map((idx) => attrs[idx].name);
    const conflict = analysis.keys.find((k) => collectedNames.includes(k));
    if (conflict !== undefined) {
      return manual(`key '${conflict}' already present in style object`);
    }
    let base = src.slice(objOpen + 1, objClose).trim();
    if (base.endsWith(',')) base = base.slice(0, -1).trimEnd();
    merged =
      base === '' ? entries.join(', ') : `${base}, ${entries.join(', ')}`;
  } else {
    slotIdx = collectedIdx[0];
    merged = entries.join(', ');
  }

  const remove = new Set(collectedIdx.filter((idx) => idx !== slotIdx));
  return {
    slotIdx,
    remove,
    styleText: `style={{ ${merged} }}`,
    count: collectedIdx.length,
  };
}

function renderOpenTag(src, open, plan) {
  const parts = [];
  open.attrs.forEach((a, idx) => {
    if (plan.remove.has(idx)) return;
    if (idx === plan.slotIdx) {
      parts.push(plan.styleText);
      return;
    }
    parts.push(src.slice(a.start, a.end));
  });
  const name = TAGS[open.name];
  return `<${name}${parts.length ? ' ' + parts.join(' ') : ''}${open.selfClosing ? ' />' : '>'}`;
}

// Transforms one source string. Returns
// { output, changed, notes: [{line, msg}], stats: {box, text, propsCollected, styleTags} }.
export function transformSource(src) {
  const { code, comment } = buildMask(src);
  const notes = [];
  const zeroStats = () => ({
    box: 0,
    text: 0,
    propsCollected: 0,
    styleTags: 0,
  });
  const bail = (msg, at) => ({
    output: src,
    changed: false,
    notes: [...notes, { line: lineOf(src, at), msg }],
    stats: zeroStats(),
  });

  const n = src.length;
  const events = [];
  for (let k = 0; k < n; k++) {
    if (!code[k] || src[k] !== '<') continue;
    if (src[k + 1] === '/') {
      let j = k + 2;
      while (j < n && IDENT.test(src[j])) j++;
      const nm = src.slice(k + 2, j);
      if (!(nm in TAGS)) continue;
      let g = j;
      while (g < n && /\s/.test(src[g])) g++;
      if (src[g] !== '>') continue;
      events.push({ type: 'close', name: nm, start: k, end: g + 1 });
      k = g;
      continue;
    }
    if (!isIdentStart(src[k + 1])) continue;
    if (k > 0 && code[k - 1] && IDENT.test(src[k - 1])) continue;
    let j = k + 1;
    while (j < n && IDENT.test(src[j])) j++;
    const nm = src.slice(k + 1, j);
    if (!(nm in TAGS)) continue;
    if (src[j] === '.') {
      notes.push({
        line: lineOf(src, k),
        msg: `member element <${nm}....> — left for manual migration`,
      });
      continue;
    }
    const parsed = parseOpenTag(src, code, comment, k);
    if (parsed.error) {
      return bail(
        `could not parse <${nm}> (${parsed.error}) — file left unchanged`,
        k,
      );
    }
    events.push({ type: 'open', name: nm, start: k, ...parsed });
  }

  const stack = [];
  const elements = [];
  for (const ev of events) {
    if (ev.type === 'open') {
      if (ev.selfClosing) elements.push({ open: ev, close: null });
      else stack.push(ev);
      continue;
    }
    const top = stack.pop();
    if (!top || top.name !== ev.name) {
      return bail(
        `mismatched closing tag </${ev.name}> — file left unchanged`,
        ev.start,
      );
    }
    elements.push({ open: top, close: ev });
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return bail(`unclosed <${top.name}> — file left unchanged`, top.start);
  }

  const stats = zeroStats();
  const edits = [];
  for (const el of elements) {
    const plan = planStyleCollection(src, code, comment, el.open, notes);
    if (plan) {
      edits.push({
        start: el.open.start,
        end: el.open.end,
        text: renderOpenTag(src, el.open, plan),
      });
      stats.propsCollected += plan.count;
      stats.styleTags++;
    } else {
      edits.push({
        start: el.open.start + 1,
        end: el.open.start + 1 + el.open.name.length,
        text: TAGS[el.open.name],
      });
    }
    if (el.close) {
      edits.push({
        start: el.close.start + 2,
        end: el.close.start + 2 + el.close.name.length,
        text: TAGS[el.close.name],
      });
    }
    if (el.open.name === 'Box') stats.box++;
    else stats.text++;
  }

  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let last = 0;
  for (const e of edits) {
    if (e.start < last) return bail('internal error: overlapping edits', 0);
    out += src.slice(last, e.start) + e.text;
    last = e.end;
  }
  out += src.slice(last);

  return { output: out, changed: out !== src, notes, stats };
}

function collectFiles(targets) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.(tsx|jsx)$/.test(ent.name)) push(p);
    }
  };
  for (const t of targets) {
    const st = statSync(t, { throwIfNoEntry: false });
    if (!st) throw new Error(`no such file or directory: ${t}`);
    if (st.isDirectory()) walk(t);
    else if (/\.(tsx|jsx)$/.test(t)) push(t);
    else console.error(`warning: skipping ${t} (not .tsx/.jsx)`);
  }
  return out;
}

function usage() {
  return [
    'Usage: node ink-to-opentui.mjs [--dry-run|--apply] <file-or-dir>...',
    '',
    'Conservative ink -> opentui JSX codemod.',
    '  --dry-run (default)  report planned changes per file, write nothing',
    '  --apply              write changes to files',
    '',
    'Renames <Box>/<Text> to <box>/<text> and moves known style props into',
    'style={{...}}. Anything unsafe is reported as MANUAL and left unchanged.',
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let apply = false;
  const targets = [];
  for (const a of args) {
    if (a === '-h' || a === '--help') {
      process.stdout.write(usage());
      return;
    }
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a.startsWith('-')) {
      console.error(`unknown option: ${a}\n\n${usage()}`);
      process.exit(2);
    } else targets.push(a);
  }
  if (targets.length === 0) {
    console.error(usage());
    process.exit(2);
  }
  let files;
  try {
    files = collectFiles(targets);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error('no .tsx/.jsx input files found');
    process.exit(2);
  }
  const mode = apply ? 'apply' : 'dry-run';
  const totals = {
    files: files.length,
    changed: 0,
    box: 0,
    text: 0,
    props: 0,
    styleTags: 0,
    manual: 0,
  };
  let ioError = false;
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch (err) {
      console.error(`[${mode}] ${f}\n  error: ${err.message}`);
      ioError = true;
      continue;
    }
    const res = transformSource(src);
    console.log(`[${mode}] ${f}`);
    console.log(
      `  rename: ${res.stats.box + res.stats.text} element(s) (box: ${res.stats.box}, text: ${res.stats.text})`,
    );
    console.log(
      `  style: ${res.stats.propsCollected} prop(s) collected into style on ${res.stats.styleTags} tag(s)`,
    );
    for (const note of res.notes)
      console.log(`  MANUAL (line ${note.line}): ${note.msg}`);
    if (!res.changed) console.log('  no changes');
    else if (apply) {
      try {
        writeFileSync(f, res.output);
        console.log('  written');
      } catch (err) {
        console.error(`  error writing file: ${err.message}`);
        ioError = true;
        continue;
      }
    }
    totals.box += res.stats.box;
    totals.text += res.stats.text;
    totals.props += res.stats.propsCollected;
    totals.styleTags += res.stats.styleTags;
    totals.manual += res.notes.length;
    if (res.changed) totals.changed++;
  }
  const suffix = apply ? '' : ' — dry-run, nothing written';
  console.log(
    `Summary (${mode}): ${totals.files} file(s), ${totals.changed} changed, ` +
      `${totals.box + totals.text} element(s) renamed (box: ${totals.box}, text: ${totals.text}), ` +
      `${totals.props} prop(s) collected, ${totals.manual} MANUAL note(s)${suffix}`,
  );
  if (ioError) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
