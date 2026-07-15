/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComment,
  diffJson,
  isPrimitiveArray,
  maskPath,
  renderTable,
  typeOf,
} from './serve-ab-diff.mjs';

test('typeOf distinguishes null, array, object, primitive', () => {
  assert.equal(typeOf(null), 'null');
  assert.equal(typeOf([1]), 'array');
  assert.equal(typeOf({}), 'object');
  assert.equal(typeOf('x'), 'string');
  assert.equal(typeOf(3), 'number');
});

test('isPrimitiveArray is true only for arrays of non-objects', () => {
  assert.equal(isPrimitiveArray(['a', 'b']), true);
  assert.equal(isPrimitiveArray([1, null, 'x']), true);
  assert.equal(isPrimitiveArray([{ a: 1 }]), false);
  assert.equal(isPrimitiveArray('nope'), false);
});

test('diffJson: identical objects → no changes (backend PR with no impact)', () => {
  const o = { status: 'ok', features: ['a', 'b'], v: 1 };
  assert.deepEqual(diffJson(o, JSON.parse(JSON.stringify(o))), []);
});

test('diffJson: added / removed / changed leaf fields', () => {
  const changes = diffJson({ a: 1, gone: true }, { a: 2, added: 'x' });
  assert.deepEqual(
    changes.sort((x, y) => x.path.localeCompare(y.path)),
    [
      { path: 'a', kind: 'changed', before: 1, after: 2 },
      { path: 'added', kind: 'added', after: 'x' },
      { path: 'gone', kind: 'removed', before: true },
    ],
  );
});

test('diffJson: primitive arrays diff as SETS (one add, not an index shuffle)', () => {
  const changes = diffJson(
    { features: ['a', 'b'] },
    { features: ['a', 'b', 'c'] },
  );
  assert.deepEqual(changes, [
    { path: 'features[]', kind: 'added', after: 'c' },
  ]);
  // A removal:
  assert.deepEqual(diffJson({ f: ['a', 'b'] }, { f: ['a'] }), [
    { path: 'f[]', kind: 'removed', before: 'b' },
  ]);
});

test('diffJson: object arrays diff by index; nested paths are dotted', () => {
  const changes = diffJson(
    { items: [{ id: 1, n: 'a' }] },
    { items: [{ id: 1, n: 'b' }] },
  );
  assert.deepEqual(changes, [
    { path: 'items[0].n', kind: 'changed', before: 'a', after: 'b' },
  ]);
});

test('diffJson: a type change (array → object) is one "changed"', () => {
  assert.deepEqual(diffJson({ x: [] }, { x: {} }), [
    { path: 'x', kind: 'changed', before: [], after: {} },
  ]);
});

test('maskPath / diffJson skips volatile fields (timestamps, pid, uptime …)', () => {
  assert.equal(maskPath('daemon.uptimeMs'), true);
  assert.equal(maskPath('startedAt'), true);
  // Session-lifecycle volatiles (from the create-session scenario).
  assert.equal(maskPath('lastActivityAt'), true);
  assert.equal(maskPath('idleSinceMs'), true);
  assert.equal(maskPath('sessionId'), true);
  assert.equal(maskPath('workspaceCwd'), true);
  // …but the meaningful counts next to them are NOT masked.
  assert.equal(maskPath('sessions'), false); // not `sessionId`
  assert.equal(maskPath('activePrompts'), false);
  assert.equal(maskPath('features'), false);
  // A change only in a volatile field yields no diff.
  assert.deepEqual(
    diffJson({ status: 'ok', uptimeMs: 10 }, { status: 'ok', uptimeMs: 999 }),
    [],
  );
});

test('renderTable: change table has a row per field, escapes paths in code spans', () => {
  const md = renderTable('capabilities', [
    { path: 'features[]', kind: 'added', after: 'sse' },
    {
      path: 'qwenCodeVersion',
      kind: 'changed',
      before: '0.19.9',
      after: '0.19.10',
    },
  ]);
  assert.match(md, /#### `capabilities`/);
  assert.match(md, /\| `features\[\]` \| — \| `"sse"` \|/);
  assert.match(md, /\| `qwenCodeVersion` \| `"0.19.9"` \| `"0.19.10"` \|/);
});

test('renderTable: empty diff → explicit no-change note (not a blank table)', () => {
  const md = renderTable('health', []);
  assert.match(
    md,
    /No response change against `main`|No response change vs `main`/,
  );
  assert.doesNotMatch(md, /\| field \|/);
});

test('buildComment: only changed scenarios get a table; unchanged omitted', () => {
  const body = buildComment(
    [
      {
        scenario: 'capabilities',
        changes: [{ path: 'features[]', kind: 'added', after: 'sse' }],
      },
      { scenario: 'health', changes: [] },
    ],
    { shortSha: 'abc1234' },
  );
  assert.match(body, /<!-- qwen:serve-ab -->/);
  assert.match(body, /serve daemon A\/B/);
  assert.match(body, /abc1234/);
  assert.match(body, /#### `capabilities`/);
  assert.doesNotMatch(body, /#### `health`/); // unchanged scenario omitted
});

test('buildComment: all unchanged → one no-change note, no tables', () => {
  const body = buildComment(
    [
      { scenario: 'health', changes: [] },
      { scenario: 'capabilities', changes: [] },
    ],
    { shortSha: 'deadbee' },
  );
  assert.match(body, /No response changes against `main` across 2 scenario/);
  assert.doesNotMatch(body, /\| field \|/);
});
