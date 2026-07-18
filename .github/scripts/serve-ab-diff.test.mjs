/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildComment,
  diffCaptureDirs,
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
  assert.match(md, /No response change vs the PR base/);
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
  assert.match(
    body,
    /No response changes against the PR base across 2 scenario/,
  );
  assert.doesNotMatch(body, /\| field \|/);
});

test('diffCaptureDirs: diffs each scenario against its same-named base file', () => {
  const before = mkdtempSync(join(tmpdir(), 'sa-before-'));
  const after = mkdtempSync(join(tmpdir(), 'sa-after-'));
  writeFileSync(
    join(before, 'capabilities.json'),
    JSON.stringify({ v: 1, features: ['a'] }),
  );
  writeFileSync(
    join(after, 'capabilities.json'),
    JSON.stringify({ v: 1, features: ['a', 'b'] }),
  );
  writeFileSync(join(before, 'health.json'), JSON.stringify({ status: 'ok' }));
  writeFileSync(join(after, 'health.json'), JSON.stringify({ status: 'ok' }));
  const { sections, baselineMissing } = diffCaptureDirs(before, after);
  assert.equal(baselineMissing, false);
  assert.deepEqual(sections.map((s) => s.scenario).sort(), [
    'capabilities',
    'health',
  ]);
  assert.deepEqual(
    sections.find((s) => s.scenario === 'capabilities').changes,
    [{ path: 'features[]', kind: 'added', after: 'b' }],
  );
  assert.deepEqual(sections.find((s) => s.scenario === 'health').changes, []);
});

test('diffCaptureDirs: absent base + present head → baselineMissing (not "no change")', () => {
  const before = mkdtempSync(join(tmpdir(), 'sa-before-')); // left empty
  const after = mkdtempSync(join(tmpdir(), 'sa-after-'));
  writeFileSync(join(after, 'capabilities.json'), JSON.stringify({ v: 1 }));
  const { baselineMissing } = diffCaptureDirs(before, after);
  assert.equal(baselineMissing, true);
  const body = buildComment([], { shortSha: 'x', baselineMissing: true });
  assert.match(body, /baseline could not be built/);
  assert.doesNotMatch(body, /No response changes/);
});

test('renderTable: escapes pipes + backticks so a value cannot break the table', () => {
  const md = renderTable('x', [
    { path: 'note', kind: 'changed', before: 'a|b', after: '`c`' },
  ]);
  assert.match(md, /a\\\|b/); // pipe backslash-escaped
  assert.match(md, /&#96;c&#96;/); // backtick entity-encoded
  const row = md.split('\n').find((l) => l.includes('`note`'));
  // Exactly the 4 cell separators — the escaped `\|` is not counted.
  assert.equal((row.match(/(?<!\\)\|/g) || []).length, 4);
});

test('diffCaptureDirs: a malformed capture surfaces a clear error (not silent {})', () => {
  const before = mkdtempSync(join(tmpdir(), 'sa-before-'));
  const after = mkdtempSync(join(tmpdir(), 'sa-after-'));
  // Malformed HEAD capture → clear error, not a raw SyntaxError.
  writeFileSync(join(after, 'health.json'), '{ not valid json');
  assert.throws(() => diffCaptureDirs(before, after), /invalid JSON capture/);
  // Existing-but-malformed BASE capture → also surfaces (not silently {} →
  // "everything added").
  writeFileSync(join(after, 'health.json'), JSON.stringify({ status: 'ok' }));
  writeFileSync(join(before, 'health.json'), 'garbage');
  assert.throws(() => diffCaptureDirs(before, after), /invalid JSON capture/);
});

test('diffCaptureDirs: a base-only (removed) scenario is surfaced, not dropped', () => {
  const before = mkdtempSync(join(tmpdir(), 'sa-before-'));
  const after = mkdtempSync(join(tmpdir(), 'sa-after-'));
  writeFileSync(join(before, 'health.json'), JSON.stringify({ status: 'ok' }));
  writeFileSync(join(after, 'health.json'), JSON.stringify({ status: 'ok' }));
  writeFileSync(join(before, 'capabilities.json'), JSON.stringify({ v: 1 })); // gone in head
  const { removed } = diffCaptureDirs(before, after);
  assert.deepEqual(removed, ['capabilities']);
  const body = buildComment([], { shortSha: 'x', removed });
  assert.match(
    body,
    /Present in the base but absent from this PR: `capabilities`/,
  );
});
