#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * compute-pr-size.cjs
 *
 * Compute the "meaningful" changed-line count of a PR by filtering out
 * lockfiles, docs, snapshots, and generated content. Mirrors the
 * exclusion regexes in `.github/workflows/pr-gate.yml`'s PR Size job so
 * both workflows agree on whether a PR exceeds the size threshold.
 *
 * Without this alignment, a PR with 800 real-code lines + 800 lockfile
 * lines would pass pr-gate (meaningful 800 < 1500) but skip AI review
 * (raw 1600 > 1500), giving contributors mixed signals.
 *
 * Filename uses .cjs because the repo's root package.json sets
 * "type": "module".
 *
 * Usage:
 *   compute-pr-size.cjs <pr-json-file>
 *
 * Input: a JSON file produced by `gh pr view <n> --json files,additions,deletions`.
 *        The .files[] array must include {path, additions, deletions} objects.
 *
 * Output (stdout, single line):
 *   <meaningful_changed_lines>
 *
 * Exit codes:
 *   0  success
 *   1  malformed input (file unreadable, JSON parse fail, missing files[])
 *   2  missing args
 */
const fs = require('fs');

// Files whose churn is not a meaningful review burden. Keep this list
// in sync with `.github/workflows/pr-gate.yml`'s `ignored` regexes —
// every entry should correspond to auto-generated or pure-prose content.
const IGNORED_PATTERNS = [
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)yarn\.lock$/,
  /\.generated\./,
  /\.snap$/,
  /^docs\//,
  /^docs-site\//,
  /\.md$/,
  /^integration-tests\/fixtures\//,
  /^packages\/.+\/__snapshots__\//,
];

function isIgnored(filePath) {
  return IGNORED_PATTERNS.some((re) => re.test(filePath));
}

function computeMeaningfulSize(prJson) {
  const files = Array.isArray(prJson.files) ? prJson.files : [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    if (isIgnored(f.path)) continue;
    const adds = typeof f.additions === 'number' ? f.additions : 0;
    const dels = typeof f.deletions === 'number' ? f.deletions : 0;
    total += adds + dels;
  }
  return total;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write(
      'Usage: compute-pr-size.cjs <pr-json-file>\n' +
        '  pr-json-file: output of `gh pr view <n> --json files,additions,deletions`\n',
    );
    process.exit(2);
  }
  const [inputPath] = args;
  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `compute-pr-size: failed to read ${inputPath}: ${err.message}\n`,
    );
    process.exit(1);
  }
  let prJson;
  try {
    prJson = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `compute-pr-size: failed to parse JSON from ${inputPath}: ${err.message}\n`,
    );
    process.exit(1);
  }
  const size = computeMeaningfulSize(prJson);
  process.stdout.write(`${size}\n`);
}

// Export for tests.
module.exports = { computeMeaningfulSize, isIgnored, IGNORED_PATTERNS };

if (require.main === module) {
  main();
}
