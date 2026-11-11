/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
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

import { ensureNativesExtracted } from './bunNativesBootstrap.js';
import { BUN_NATIVE_EXTRACTION_FAILURE_MARKER } from './bunNativesConstants.js';

const READY_MARKER = '.ready';
const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
const isPosixNonRoot = process.platform !== 'win32' && uid !== 0;

describe('ensureNativesExtracted', () => {
  let base: string;
  let runtimeDir: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'test-natives-test-'));
    runtimeDir = path.join(base, 'cli-natives-vtest-user');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore permissions tweaked by the locked-dir test so cleanup succeeds.
    try {
      chmodSync(runtimeDir, 0o700);
    } catch {
      // dir may not exist
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('extracts a fresh tree and writes the ready marker', () => {
    const result = ensureNativesExtracted(runtimeDir, uid, 'key-1');

    expect(result).toBe(runtimeDir);
    expect(readFileSync(path.join(runtimeDir, READY_MARKER), 'utf8')).toBe(
      'key-1',
    );
  });

  it('reuses an existing valid tree without re-extracting', () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(runtimeDir, READY_MARKER), 'key-1', {
      mode: 0o600,
    });
    const sentinel = path.join(runtimeDir, 'sentinel.txt');
    writeFileSync(sentinel, 'keep me');

    const result = ensureNativesExtracted(runtimeDir, uid, 'key-1');

    expect(result).toBe(runtimeDir);
    // A re-extraction would have replaced the tree and dropped the sentinel.
    expect(existsSync(sentinel)).toBe(true);
  });

  it('re-extracts when the ready marker is stale', () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(runtimeDir, READY_MARKER), 'old-key', {
      mode: 0o600,
    });
    const sentinel = path.join(runtimeDir, 'sentinel.txt');
    writeFileSync(sentinel, 'stale');

    const result = ensureNativesExtracted(runtimeDir, uid, 'new-key');

    expect(result).toBe(runtimeDir);
    expect(readFileSync(path.join(runtimeDir, READY_MARKER), 'utf8')).toBe(
      'new-key',
    );
    expect(existsSync(sentinel)).toBe(false);
  });

  it.skipIf(!isPosixNonRoot)(
    'falls back to a process-private dir when the runtime dir cannot be replaced',
    () => {
      // Simulate the reported failure: a stale runtime dir that rmSync cannot
      // delete (Windows file locks / foreign ownership), so renameSync onto it
      // keeps failing. We model the lock with a write-protected directory.
      mkdirSync(path.join(runtimeDir, 'blocker'), {
        recursive: true,
        mode: 0o700,
      });
      chmodSync(runtimeDir, 0o500);

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const result = ensureNativesExtracted(runtimeDir, uid, 'key-1');

      expect(result).not.toBeNull();
      expect(result).not.toBe(runtimeDir);
      expect(result!.startsWith(`${runtimeDir}-p${process.pid}-`)).toBe(true);
      expect(readFileSync(path.join(result!, READY_MARKER), 'utf8')).toBe(
        'key-1',
      );
      // The fallback succeeded, so no user-facing warning must be emitted.
      const warnings = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes(BUN_NATIVE_EXTRACTION_FAILURE_MARKER));
      expect(warnings).toEqual([]);
    },
  );
});
