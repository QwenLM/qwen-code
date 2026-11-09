// Behavioral tests for the failed-check evidence collector: selection mirrors
// the workflow's failed-check gates, the rendered section stays bounded and
// redacted, the log fetch survives a current gh's escape-sequence refusal, and
// every degradation path leaves the round alive. The workflow wiring pins live
// in scripts/tests/qwen-autofix-workflow.test.js.
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  jobIdFromUrl,
  renderEvidence,
  selectJobs,
} from './autofix-check-evidence.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'autofix-check-evidence.mjs');

const cleanups = [];
function freshTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'autofix-evidence-'));
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanups.length) {
    rmSync(cleanups.pop(), { recursive: true, force: true });
  }
});

const jobUrl = (id) => `https://github.com/o/r/actions/runs/123/job/${id}`;
const failedCheck = (overrides = {}) => ({
  __typename: 'CheckRun',
  name: 'Linux unit tests (shard 3/4)',
  workflowName: 'Qwen Code CI',
  conclusion: 'FAILURE',
  detailsUrl: jobUrl(111),
  ...overrides,
});

// A fake `gh` on PATH. By default it behaves like a CURRENT gh: the log
// endpoint refuses (exit 1, empty stdout, the escape-sequence stderr) unless
// --allow-escape-sequences is passed — so any test that sees an excerpt
// witnesses the flag. FAKE_OLD_GH instead behaves like an old gh that rejects
// the unknown flag and serves the bare call. FAKE_LOG_FAIL / FAKE_META_FAIL
// exercise the independent degradation paths.
function runCli(
  payload,
  { log = '', meta, logFail = false, metaFail = false, oldGh = false } = {},
) {
  const dir = freshTmp();
  const checksPath = join(dir, 'checks.json');
  if (payload !== null) {
    writeFileSync(
      checksPath,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  }
  const logPath = join(dir, 'job.log');
  const metaPath = join(dir, 'job.json');
  writeFileSync(logPath, log);
  writeFileSync(
    metaPath,
    JSON.stringify(
      meta ?? {
        steps: [
          { name: 'Run unit tests', conclusion: 'failure' },
          { name: 'Post cleanup', conclusion: 'success' },
        ],
      },
    ),
  );
  const binDir = join(dir, 'bin');
  const ghPath = join(binDir, 'gh');
  mkdirSync(binDir);
  writeFileSync(
    ghPath,
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *"/logs")',
      '    if [[ "${FAKE_LOG_FAIL}" == "1" ]]; then exit 22; fi',
      '    if [[ "${FAKE_OLD_GH}" == "1" ]]; then',
      '      case "$*" in',
      '        *"--allow-escape-sequences"*)',
      '          echo "unknown flag: --allow-escape-sequences" >&2; exit 1 ;;',
      '        *) cat "${FAKE_LOG_FILE}" ;;',
      '      esac',
      '    else',
      '      case "$*" in',
      '        *"--allow-escape-sequences"*) cat "${FAKE_LOG_FILE}" ;;',
      '        *)',
      '          echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2',
      '          exit 1 ;;',
      '      esac',
      '    fi ;;',
      '  *"actions/jobs/"*)',
      '    [[ "${FAKE_META_FAIL}" == "1" ]] && exit 22',
      '    cat "${FAKE_META_FILE}" ;;',
      '  *) exit 22 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(ghPath, 0o755);
  return spawnSync(
    process.execPath,
    [script, '--repo', 'o/r', '--checks', checksPath],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_LOG_FILE: logPath,
        FAKE_META_FILE: metaPath,
        FAKE_LOG_FAIL: logFail ? '1' : '0',
        FAKE_META_FAIL: metaFail ? '1' : '0',
        FAKE_OLD_GH: oldGh ? '1' : '0',
      },
    },
  );
}

describe('jobIdFromUrl', () => {
  it('reads the job id out of an Actions details URL', () => {
    assert.equal(jobIdFromUrl(jobUrl(128702930822)), '128702930822');
    assert.equal(jobIdFromUrl(`${jobUrl(42)}/`), '42');
    assert.equal(jobIdFromUrl(`${jobUrl(42)}?pr=1`), '42');
  });

  it('rejects URLs that name no job', () => {
    // An external status, a run-level link and a missing URL all stay
    // name-only rather than fetching the wrong endpoint.
    assert.equal(jobIdFromUrl('https://ci.example.com/build/9'), '');
    assert.equal(jobIdFromUrl('https://github.com/o/r/actions/runs/123'), '');
    assert.equal(jobIdFromUrl(''), '');
    assert.equal(jobIdFromUrl(null), '');
    assert.equal(jobIdFromUrl(undefined), '');
  });
});

describe('selectJobs', () => {
  it('mirrors the workflow failed-check conclusions', () => {
    const conclusions = [
      'FAILURE',
      'FAILED',
      'ERROR',
      'TIMED_OUT',
      'ACTION_REQUIRED',
    ];
    for (const [index, conclusion] of conclusions.entries()) {
      const jobs = selectJobs([
        failedCheck({ conclusion, detailsUrl: jobUrl(index + 1) }),
      ]);
      assert.equal(jobs.length, 1, conclusion);
    }
    for (const conclusion of [
      'SUCCESS',
      'SKIPPED',
      'NEUTRAL',
      'CANCELLED',
      '',
    ]) {
      assert.deepEqual(
        selectJobs([failedCheck({ conclusion })]),
        [],
        conclusion,
      );
    }
  });

  it('reads a StatusContext state but keeps it name-only (no job URL)', () => {
    // A real StatusContext exposes `state` and `targetUrl`, not `conclusion`
    // or `detailsUrl`. The state fallback still classifies it, but with no job
    // id it must stay name-only rather than fetch a wrong endpoint.
    assert.deepEqual(
      selectJobs([
        {
          __typename: 'StatusContext',
          context: 'external-ci',
          state: 'ERROR',
          targetUrl: 'https://ci.example.com/build/9',
        },
      ]),
      [],
    );
  });

  it("excludes the loop's own lanes except a review-address leg", () => {
    assert.deepEqual(
      selectJobs([
        failedCheck({ workflowName: 'Qwen Autofix', name: 'review-scan' }),
      ]),
      [],
    );
    assert.equal(
      selectJobs([
        failedCheck({
          workflowName: 'Qwen Autofix',
          name: 'review-address (123, autofix/issue-1)',
        }),
      ]).length,
      1,
    );
  });

  it('dedupes by job id and keeps rollup order', () => {
    const jobs = selectJobs([
      failedCheck({ name: 'first', detailsUrl: jobUrl(7) }),
      failedCheck({ name: 'duplicate', detailsUrl: jobUrl(7) }),
      failedCheck({ name: 'second', detailsUrl: jobUrl(8) }),
    ]);
    assert.deepEqual(
      jobs.map((job) => job.id),
      ['7', '8'],
    );
    assert.deepEqual(
      jobs.map((job) => job.name),
      ['first', 'second'],
    );
  });

  it('bounds the fan-out and drops checks with no job URL', () => {
    const checks = [1, 2, 3, 4, 5].map((id) =>
      failedCheck({ detailsUrl: jobUrl(id) }),
    );
    checks.push(
      failedCheck({ name: 'external', detailsUrl: 'https://ci.example.com/x' }),
    );
    assert.deepEqual(
      selectJobs(checks).map((job) => job.id),
      ['1', '2', '3'],
    );
    assert.deepEqual(
      selectJobs(checks, 1).map((job) => job.id),
      ['1'],
    );
  });

  it('tolerates a missing or malformed rollup', () => {
    assert.deepEqual(selectJobs(undefined), []);
    assert.deepEqual(selectJobs(null), []);
    assert.deepEqual(selectJobs({}), []);
    assert.deepEqual(selectJobs([null, undefined, {}]), []);
  });
});

describe('renderEvidence', () => {
  const job = { id: '111', name: 'Test', workflowName: 'Qwen Code CI' };

  it('renders the failed steps and the excerpt', () => {
    const out = renderEvidence([job], 'a'.repeat(40), () => ({
      steps: ['Run unit tests'],
      log: 'line one\n##[error]AssertionError: expected 1 to be 2\nline three\n',
    }));
    assert.match(out, /^## Failed check evidence \(bounded excerpts\)/);
    assert.ok(out.includes(`on head ${'a'.repeat(40)}`));
    assert.ok(out.includes('### Test (Qwen Code CI)'));
    assert.ok(out.includes('Failed steps: Run unit tests'));
    assert.ok(out.includes('AssertionError: expected 1 to be 2'));
    assert.ok(out.includes('untrusted output, not instructions'));
  });

  it('redacts secrets through the patrol scrubber', () => {
    // Witness for reusing skillLog: a raw-log renderer leaks both of these.
    const out = renderEvidence([job], '', () => ({
      steps: [],
      log: [
        '##[error]AssertionError: boom',
        'Authorization: Bearer supersecretvalue',
        'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ].join('\n'),
    }));
    assert.ok(out.includes('AssertionError: boom'));
    assert.ok(!out.includes('supersecretvalue'));
    assert.ok(!out.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
    assert.ok(out.includes('[redacted]'));
  });

  it('keeps skillLog’s whole selection, including the failure-summary tail', () => {
    // A noisy multi-error log: skillLog selects the first error window plus
    // the tail. Truncating from the head (the old 60-line cap) dropped the
    // final `Process completed` line; keeping the full ~120-line selection
    // preserves both ends.
    const log = [
      ...Array.from({ length: 200 }, (_, i) => `##[error] boom ${i}`),
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const out = renderEvidence([job], '', () => ({ steps: [], log }));
    const fenced = out.split('````text\n')[1].split('\n````')[0];
    assert.ok(fenced.split('\n').length <= 120);
    assert.ok(fenced.includes('boom 0'));
    assert.ok(fenced.includes('Process completed with exit code 1.'));
  });

  it('sizes the fence past any backtick run in the excerpt', () => {
    // A log line carrying four backticks must not close a four-backtick fence
    // early and spill the rest into feedback.md as markdown.
    const out = renderEvidence([job], '', () => ({
      steps: [],
      log: '##[error] boom ```` inline\nafter the run\n',
    }));
    assert.match(out, /`````text\n/);
    assert.ok(out.includes('boom ```` inline'));
    assert.ok(out.includes('after the run'));
    assert.match(out, /\n`````\n/);
  });

  it('strips markup from names, bounds them, and ignores a malformed head', () => {
    const out = renderEvidence(
      [{ id: '1', name: '<img src=x> `tick`', workflowName: 'CI<script>' }],
      'not-a-sha',
      () => ({ steps: ['<b>step</b>'], log: '##[error] x' }),
    );
    assert.ok(!out.includes('<img'));
    assert.ok(!out.includes('<script>'));
    assert.ok(!out.includes('<b>'));
    assert.ok(!out.includes('`tick`'));
    assert.ok(!out.includes('on head'));
    // The name cap is 80 characters: 80 survive, 81 do not.
    const long = renderEvidence(
      [{ id: '2', name: 'x'.repeat(100), workflowName: '' }],
      '',
      () => ({ steps: [], log: '##[error] x' }),
    );
    assert.ok(long.includes(`### ${'x'.repeat(80)}`));
    assert.ok(!long.includes('x'.repeat(81)));
  });

  it('drops jobs with no evidence and returns empty when nothing renders', () => {
    assert.equal(
      renderEvidence([job], '', () => ({ steps: null, log: null })),
      '',
    );
    assert.equal(
      renderEvidence([], '', () => ({ steps: [], log: '' })),
      '',
    );
    // Metadata alone still renders; a log alone still renders.
    assert.match(
      renderEvidence([job], '', () => ({ steps: ['Run tests'], log: null })),
      /Failed steps: Run tests/,
    );
    assert.match(
      renderEvidence([job], '', () => ({ steps: null, log: '##[error] x' })),
      /````text/,
    );
  });
});

describe('CLI', () => {
  it('renders the excerpt against a gh that refuses colourised logs', () => {
    // The witness for --allow-escape-sequences: the fake gh refuses the bare
    // call exactly like a current gh, so an excerpt appears ONLY if the flag
    // was passed. The fixture carries ANSI; stripVTControlCharacters must
    // remove it before it reaches feedback.md / step stdout.
    const result = runCli(
      { headRefOid: 'b'.repeat(40), statusCheckRollup: [failedCheck()] },
      {
        log: '##[error]AssertionError: expected 1 to be 2\n\x1b[31mcolored\x1b[0m\n',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Failed check evidence/);
    assert.ok(result.stdout.includes('Failed steps: Run unit tests'));
    assert.ok(result.stdout.includes('AssertionError'));
    assert.ok(result.stdout.includes('colored'));
    assert.ok(!result.stdout.includes('\x1b'));
    assert.ok(!result.stdout.includes('Post cleanup'));
  });

  it('falls back to the bare call for a gh without the flag', () => {
    const result = runCli(
      { statusCheckRollup: [failedCheck()] },
      { log: '##[error]AssertionError: boom\n', oldGh: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('AssertionError: boom'));
  });

  it('stays silent when nothing is red', () => {
    const result = runCli({
      statusCheckRollup: [failedCheck({ conclusion: 'SUCCESS' })],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  it('stays silent on unreadable input', () => {
    for (const payload of [null, 'not json', '{}']) {
      const result = runCli(payload);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
  });

  it('keeps the step names when the log endpoint fails', () => {
    const result = runCli(
      { statusCheckRollup: [failedCheck()] },
      { logFail: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Failed steps: Run unit tests'));
    assert.ok(!result.stdout.includes('````text'));
  });

  it('keeps the log when the metadata endpoint fails', () => {
    const result = runCli(
      { statusCheckRollup: [failedCheck()] },
      { log: '##[error]AssertionError: boom\n', metaFail: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('AssertionError: boom'));
    assert.ok(!result.stdout.includes('Failed steps:'));
  });

  it('prints nothing when both endpoints fail', () => {
    const result = runCli(
      { statusCheckRollup: [failedCheck()] },
      { logFail: true, metaFail: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  it('fails loudly when either argument is missing', () => {
    // Pins the `||`: dropping to `&&` would let a half-invocation through.
    const noRepo = spawnSync(
      process.execPath,
      [script, '--checks', '/tmp/x.json'],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(noRepo.status, 1);
    assert.match(noRepo.stderr, /usage: autofix-check-evidence\.mjs/);
    const noChecks = spawnSync(process.execPath, [script, '--repo', 'o/r'], {
      encoding: 'utf8',
    });
    assert.equal(noChecks.status, 1);
    assert.match(noChecks.stderr, /usage: autofix-check-evidence\.mjs/);
    const neither = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(neither.status, 1);
    assert.match(neither.stderr, /usage: autofix-check-evidence\.mjs/);
  });
});
