import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GATE_FILES,
  findStaleGateFiles,
  renderReport,
} from './check-lint-gate-freshness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fakeFetch(handlers, calls = []) {
  return async (path) => {
    calls.push(path);
    for (const [pattern, response] of handlers) {
      if (path.startsWith(pattern)) return response;
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

function commitsResponse(sha) {
  return [
    {
      sha,
      commit: {
        message: `ci: change the gate (#1)\n\nbody`,
        committer: { date: '2026-09-07T00:44:18Z' },
      },
      html_url: `https://github.com/QwenLM/qwen-code/commit/${sha}`,
    },
  ];
}

const BASE_OPTS = {
  repo: 'QwenLM/qwen-code',
  baseRef: 'main',
  headSha: 'f'.repeat(40),
  gateFiles: ['scripts/lint.js'],
};

test('pins the gate file list', () => {
  // Mutation witness: dropping a gate file from the list — lint.js being
  // the file whose --write → --check flip caused #11378 — must redden this
  // assertion, or the check silently stops watching that gate.
  assert.deepEqual(GATE_FILES, [
    'scripts/lint.js',
    'eslint.config.js',
    'eslint.legacy-filenames.mjs',
    '.prettierrc.json',
    '.prettierignore',
    '.github/workflows/ci.yml',
    '.github/scripts/check-lint-gate-freshness.mjs',
  ]);
});

test('passes when the branch contains the base-side gate change', async () => {
  const calls = [];
  const fetchJson = fakeFetch(
    [
      ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
      [
        `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
        { status: 'ahead' },
      ],
    ],
    calls,
  );
  assert.deepEqual(await findStaleGateFiles({ ...BASE_OPTS, fetchJson }), []);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('path=scripts%2Flint.js'));
  assert.ok(calls[0].includes('sha=main'));
  assert.ok(calls[1].endsWith(`...${'f'.repeat(40)}`));
});

test('treats an identical head as contained', async () => {
  const fetchJson = fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
    [
      `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
      { status: 'identical' },
    ],
  ]);
  assert.deepEqual(await findStaleGateFiles({ ...BASE_OPTS, fetchJson }), []);
});

test('flags a diverged compare as stale', async () => {
  const fetchJson = fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
    [
      `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
      { status: 'diverged' },
    ],
  ]);
  const stale = await findStaleGateFiles({ ...BASE_OPTS, fetchJson });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, 'scripts/lint.js');
  assert.equal(stale[0].message, 'ci: change the gate (#1)');
  assert.equal(stale[0].date, '2026-09-07T00:44:18Z');
});

test('flags "behind" as stale: the head is an ancestor of the gate commit', async () => {
  const fetchJson = fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
    [
      `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
      { status: 'behind' },
    ],
  ]);
  const stale = await findStaleGateFiles({ ...BASE_OPTS, fetchJson });
  assert.equal(stale.length, 1);
});

test('skips a gate file that never existed on the base', async () => {
  const calls = [];
  const fetchJson = fakeFetch(
    [['/repos/QwenLM/qwen-code/commits?', []]],
    calls,
  );
  assert.deepEqual(await findStaleGateFiles({ ...BASE_OPTS, fetchJson }), []);
  // No containment compare without a base-side commit.
  assert.equal(calls.length, 1);
});

test('propagates API errors so the caller can fail open', async () => {
  const fetchJson = async () => {
    throw new Error('403 rate limit');
  };
  await assert.rejects(findStaleGateFiles({ ...BASE_OPTS, fetchJson }), /403/);
});

test('report names the file, the commit, and the remedy', () => {
  const report = renderReport(
    [
      {
        file: 'scripts/lint.js',
        sha: 'a'.repeat(40),
        message: 'ci: change the gate (#1)',
        date: '2026-09-07T00:44:18Z',
        url: 'https://github.com/QwenLM/qwen-code/commit/' + 'a'.repeat(40),
      },
    ],
    'main',
  );
  assert.match(report, /scripts\/lint\.js/);
  assert.match(report, /aaaaaaaaaaaa/);
  assert.match(report, /2026-09-07/);
  assert.match(report, /rebase 'main' into this branch/);
});

test('ci.yml wires the check into lint_and_static before the lint lanes', () => {
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  // Slice out the lint_and_static job: from its key to the next job key.
  const jobStart = ci.indexOf('\n  lint_and_static:');
  const jobEnd = ci.indexOf('\n  test_macos:', jobStart);
  assert.ok(jobStart > 0 && jobEnd > jobStart, 'lint_and_static job not found');
  const job = ci.slice(jobStart, jobEnd);

  const step = job.indexOf("- name: 'Check lint gate freshness'");
  assert.ok(step > 0, 'freshness step missing');
  // PRs only: merge_group validates the prospective merged tree (fresh by
  // construction) and push validates the base itself.
  const stepBlock = job.slice(step, job.indexOf('\n      - name:', step + 1));
  assert.ok(
    stepBlock.includes("github.event_name == 'pull_request'"),
    'step must be gated to pull_request',
  );
  assert.ok(
    stepBlock.includes("skip_ci != 'true'"),
    'step must stay running alongside the other no-op-pass lanes on skip_ci',
  );
  assert.ok(
    stepBlock.includes('node .github/scripts/check-lint-gate-freshness.mjs'),
    'step must run the freshness script',
  );
  assert.ok(
    stepBlock.includes('github.event.pull_request.base.ref') &&
      stepBlock.includes('github.event.pull_request.head.sha'),
    'step must pass the PR base ref and head sha',
  );
  // Fail fast: the check costs seconds and must run before the expensive
  // install/lint steps it can make pointless.
  assert.ok(
    step < job.indexOf("- name: 'Run ESLint'"),
    'freshness step must precede Run ESLint',
  );
  assert.ok(
    step < job.indexOf("- name: 'Install dependencies'"),
    'freshness step must precede Install dependencies',
  );
});
