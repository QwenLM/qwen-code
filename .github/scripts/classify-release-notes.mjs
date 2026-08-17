#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INTERNAL_LABELS = new Set([
  'category/development',
  'scope/build-system',
  'scope/ci-cd',
  'scope/github-actions',
  'scope/testing',
]);
const AUTO_LABEL = 'skip-changelog-auto';
const RELEASE_AUTOMATION_RE =
  /^\.github\/.*(?:changelog|release|publish|deploy|sync|prebuild|package|installer|artifact|image|cd-)/i;
const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$|(?:vitest|playwright)(?:\.[^/]+)?\.config\.[^/]+$)/;

export function shouldAutoSkipChangelog({ title, labels = [], files = [] }) {
  const names = labels
    .map((label) =>
      (typeof label === 'string' ? label : label.name).toLowerCase(),
    )
    .filter((name) => name !== AUTO_LABEL);
  if (names.includes('skip-changelog')) return false;

  const subject = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(title.trim());
  const type = subject?.[1].toLowerCase();
  if (
    subject?.[2] ||
    (type
      ? type !== 'ci'
      : !names.some((label) =>
          ['scope/ci-cd', 'scope/github-actions'].includes(label),
        )) ||
    names.includes('bug') ||
    names.includes('breaking-change') ||
    names.some(
      (label) =>
        /^(?:type|category|scope)\//.test(label) && !INTERNAL_LABELS.has(label),
    )
  ) {
    return false;
  }

  return (
    files.length > 0 &&
    files.every(
      (file) =>
        TEST_FILE_RE.test(file) ||
        (!RELEASE_AUTOMATION_RE.test(file) &&
          (file.startsWith('.github/') || file.startsWith('.qwen/'))),
    )
  );
}

function fetchFiles(repo, number) {
  return execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${number}/files`,
      '--jq',
      '.[] | .filename, (.previous_filename // empty)',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GITHUB_REPOSITORY must be set to owner/repo.');
  }

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const prs = Array.isArray(input) ? input : [];
  const labeled = [];
  const unlabeled = [];

  for (const pr of prs) {
    const number = String(pr.number);
    if (!/^[1-9]\d*$/.test(number)) continue;
    try {
      const files = fetchFiles(repo, number);
      const shouldSkip = shouldAutoSkipChangelog({ ...pr, files });
      const hasAutoLabel = pr.labels.some(
        (label) =>
          (typeof label === 'string' ? label : label.name).toLowerCase() ===
          AUTO_LABEL,
      );
      // REST, not `gh pr edit`: that command's GraphQL lookup requests
      // repository.pullRequest.projectCards, which GitHub rejects on gh
      // builds that still send the query — the mutation then exits 1 before
      // applying anything, and this step's continue-on-error turned that
      // into a silent skip on every affected release. The REST label
      // endpoints never touch that query. The label is a path segment in
      // the DELETE, hence encodeURIComponent.
      if (shouldSkip && !hasAutoLabel) {
        execFileSync('gh', [
          'api',
          '-X',
          'POST',
          `repos/${repo}/issues/${number}/labels`,
          '-f',
          `labels[]=${AUTO_LABEL}`,
        ]);
        labeled.push(number);
      } else if (!shouldSkip && hasAutoLabel) {
        execFileSync('gh', [
          'api',
          '-X',
          'DELETE',
          `repos/${repo}/issues/${number}/labels/${encodeURIComponent(AUTO_LABEL)}`,
        ]);
        unlabeled.push(number);
      }
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(
        `::warning::Failed to process PR #${number}: ${error.message}; skipping.\n`,
      );
    }
  }

  if (labeled.length > 0) {
    process.stdout.write(`Labeled: ${labeled.join(', ')}\n`);
  }
  if (unlabeled.length > 0) {
    process.stdout.write(`Unlabeled: ${unlabeled.join(', ')}\n`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
