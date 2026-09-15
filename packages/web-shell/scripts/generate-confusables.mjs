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
  const resolved = resolve(targets);
  if (resolved.length === 1 && resolved[0] === src) continue;
  closed.set(String.fromCodePoint(src), String.fromCodePoint(...resolved));
}

// The consumer fold IS the runtime fold (`remoteNameSkeleton`): the
// table answers first on the composed code point, a table-absent code
// point falls back to its canonical parts (each with its own table
// chance) and then to NFKD for the compatibility shapes, and the pass
// repeats to a fixed point under a closing NFC. Every emitted entry has
// to satisfy one equation in it:
//
//   value === runtimeFold(key.normalize('NFD'))
//
// Three failures collapse into that equation. A value that is not a fold
// fixed point puts one ink-identical class in two skeletons: a name
// holding the source char and a name holding the value verbatim land
// apart (`%` -> `º/₀`, whose parts decompose to `o/0` and lift the `0`
// to `O`). A value that is not what the key's OWN decomposed spelling
// folds to makes the skeleton depend on which canonical spelling a
// remote name happens to use (`i\u0146fra` vs `in\u0326fra`): the
// decomposed spelling never offers the composed code point to the direct
// branch, so its parts decide the class and the composed spelling has to
// arrive at the same one. And a fold that cycles never reaches a fixed
// point at all, so what the runtime returns depends on its pass cap's
// parity (`Ț` -> `Ţ`, whose own parts decompose back to `Ț`). Solving
// the equation for the NFD spelling solves the first two — and where
// NFD(key) recomposes to the key, as it does for most entries, it
// degenerates to the plain fixed-point closure, so no class moves that
// need not.

// Solving it in NFD space can leave a value that renders exactly like
// its key (`אָ` -> `אָ`): the Hebrew presentation forms are composition
// exclusions, so the closing NFC never recomposes them. That is not a
// self-map — the arm below compares code points, not ink.

// Mirrors `remoteNameSkeleton`'s own cap: a value that only settles past
// it is one the runtime never reaches. Returns undefined when the fold
// did not settle inside it.
const FOLD_PASSES = 8;
const runtimeFold = (value, table) => {
  let out = value;
  for (let pass = 0; pass < FOLD_PASSES; pass++) {
    let next = '';
    for (const ch of out) {
      const direct = table.get(ch);
      if (direct !== undefined) {
        next += direct;
        continue;
      }
      for (const part of ch.normalize('NFD')) {
        const partDirect = table.get(part);
        if (partDirect !== undefined) {
          next += partDirect;
          continue;
        }
        for (const folded of part.normalize('NFKD')) {
          next += table.get(folded) ?? folded;
        }
      }
    }
    next = next.normalize('NFC');
    if (next === out) return out;
    out = next;
  }
  return undefined;
};
for (let pass = 0; ; pass++) {
  let changed = false;
  for (const [src, value] of closed) {
    const folded = runtimeFold(src.normalize('NFD'), closed);
    if (folded === undefined || folded === src) {
      // The entry cannot stand — the fold either cycled or collapsed
      // the value onto its own source char (a self-map is a semantic
      // no-op) — so it must leave the map HERE: a direct hit and a
      // decomposition miss differ, so every other value's fixed point
      // has to be recomputed against the map without it. Key membership
      // also feeds the tooltip escape (escapeSkeletonNameChars'
      // has(ch)), so an arm that ever fires shrinks both surfaces at
      // once — re-check that consumer too.
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
  if (pass >= 12) {
    throw new Error(
      'prototype closure did not converge under the runtime fold',
    );
  }
}

// The loop's !changed exit already implies both halves of the equation;
// checking them directly keeps the invariant a verified fact, not a loop
// argument.
for (const [src, value] of closed) {
  if (
    runtimeFold(value, closed) !== value ||
    runtimeFold(src.normalize('NFD'), closed) !== value
  ) {
    // Code point, not the raw char: a U+2028/U+2029-class source would
    // otherwise print mangled text into the diagnostic.
    throw new Error(
      `emitted value not closed under the runtime fold: U+${src
        .codePointAt(0)
        .toString(16)
        .toUpperCase()}`,
    );
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
