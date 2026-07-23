#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classify a PR's changed files and decide which core maintainers
 * should be requested for review.
 *
 * Usage (called by the core-review-router workflow):
 *   node .github/scripts/core-review-router.mjs \
 *     --files '<json array of paths>' \
 *     --author '<pr author login>'
 *
 * Outputs a JSON object to stdout:
 *   { "reviewers": ["login1", ...], "reason": "..." }
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MAINTAINERS = [
  'wenshao',
  'tanzhenxin',
  'yiliang114',
  'LaZzyMan',
];
// NOTE: this list is canonical. Keep the YAML `if:` skip-list in sync
// (it cannot read script output); the sync is validated by a test.

const CORE_PREFIX = 'packages/core/';

const TEST_PATTERN = /\.test\.|\.spec\.|__tests__|\.test-utils\./;

const NON_SOURCE_PATTERN =
  /(?:^|\/)(?:package\.json|package-lock\.json|tsconfig[^/]*\.json|\.eslintrc|\.prettierrc|CHANGELOG\.md)$/;

/**
 * Domain expertise: map core sub-paths to the maintainer who knows
 * that area best.  Order matters — first match wins.
 */
const DOMAIN_MAP = [
  [/^packages\/core\/src\/permissions\//, 'LaZzyMan'],
  [/^packages\/core\/src\/confirmation-bus\//, 'LaZzyMan'],
  [/^packages\/core\/src\/memory\//, 'LaZzyMan'],
  [/^packages\/core\/src\/models\//, 'yiliang114'],
  [/^packages\/core\/src\/providers\//, 'yiliang114'],
  [/^packages\/core\/src\/config\//, 'yiliang114'],
  [/^packages\/core\/src\/skills\//, 'wenshao'],
  [/^packages\/core\/src\/subagents\//, 'wenshao'],
  [/^packages\/core\/src\/agents\//, 'wenshao'],
  [/^packages\/core\/src\/hooks\//, 'LaZzyMan'],
  [/^packages\/core\/src\/mcp\//, 'tanzhenxin'],
  [/^packages\/core\/src\/extension\//, 'LaZzyMan'],
  [/^packages\/core\/src\/tools\//, 'tanzhenxin'],
  [/^packages\/core\/src\/core\//, 'tanzhenxin'],
  [
    /^packages\/core\/src\/services\/(?:chatCompression|compaction|microcompaction|postCompact)/,
    'LaZzyMan',
  ],
  [
    /^packages\/core\/src\/utils\/(?:truncation|toolResultDisplayCompaction)/,
    'LaZzyMan',
  ],
];

export function classify(files, author, prNumber = 0) {
  const coreProd = [];
  const coreTest = [];

  for (const f of files) {
    if (!f.startsWith(CORE_PREFIX)) continue;
    if (NON_SOURCE_PATTERN.test(f)) continue;
    if (TEST_PATTERN.test(f)) {
      coreTest.push(f);
    } else {
      coreProd.push(f);
    }
  }

  const totalFiles = files.length;

  if (coreProd.length === 0) {
    return {
      reviewers: [],
      reason:
        coreTest.length > 0
          ? 'core test-only change — no reviewer needed'
          : 'no core files changed',
    };
  }

  const domainExpert = pickDomainExpert(coreProd);
  // When no domain matched, domainExpert is null — the rotated
  // pool below covers the selection via round-robin.
  const pool = MAINTAINERS.filter(
    (m) => m !== author && m !== domainExpert,
  );
  // Rotate pool by PR number so the second reviewer is spread
  // evenly across maintainers instead of always hitting the first.
  const offset = prNumber % pool.length;
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];

  const n = coreProd.length;
  const plural = n === 1 ? 'file' : 'files';
  let count;
  let reason;

  if (n === 1 && n / totalFiles < 0.3) {
    count = 1;
    reason = `incidental core touch (1 prod file, ${((n / totalFiles) * 100).toFixed(0)}% of ${totalFiles} files)`;
  } else if (n <= 2) {
    count = 1;
    reason = `small core change (${n} prod ${plural})`;
  } else {
    count = 2;
    reason = `significant core change (${n} prod ${plural})`;
  }

  const reviewers = [];
  if (domainExpert && domainExpert !== author) {
    reviewers.push(domainExpert);
  }
  for (const m of rotated) {
    if (reviewers.length >= count) break;
    reviewers.push(m);
  }

  return { reviewers, reason };
}

function pickDomainExpert(coreProdFiles) {
  const scores = new Map();
  for (const f of coreProdFiles) {
    for (const [pattern, owner] of DOMAIN_MAP) {
      if (pattern.test(f)) {
        scores.set(owner, (scores.get(owner) ?? 0) + 1);
        break;
      }
    }
  }
  // null means no domain matched — classify() falls back to the
  // round-robin rotated pool instead of a fixed default.
  if (scores.size === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const [owner, score] of scores) {
    if (score > bestScore) {
      best = owner;
      bestScore = score;
    }
  }
  return best;
}

// --- CLI entry point ---
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { values } = parseArgs({
    options: {
      files: { type: 'string' },
      author: { type: 'string', default: '' },
      pr: { type: 'string', default: '0' },
    },
  });

  const files = JSON.parse(values.files ?? '[]');
  const result = classify(files, values.author, Number(values.pr));
  console.log(JSON.stringify({ ...result, maintainers: MAINTAINERS }));
}
