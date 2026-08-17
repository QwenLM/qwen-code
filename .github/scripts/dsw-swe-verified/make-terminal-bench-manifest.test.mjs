import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'dsw-tb-manifest-'));
const script = join(dirname(fileURLToPath(import.meta.url)), 'make-terminal-bench-manifest.py');
let archive;

before(() => {
  const tasks = join(root, 'tasks');
  mkdirSync(tasks);
  for (let i = 0; i < 89; i += 1) {
    const task = join(
      tasks,
      `frozen-id-${String(i).padStart(2, '0')}`,
      `task-${String(i).padStart(2, '0')}`,
    );
    mkdirSync(task, { recursive: true });
    writeFileSync(join(task, 'instruction.md'), 'test\n');
  }
  archive = join(root, 'tasks.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', root, 'tasks'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

after(() => rmSync(root, { recursive: true, force: true }));

const run = (...args) => spawnSync('python3', [script, '--archive', archive, ...args], { encoding: 'utf8' });

describe('make-terminal-bench-manifest', () => {
  it('selects one exact task for an end-to-end smoke', () => {
    const output = join(root, 'one.json');
    const result = run('--limit', '1', '--instance-id', 'task-42', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(manifest.expected_instances, 1);
    assert.deepEqual(manifest.instance_ids, ['task-42']);
  });

  it('keeps all 89 tasks for a full release chain', () => {
    const output = join(root, 'full.json');
    const result = run('--limit', '89', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(manifest.expected_instances, 89);
    assert.equal(manifest.instance_ids.length, 89);
  });

  it('rejects an unknown exact task', () => {
    const result = run('--limit', '1', '--instance-id', 'missing', '--output', join(root, 'bad.json'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown Terminal-Bench/);
  });
});
