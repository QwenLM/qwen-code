import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(
    new URL('../../workflows/qwen-code-pr-review.yml', import.meta.url),
    'utf8',
  ),
);
const steps = workflow.jobs['review-pr'].steps;
const prepare = steps.find((s) => s.id === 'review_scratch');
const cleanup = steps.find((s) => s.name === 'Clean review scratch directory');
const review = steps.find((s) => s.name === 'Run review');

test('review scratch cleanup runs after artifacts and only removes its own directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-cleanup-test-'));
  const output = join(root, 'output');
  const env = { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output };
  const run = (script, extra = {}) =>
    spawnSync('bash', ['-e', '-c', script], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  try {
    assert.equal(run(prepare.run).status, 0);
    const scratch = readFileSync(output, 'utf8').trim().slice(4);
    const sibling = join(root, 'qwen-review-scratch.other');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'keep'), 'other job');
    mkdirSync(join(scratch, 'verify-copy'));
    writeFileSync(join(scratch, 'verify-copy', 'data'), 'test');
    symlinkSync(sibling, join(scratch, 'outside'));
    assert.equal(run(cleanup.run, { REVIEW_SCRATCH: scratch }).status, 0);
    assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(join(sibling, 'keep')), true);
    assert.equal(run(cleanup.run, { REVIEW_SCRATCH: scratch }).status, 0);
    for (const invalid of [
      root,
      '/tmp',
      `${root}/qwen-review-scratch.x/../qwen-review-scratch.other`,
    ]) {
      assert.notEqual(run(cleanup.run, { REVIEW_SCRATCH: invalid }).status, 0);
    }
    // A replaced top-level directory must unlink the symlink, not its target.
    symlinkSync(sibling, scratch);
    assert.equal(run(cleanup.run, { REVIEW_SCRATCH: scratch }).status, 0);
    assert.equal(existsSync(join(sibling, 'keep')), true);
    assert.match(cleanup.if, /always\(\)/);
    assert.ok(
      steps.indexOf(cleanup) >
        steps.findIndex((s) => s.name === 'Upload review artifacts'),
    );
    assert.equal(review.env.TMPDIR, '${{ steps.review_scratch.outputs.dir }}');
    assert.match(review.run, /--append-system-prompt .*TMPDIR=\$TMPDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
