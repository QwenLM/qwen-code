import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'make-manifest.py',
);

describe('make-manifest', () => {
  let root;
  let datasetRoot;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'dsw-swe-manifest-'));
    datasetRoot = join(root, 'dataset');
    mkdirSync(datasetRoot);
    for (let index = 0; index < 500; index += 1) {
      mkdirSync(
        join(datasetRoot, `repo__project-${String(index).padStart(3, '0')}`),
      );
    }
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const run = (...args) =>
    spawnSync(
      'python3',
      [
        scriptPath,
        '--dataset-root',
        datasetRoot,
        '--dataset-revision',
        'verified-revision',
        ...args,
      ],
      { encoding: 'utf8' },
    );

  it('freezes the requested number of sorted instances and revision', () => {
    const output = join(root, 'five.json');
    const result = run('--limit', '5', '--output', output);

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(manifest.dataset_revision, 'verified-revision');
    assert.equal(manifest.expected_instances, 5);
    assert.deepEqual(manifest.instance_ids, [
      'repo__project-000',
      'repo__project-001',
      'repo__project-002',
      'repo__project-003',
      'repo__project-004',
    ]);
  });

  it('selects one explicit known instance', () => {
    const output = join(root, 'one.json');
    const result = run(
      '--limit',
      '1',
      '--instance-id',
      'repo__project-499',
      '--output',
      output,
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(manifest.instance_ids, ['repo__project-499']);
  });

  it('freezes all 500 instances for a full-suite run', () => {
    const output = join(root, 'full.json');
    const result = run('--limit', '500', '--output', output);

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(manifest.expected_instances, 500);
    assert.equal(manifest.instance_ids.length, 500);
    assert.equal(new Set(manifest.instance_ids).size, 500);
  });

  it('rejects an explicit instance when limit is not one', () => {
    const result = run(
      '--limit',
      '5',
      '--instance-id',
      'repo__project-499',
      '--output',
      join(root, 'invalid-limit.json'),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--instance-id requires --limit 1/);
  });

  it('rejects an unknown explicit instance', () => {
    const result = run(
      '--limit',
      '1',
      '--instance-id',
      'repo__project-500',
      '--output',
      join(root, 'unknown.json'),
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown SWE-bench Verified instance/);
  });

  it('rejects a dataset that does not contain exactly 500 instances', () => {
    rmdirSync(join(datasetRoot, 'repo__project-499'));
    const result = run('--limit', '5', '--output', join(root, 'short.json'));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected exactly 500.*found 499/);
    mkdirSync(join(datasetRoot, 'repo__project-499'));
  });
});
