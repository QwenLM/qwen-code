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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read + parse a capture file, turning malformed JSON into a CLEAR error (a raw
// SyntaxError doesn't say which capture is bad). Used for both the base and head
// sides so neither can crash opaquely on a truncated/garbage capture.
function readJson(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON capture at ${path}: ${e.message}`);
  }
}

// Leaf keys whose VALUES vary run-to-run (not base→head), so a diff on them is
// noise. Masked paths are ignored. Extend per scenario as richer endpoints are
// added (session ids, createdAt, …).
export const DEFAULT_VOLATILE = [
  /(^|[.\]])(uptime|uptimeMs|startedAt|createdAt|updatedAt|expiresAt|lastActivityAt|idleSince|idleSinceMs|sessionId|clientId|workspaceCwd|workspaceRoot|cwd|timestamp|now|pid|port|elapsed|durationMs|latencyMs|memory|rss|heap)([.[]|$)/i,
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

const fmt = (v) => {
  if (v === undefined) return '—';
  // Escape pipes (which split a GFM table cell) and backticks (which close the
  // code span) so an arbitrary daemon value can't break the table layout.
  const s = JSON.stringify(v).replace(/\|/g, '\\|').replace(/`/g, '&#96;');
  return '`' + s + '`';
};

/** Markdown before/after table for one scenario's diff (or a no-change note). */
export function renderTable(scenario, changes) {
  const out = [];
  out.push(`#### \`${scenario}\``);
  out.push('');
  if (changes.length === 0) {
    out.push('_No response change vs the PR base._');
    out.push('');
    return out.join('\n');
  }
  out.push('| field | PR base (before) | this PR (after) |');
  out.push('| --- | --- | --- |');
  for (const c of changes) {
    const before = c.kind === 'added' ? '—' : fmt(c.before);
    const after = c.kind === 'removed' ? '—' : fmt(c.after);
    const path = (c.path || '(root)').replace(/`/g, '&#96;');
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
  const out = [];
  out.push('<!-- qwen:serve-ab -->');
  out.push('### 🩺 serve daemon A/B');
  out.push(
    `Built the PR base vs this PR head \`${shortSha}\`, drove a fixed endpoint set against each, and diffed the JSON responses. Only fields that changed are shown.`,
  );
  out.push('');
  // Degraded run: head captures exist but the PR-base build/drive produced
  // none. Say so explicitly instead of misreporting every field as "added"
  // (which a `{}` baseline would) — the diff was never actually performed.
  if (ctx.baselineMissing) {
    out.push(
      '⚠️ _The PR-base baseline could not be built this run, so the before/after diff was skipped. Re-run to compare._',
    );
    out.push('');
    out.push('— _Qwen Code · serve A/B_');
    return out.join('\n') + '\n';
  }
  if (ctx.removed?.length) {
    out.push(
      `⚠️ _Present in the base but absent from this PR: ${ctx.removed
        .map((s) => '`' + s + '`')
        .join(', ')} (removed or failed to capture)._`,
    );
    out.push('');
  }
  const changed = sections.filter((s) => s.changes.length > 0);
  if (changed.length === 0) {
    out.push(
      `✅ _No response changes against the PR base across ${sections.length} scenario(s)._`,
    );
    out.push('');
  } else {
    for (const s of changed) out.push(renderTable(s.scenario, s.changes));
  }
  out.push('— _Qwen Code · serve A/B_');
  return out.join('\n') + '\n';
}

/**
 * Read a capture dir's `<scenario>.json` files → `{ sections, baselineMissing }`.
 * Each section diffs an after-capture against the same-named base file. When the
 * base captures are ENTIRELY absent (a failed base build/drive) but head
 * captures exist, `baselineMissing` is set so the caller reports "diff skipped"
 * rather than misreporting every field as added. This is the function the CI
 * `comment` subcommand actually invokes, so it is exported + covered.
 */
export function diffCaptureDirs(beforeDir, afterDir) {
  const jsonFiles = (dir) => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  };
  const afterFiles = jsonFiles(afterDir).sort();
  const beforeFiles = jsonFiles(beforeDir);
  const baselineMissing = afterFiles.length > 0 && beforeFiles.length === 0;
  const afterSet = new Set(afterFiles);
  // Scenarios present in the base but gone from the head — a removed or broken
  // scenario would otherwise vanish silently and lower the "across N" count,
  // masking the regression.
  const removed = beforeFiles
    .filter((f) => !afterSet.has(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  const sections = afterFiles.map((f) => {
    const scenario = f.replace(/\.json$/, '');
    const after = readJson(join(afterDir, f));
    // A missing base file → no baseline for this scenario (fine); but an
    // EXISTING but malformed base must surface (readJson throws) rather than be
    // silently treated as {}, which would report every field as "added".
    const beforePath = join(beforeDir, f);
    const before = existsSync(beforePath) ? readJson(beforePath) : {};
    return { scenario, changes: diffJson(before, after) };
  });
  return { sections, baselineMissing, removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'comment') {
    const [beforeDir, afterDir, shortSha, bodyFile] = rest;
    const { sections, baselineMissing, removed } = diffCaptureDirs(
      beforeDir,
      afterDir,
    );
    writeFileSync(
      bodyFile,
      buildComment(sections, { shortSha, baselineMissing, removed }),
    );
    const total = baselineMissing
      ? 0
      : sections.reduce((n, s) => n + s.changes.length, 0);
    // Log only — nothing gates on this (the publisher posts whenever body.md
    // exists); kept for the CI run log.
    process.stderr.write(`serve-ab: ${total} changed field(s)\n`);
  } else {
    // Single scenario: `serve-ab-diff.mjs <scenario> <beforeJson> <afterJson>`.
    const [beforePath, afterPath] = rest;
    const before = readJson(beforePath);
    const after = readJson(afterPath);
    const changes = diffJson(before, after);
    process.stdout.write(renderTable(cmd, changes) + '\n');
    process.stderr.write(`${changes.length}\n`);
  }
}
