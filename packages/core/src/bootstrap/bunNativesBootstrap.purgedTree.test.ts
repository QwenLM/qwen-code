/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the "half-purged natives tree" scenario: OS temp cleaners (e.g.
 * macOS dirhelper) delete individual extracted .node files by access time
 * while leaving the runtime dir and its .ready marker behind. The extractor
 * must treat such a tree as broken and re-extract instead of reusing it —
 * otherwise the first sharp import fails and poisons the module cache with
 * a permanent "T is not a function" TypeError.
 *
 * Uses a mocked EMBEDDED_NATIVES map (the real generated file is an empty
 * stub in dev/Vitest runs, which would make the file-presence check vacuous).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NATIVE_REL_KEY = vi.hoisted(
  () => 'node_modules/@img/fake-sharp/lib/fake-sharp.node',
);
const READY_MARKER = '.ready';
const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';

// The mock factory is hoisted, so the embedded source path is resolved
// lazily via a getter reading an env var set in beforeEach.
vi.mock('../generated/embedded-natives-bun.js', () => ({
  EMBEDDED_NATIVES: {
    [NATIVE_REL_KEY]: {
      get path(): string {
        return process.env['CLI_TEST_NATIVE_SRC'] ?? '';
      },
      mode: 0o755,
    },
  },
}));

import { ensureNativesExtracted } from './bunNativesBootstrap.js';

describe('ensureNativesExtracted with embedded native files', () => {
  let base: string;
  let runtimeDir: string;
  let nativeSrc: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'test-natives-purge-test-'));
    runtimeDir = path.join(base, 'cli-natives-vtest-user');
    nativeSrc = path.join(base, 'embedded-fake-sharp.node');
    writeFileSync(nativeSrc, 'native-binary-bytes');
    process.env['CLI_TEST_NATIVE_SRC'] = nativeSrc;
  });

  afterEach(() => {
    delete process.env['CLI_TEST_NATIVE_SRC'];
    rmSync(base, { recursive: true, force: true });
  });

  it('extracts the embedded native file into a fresh tree', () => {
    const result = ensureNativesExtracted(runtimeDir, uid, 'key-1');

    expect(result).toBe(runtimeDir);
    expect(readFileSync(path.join(runtimeDir, NATIVE_REL_KEY), 'utf8')).toBe(
      'native-binary-bytes',
    );
  });

  it('reuses a complete tree whose marker and native files are intact', () => {
    expect(ensureNativesExtracted(runtimeDir, uid, 'key-1')).toBe(runtimeDir);
    const sentinel = path.join(runtimeDir, 'sentinel.txt');
    writeFileSync(sentinel, 'keep me');

    const result = ensureNativesExtracted(runtimeDir, uid, 'key-1');

    expect(result).toBe(runtimeDir);
    // A re-extraction would have replaced the tree and dropped the sentinel.
    expect(existsSync(sentinel)).toBe(true);
  });

  it('re-extracts when the marker matches but a native file was purged', () => {
    // Simulate a tmp cleaner: valid marker, but the .node file is gone.
    mkdirSync(path.join(runtimeDir, path.dirname(NATIVE_REL_KEY)), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(path.join(runtimeDir, READY_MARKER), 'key-1', {
      mode: 0o600,
    });
    const sentinel = path.join(runtimeDir, 'sentinel.txt');
    writeFileSync(sentinel, 'stale');

    const result = ensureNativesExtracted(runtimeDir, uid, 'key-1');

    expect(result).toBe(runtimeDir);
    expect(existsSync(path.join(runtimeDir, NATIVE_REL_KEY))).toBe(true);
    expect(readFileSync(path.join(runtimeDir, READY_MARKER), 'utf8')).toBe(
      'key-1',
    );
    // The half-purged tree must have been wiped, not reused.
    expect(existsSync(sentinel)).toBe(false);
  });
});
