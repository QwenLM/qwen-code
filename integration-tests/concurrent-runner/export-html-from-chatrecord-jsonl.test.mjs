/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  looksLikeChatRecord,
  looksLikeExportJsonl,
} from './export-html-from-chatrecord-jsonl.js';

function chatRecord(overrides = {}) {
  return {
    uuid: 'uuid-1',
    parentUuid: null,
    sessionId: 'session-1',
    timestamp: '2026-09-05T00:00:00.000Z',
    type: 'user',
    cwd: '/workspace',
    version: '1',
    ...overrides,
  };
}

test('rejects legacy exported JSONL (session_metadata-first envelope)', () => {
  const legacy = [
    {
      type: 'session_metadata',
      sessionId: 'session-1',
      startTime: '2026-09-05T00:00:00.000Z',
    },
  ];

  assert.equal(looksLikeExportJsonl(legacy), true);
  // A legacy envelope is not a ChatRecord, so it can never take the happy path.
  assert.equal(looksLikeChatRecord(legacy[0]), false);
});

test('accepts source ChatRecord JSONL', () => {
  const records = [chatRecord()];

  assert.equal(looksLikeExportJsonl(records), false);
  assert.equal(looksLikeChatRecord(records[0]), true);
});
