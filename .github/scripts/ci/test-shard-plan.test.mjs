import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { planShards } from './test-shard-plan.mjs';

const suite = (files, workers = 4) => ({ workers, overheadSeconds: 1, files });
const files = Array.from({ length: 50 }, (_, i) => `src/f${i}.test.ts`);

test('puts every file in exactly one shard', () => {
  const durations = Object.fromEntries(files.map((f, i) => [f, i % 7]));
  for (const count of [1, 2, 3, 8, 60]) {
    const shards = planShards(files, suite(durations), count);
    assert.equal(shards.length, count);
    assert.deepEqual(shards.flat().sort(), [...files].sort());
  }
});

test('plans the same shards whatever order the files arrive in', () => {
  const durations = { 'src/f3.test.ts': 40, 'src/f9.test.ts': 40 };
  assert.deepEqual(
    planShards(files, suite(durations), 8),
    planShards([...files].reverse(), suite(durations), 8),
  );
});

test('spreads the slow files and fills around them', () => {
  const durations = {
    'src/f0.test.ts': 300,
    'src/f1.test.ts': 280,
    'src/f2.test.ts': 100,
    'src/f3.test.ts': 100,
  };
  const shards = planShards(files, suite(durations), 2);
  const shardOf = (file) => shards.findIndex((s) => s.includes(file));
  assert.notEqual(shardOf('src/f0.test.ts'), shardOf('src/f1.test.ts'));
  assert.notEqual(shardOf('src/f2.test.ts'), shardOf('src/f3.test.ts'));
  // Below the slowest shard's finish, the cheap files even out the totals.
  const total = (shard) =>
    shard.reduce((sum, file) => sum + 1 + (durations[file] ?? 0), 0);
  assert.ok(Math.abs(total(shards[0]) - total(shards[1])) <= 1);
});

test('costs a file with no recorded time as the per-file overhead', () => {
  const shards = planShards(['a.test.ts', 'b.test.ts'], suite({}), 2);
  assert.deepEqual(shards, [['a.test.ts'], ['b.test.ts']]);
});

test('test-durations.json describes each suite the sequencer reads', () => {
  const durations = JSON.parse(
    readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(Object.keys(durations).sort(), [
    'integration-tests',
    'packages/cli',
    'packages/core',
  ]);
  for (const { workers, overheadSeconds, files: times } of Object.values(
    durations,
  )) {
    assert.ok(Number.isInteger(workers) && workers > 0);
    assert.ok(overheadSeconds >= 0);
    for (const seconds of Object.values(times)) {
      assert.ok(Number.isInteger(seconds) && seconds > 0);
    }
  }
});
