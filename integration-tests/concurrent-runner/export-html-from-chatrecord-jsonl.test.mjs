/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertRenderableJsonl,
  isMainModule,
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

function legacyEnvelope() {
  return {
    type: 'session_metadata',
    sessionId: 'session-1',
    startTime: '2026-09-05T00:00:00.000Z',
  };
}

test('rejects legacy exported JSONL (session_metadata-first envelope)', () => {
  const legacy = [legacyEnvelope()];

  assert.equal(looksLikeExportJsonl(legacy), true);
  // A legacy envelope is not a ChatRecord, so it can never take the happy path.
  assert.equal(looksLikeChatRecord(legacy[0]), false);
});

test('accepts source ChatRecord JSONL', () => {
  const records = [chatRecord()];

  assert.equal(looksLikeExportJsonl(records), false);
  assert.equal(looksLikeChatRecord(records[0]), true);
});

test('fails closed on legacy exported JSONL with its own remediation hint', () => {
  assert.throws(() => assertRenderableJsonl([legacyEnvelope()]), {
    message:
      'Legacy exported JSONL cannot be rendered safely; provide source ChatRecord JSONL.',
  });
});

test('renders only ChatRecord lines, rejecting empty and unrecognized input', () => {
  const record = chatRecord();

  assert.deepEqual(assertRenderableJsonl([record, { type: 'noise' }]), [
    record,
  ]);
  assert.throws(() => assertRenderableJsonl([]), {
    message: 'Input JSONL is empty.',
  });
  assert.throws(() => assertRenderableJsonl([{ type: 'noise' }]), {
    message: 'Unrecognized JSONL format (expected ChatRecord-per-line).',
  });
});

const exporterPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'export-html-from-chatrecord-jsonl.js',
);
const exporterUrl = pathToFileURL(fs.realpathSync(exporterPath)).href;

test('recognizes a direct main-module invocation', () => {
  assert.equal(isMainModule(exporterPath, exporterUrl), true);
});

test('recognizes a main-module invocation through a symlinked path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-is-main-'));
  try {
    const link = path.join(dir, 'exporter-link.js');
    fs.symlinkSync(exporterPath, link);

    assert.equal(isMainModule(link, exporterUrl), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not treat an imported module as the main module', () => {
  assert.equal(
    isMainModule(
      path.join(path.dirname(exporterPath), 'runner.py'),
      exporterUrl,
    ),
    false,
  );
  assert.equal(isMainModule(undefined, exporterUrl), false);
});
