/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENARIOS,
  chatsDirFor,
  readTranscriptFixture,
  retargetTranscript,
} from './serve-ab-drive.mjs';

test('chatsDirFor mirrors the daemon project-dir layout', () => {
  assert.equal(
    chatsDirFor('/home/runner/work/tmp', '/srv/my project'),
    '/home/runner/work/tmp/.qwen/projects/-srv-my-project/chats',
  );
});

test('chatsDirFor sanitizes every non-alphanumeric character, like sanitizeCwd', () => {
  const dir = chatsDirFor('/h', '/a_b.c/d-e');
  assert.equal(dir, '/h/.qwen/projects/-a-b-c-d-e/chats');
  // No path separators survive from the workspace path: the whole workspace
  // collapses into ONE directory name.
  assert.equal(dir.split('/').filter(Boolean).length, 5);
});

test('the transcript fixture is a genuine user + assistant record pair', () => {
  const records = readTranscriptFixture();
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 'user');
  assert.equal(records[0].message.role, 'user');
  assert.equal(records[1].type, 'assistant');
  // The loader rejects `role: "assistant"` here — it wants `model`. Pinning it
  // keeps a well-meaning edit from turning every staged scenario into a 404.
  assert.equal(records[1].message.role, 'model');
  assert.equal(records[1].parentUuid, records[0].uuid);
});

test('retargetTranscript rewrites sessionId + cwd on every record', () => {
  const out = retargetTranscript(
    readTranscriptFixture(),
    'a0000000-0000-4000-8000-00000000da01',
    '/srv/ws',
  );
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const rec = JSON.parse(line);
    assert.equal(rec.sessionId, 'a0000000-0000-4000-8000-00000000da01');
    assert.equal(rec.cwd, '/srv/ws');
  }
  assert.ok(out.endsWith('\n'), 'JSONL must end with a newline');
});

test('every scenario has a unique name and a hardcoded session id', () => {
  const names = SCENARIOS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  // A random id would differ between the base and head captures (separate
  // processes) and diff as pure noise.
  for (const s of SCENARIOS) {
    assert.ok(
      !/random|Date\.now/.test(String(s.path)),
      `scenario ${s.name} must use a fixed path`,
    );
  }
});

test('restore scenarios never share a session id (an attach also answers 200)', () => {
  const ids = SCENARIOS.filter((s) => s.name.startsWith('session-restore-'))
    .map((s) => /\/session\/([^/]+)\/load/.exec(s.path)?.[1])
    .map((id) => id?.toLowerCase());
  assert.ok(ids.length >= 4, 'expected the staged restore scenarios');
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length);
});

test('the healthy-restore canary asserts its own precondition', () => {
  const canary = SCENARIOS.find((s) => s.name === 'session-restore-healthy');
  assert.ok(canary, 'canary scenario must exist');
  assert.equal(canary.expectStatus, 200);
  assert.equal(typeof canary.fixtures, 'function');
});

test('staged scenarios stage fixtures before they probe', () => {
  for (const s of SCENARIOS) {
    if (!s.name.startsWith('session-restore-')) continue;
    assert.equal(
      typeof s.fixtures,
      'function',
      `${s.name} probes restore state but stages nothing`,
    );
  }
});
