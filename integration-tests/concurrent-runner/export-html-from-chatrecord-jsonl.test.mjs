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

import { isMainModule } from './export-html-from-chatrecord-jsonl.js';

// The input gate itself is covered by the vitest suite in
// scripts/tests/export-html-from-chatrecord-jsonl.test.js; this lane only pins
// the main-module check, which that suite cannot exercise without spawning.
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

test('returns false for a path that is not on disk instead of throwing', () => {
  // `runner.py` above exists, so it exercises the realpath success path and
  // leaves the ENOENT fallback unpinned. The fallback is reachable only
  // because the helper is exported, so pin it here: without it a caller
  // passing a stale or mistyped path gets an exception instead of `false`.
  const missingPath = path.join(path.dirname(exporterPath), 'no-such-entry.js');
  assert.equal(fs.existsSync(missingPath), false);
  assert.equal(isMainModule(missingPath, exporterUrl), false);
});
