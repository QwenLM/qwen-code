#!/usr/bin/env node
// Regenerate `client/utils/unicodeConfusables.ts` from the Unicode
// Consortium's confusables.txt (UTS #39 confusable skeletons):
//
//   node scripts/generate-confusables.mjs [source]
//   npx prettier --write client/utils/unicodeConfusables.ts
//
// (the emitted literal is not prettier-formatted; the repo gate is).
// `source` defaults to the latest published confusables.txt URL and may
// be a local file path for offline regeneration. Every entry in the
// file has a single-codepoint source, so the runtime lookup is one
// Map.get per code point; multi-codepoint TARGETS resolve to a string,
// and targets that are themselves sources resolve transitively at
// generation time (TR39's prototype closure), keeping the runtime
// single-pass.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_SOURCE =
  'https://www.unicode.org/Public/security/latest/confusables.txt';
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'client',
  'utils',
  'unicodeConfusables.ts',
);

const source = process.argv[2] ?? DEFAULT_SOURCE;
let text;
if (/^https?:/.test(source)) {
  // An HTTP error page (a 404, a captive portal) parses as zero entries
  // and would silently overwrite the committed table — refuse first.
  const res = await fetch(source);
  if (!res.ok) {
    throw new Error(`fetch ${source}: HTTP ${res.status}`);
  }
  text = await res.text();
} else {
  text = await readFile(source, 'utf8');
}
const version = /# Version:\s*(\S+)/.exec(text)?.[1] ?? 'unknown';

// code-point number -> list of target code-point numbers. Numeric keys:
// 00E9/000E9/00e9 spell one code point — string keys would carry
// duplicate spellings as distinct entries (the later silently winning)
// and defeat the closure's own lookups.
const raw = new Map();
for (const line of text.split('\n')) {
  const body = line.split('#')[0].trim();
  if (!body) continue;
  const [srcField, tgtField] = body.split(';').map((f) => f.trim());
  // A data body without BOTH fields — no `;` at all, or an empty one —
  // is a truncated edit: fail loudly rather than silently dropping the
  // entry (the count floor below cannot see a same-count corruption).
  if (!srcField || !tgtField) {
    throw new Error(`malformed data line: ${line}`);
  }
  const src = srcField.split(/\s+/);
  if (src.length !== 1) continue; // single-codepoint sources only
  // Fail loudly on a mangled token: parseInt silently truncates
  // trailing junk (`0041XYZ` parses as 0x41), so validate the hex shape
  // first — the count floor below cannot see a same-count corruption.
  for (const token of [...src, ...tgtField.split(/\s+/)]) {
    if (!/^[0-9A-Fa-f]{4,6}$/.test(token)) {
      throw new Error(`malformed code point token: ${token}`);
    }
  }
  const srcCp = parseInt(src[0], 16);
  const targets = tgtField.split(/\s+/).map((t) => parseInt(t, 16));
  // A self-map is a semantic no-op: keep it out of the closure graph,
  // where it would read as a cycle and abort the regeneration.
  if (targets.length === 1 && targets[0] === srcCp) continue;
  if (raw.has(srcCp)) {
    throw new Error(`duplicate source code point: ${src[0]}`);
  }
  raw.set(srcCp, targets);
}

const resolve = (targets, depth = 0) => {
  // Fail loudly, never truncate: a chain past the cap or a cycle would
  // emit intermediate targets (or drop both cycle members via the
  // identity skip) while the runtime trusts the closure to be complete.
  if (depth > 5) {
    throw new Error(
      'prototype closure did not converge (chain longer than 5 or cycle in source)',
    );
  }
  let changed = false;
  const out = [];
  for (const cp of targets) {
    const next = raw.get(cp);
    if (next === undefined) {
      out.push(cp);
    } else {
      out.push(...next);
      changed = true;
    }
  }
  return changed ? resolve(out, depth + 1) : out;
};

const closed = new Map();
for (const [src, targets] of raw) {
  // The consumer NFC-normalizes AFTER substitution, so an emitted value
  // whose NFC form is itself a table key would split one TR39 class
  // across two skeletons (U+AB74 -> o+U+031B, whose NFC is U+01A1).
  // Close each prototype under NFC + table until it is a fixed point.
  let resolved = resolve(targets);
  for (let pass = 0; ; pass++) {
    const nfc = [...String.fromCodePoint(...resolved).normalize('NFC')].map(
      (c) => c.codePointAt(0),
    );
    if (
      nfc.length === resolved.length &&
      nfc.every((c, i) => c === resolved[i])
    ) {
      break;
    }
    if (pass >= 3) {
      throw new Error('prototype closure did not converge under NFC');
    }
    resolved = resolve(nfc);
  }
  if (resolved.length === 1 && resolved[0] === src) continue;
  closed.set(String.fromCodePoint(src), String.fromCodePoint(...resolved));
}

// The consumer also folds TABLE-ABSENT halves through NFKC (with a
// per-half table chance) before the final NFC, so a value carrying a
// compatibility shape the table does not list is not a fixed point of
// the runtime fold: a name holding the source char and a name holding
// the value verbatim — ink-identical — would land in two skeletons
// (`%` -> `º/₀`, whose halves NFKC to `o/O`). Close every value under
// the consumer fold, map-wide (one value's fold reads another's entry),
// until stable.
const consumerFold = (value, table) => {
  let out = '';
  for (const ch of value) {
    const direct = table.get(ch);
    if (direct !== undefined) {
      out += direct;
      continue;
    }
    for (const folded of ch.normalize('NFKC')) {
      out += table.get(folded) ?? folded;
    }
  }
  return out.normalize('NFC');
};
for (let pass = 0; ; pass++) {
  let changed = false;
  for (const [src, value] of closed) {
    const folded = consumerFold(value, closed);
    if (folded === src) {
      // The fold collapsed a value onto its own source char: a self-map
      // is a semantic no-op, but it must leave the map HERE — a direct
      // hit and an NFKC miss differ, so every other value's fixed point
      // has to be recomputed against the map without it.
      closed.delete(src);
      changed = true;
      continue;
    }
    if (folded !== value) {
      closed.set(src, folded);
      changed = true;
    }
  }
  if (!changed) break;
  if (pass >= 3) {
    throw new Error(
      'prototype closure did not converge under the consumer fold',
    );
  }
}

// The loop's !changed exit already implies the fixed point; checking it
// directly keeps the invariant a verified fact, not a loop argument.
for (const [src, value] of closed) {
  if (consumerFold(value, closed) !== value) {
    throw new Error(`emitted value not a consumer-fold fixed point: ${src}`);
  }
}

const entries = [...closed];
entries.sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0));

// A truncated/garbage source must never overwrite the committed table
// (confusables.txt carries ~6500 single-codepoint mappings).
if (entries.length < 5000) {
  throw new Error(
    `implausibly small table (${entries.length} entries); aborting overwrite`,
  );
}

// JSON.stringify leaves U+2028/U+2029 raw, and both appear in the
// table — line-break-class characters an editor's "normalize line
// endings" pass or a line-oriented tool would silently rewrite.
const esc = (v) =>
  JSON.stringify(v)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const lines = entries.map(([key, value]) => `  [${esc(key)}, ${esc(value)}],`);
const out = `// Generated by scripts/generate-confusables.mjs from Unicode
// confusables.txt ${version} (UTS #39) — do not edit by hand.
//
// Contains modified data from confusables.txt, © Unicode, Inc. —
// Unicode License V3: https://www.unicode.org/license.txt
//
// The prototype mapping for one code point, resolved transitively at
// generation time: every confusable in an equivalence class maps to the
// class's prototype, so two strings whose per-code-point prototypes
// match render (nearly) identically.
export const CONFUSABLE_PROTOTYPES: ReadonlyMap<string, string> = new Map([
${lines.join('\n')}
]);
`;
await writeFile(OUT, out);
console.log(
  `wrote ${path.relative(process.cwd(), OUT)}: ${entries.length} entries from ${version}`,
);
