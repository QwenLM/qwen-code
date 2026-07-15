/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend A/B: structural diff of two daemon JSON captures (base = `main`,
 * head = PR) into a before/after field table — the daemon analog of the
 * web-shell before/after compositor. A scenario drives a fixed endpoint
 * (e.g. GET /capabilities) against both builds; this diffs the responses and
 * shows only the fields that CHANGED. A PR with no response impact → empty
 * diff → "no change".
 *
 * Pure helpers (`typeOf`, `isPrimitiveArray`, `diffJson`, `maskPath`,
 * `renderTable`) are unit-tested. CLI:
 *   node serve-ab-diff.mjs <scenario> <beforeJson> <afterJson>
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Leaf keys whose VALUES vary run-to-run (not base→head), so a diff on them is
// noise. Masked paths are ignored. Extend per scenario as richer endpoints are
// added (session ids, createdAt, …).
export const DEFAULT_VOLATILE = [
  /(^|[.\]])(uptime|uptimeMs|startedAt|timestamp|now|pid|port|elapsed|durationMs|latencyMs|memory|rss|heap)([.[]|$)/i,
];

export function maskPath(path, patterns = DEFAULT_VOLATILE) {
  return patterns.some((re) => re.test(path));
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function isPrimitiveArray(a) {
  return (
    Array.isArray(a) && a.every((v) => v === null || typeof v !== 'object')
  );
}

/**
 * Recursive structural diff → flat list of `{ path, kind, before?, after? }`.
 * Objects compared by key; primitive arrays as SETS (added/removed elements, so
 * an appended capability reads as one add, not an index shuffle); object arrays
 * by index. Volatile leaf paths are skipped.
 */
export function diffJson(before, after, path = '', out = [], opts = {}) {
  const patterns = opts.volatile ?? DEFAULT_VOLATILE;
  if (path && maskPath(path, patterns)) return out;

  if (before === undefined && after !== undefined) {
    out.push({ path, kind: 'added', after });
    return out;
  }
  if (after === undefined && before !== undefined) {
    out.push({ path, kind: 'removed', before });
    return out;
  }

  const tb = typeOf(before);
  const ta = typeOf(after);
  if (tb !== ta) {
    out.push({ path, kind: 'changed', before, after });
    return out;
  }

  if (tb === 'object') {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const k of keys.sort()) {
      const p = path ? `${path}.${k}` : k;
      diffJson(before[k], after[k], p, out, opts);
    }
  } else if (tb === 'array') {
    if (isPrimitiveArray(before) && isPrimitiveArray(after)) {
      const bset = new Set(before);
      const aset = new Set(after);
      for (const v of after)
        if (!bset.has(v))
          out.push({ path: `${path}[]`, kind: 'added', after: v });
      for (const v of before)
        if (!aset.has(v))
          out.push({ path: `${path}[]`, kind: 'removed', before: v });
    } else {
      const n = Math.max(before.length, after.length);
      for (let i = 0; i < n; i++) {
        diffJson(before[i], after[i], `${path}[${i}]`, out, opts);
      }
    }
  } else if (before !== after) {
    out.push({ path, kind: 'changed', before, after });
  }
  return out;
}

const fmt = (v) => (v === undefined ? '—' : '`' + JSON.stringify(v) + '`');

/** Markdown before/after table for one scenario's diff (or a no-change note). */
export function renderTable(scenario, changes) {
  const out = [];
  out.push(`#### \`${scenario}\``);
  out.push('');
  if (changes.length === 0) {
    out.push('_No response change vs `main`._');
    out.push('');
    return out.join('\n');
  }
  out.push('| field | main (before) | this PR (after) |');
  out.push('| --- | --- | --- |');
  for (const c of changes) {
    const before = c.kind === 'added' ? '—' : fmt(c.before);
    const after = c.kind === 'removed' ? '—' : fmt(c.after);
    const path = c.path || '(root)';
    out.push(`| \`${path}\` | ${before} | ${after} |`);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Assemble the full PR comment from per-scenario diffs. `sections` is
 * `[{ scenario, changes }]`. Only scenarios that changed get a table; if none
 * changed, a single "no change" line (the common backend-PR case).
 */
export function buildComment(sections, ctx = {}) {
  const shortSha = String(ctx.shortSha ?? '').replace(/[^\w.-]/g, '');
  const changed = sections.filter((s) => s.changes.length > 0);
  const out = [];
  out.push('<!-- qwen:serve-ab -->');
  out.push('### 🩺 serve daemon A/B');
  out.push(
    `Built \`main\` vs this PR head \`${shortSha}\`, drove a fixed endpoint set against each, and diffed the JSON responses. Only fields that changed are shown.`,
  );
  out.push('');
  if (changed.length === 0) {
    out.push(
      `✅ _No response changes against \`main\` across ${sections.length} scenario(s)._`,
    );
    out.push('');
  } else {
    for (const s of changed) out.push(renderTable(s.scenario, s.changes));
  }
  out.push('— _Qwen Code · serve A/B_');
  return out.join('\n') + '\n';
}

// Read a capture dir's `<scenario>.json` files → `[{ scenario, changes }]`,
// diffing each against the same-named file in the base dir (missing base → all
// fields read as added).
function diffCaptureDirs(beforeDir, afterDir) {
  let names = [];
  try {
    names = readdirSync(afterDir).filter((f) => f.endsWith('.json'));
  } catch {
    // no captures → empty
  }
  return names.sort().map((f) => {
    const scenario = f.replace(/\.json$/, '');
    const after = JSON.parse(readFileSync(join(afterDir, f), 'utf8'));
    let before = {};
    try {
      before = JSON.parse(readFileSync(join(beforeDir, f), 'utf8'));
    } catch {
      // no baseline for this scenario
    }
    return { scenario, changes: diffJson(before, after) };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'comment') {
    const [beforeDir, afterDir, shortSha, bodyFile] = rest;
    const sections = diffCaptureDirs(beforeDir, afterDir);
    writeFileSync(bodyFile, buildComment(sections, { shortSha }));
    const total = sections.reduce((n, s) => n + s.changes.length, 0);
    // stdout = total changed fields (workflow reads it to decide whether to post).
    process.stdout.write(`${total}\n`);
  } else {
    // Single scenario: `serve-ab-diff.mjs <scenario> <beforeJson> <afterJson>`.
    const [beforePath, afterPath] = rest;
    const before = JSON.parse(readFileSync(beforePath, 'utf8'));
    const after = JSON.parse(readFileSync(afterPath, 'utf8'));
    const changes = diffJson(before, after);
    process.stdout.write(renderTable(cmd, changes) + '\n');
    process.stderr.write(`${changes.length}\n`);
  }
}
