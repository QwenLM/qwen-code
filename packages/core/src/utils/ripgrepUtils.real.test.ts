/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unmocked regression tests that run the real ripgrep binary through
 * runRipgrep(). These exist because the mocked unit tests never observe the
 * trailing JSON summary event that ripgrep emits under --json, which caused
 * the exit-1 no-match gate to misclassify every negative search as
 * incomplete (PR #7888 review).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetRipgrepUtilsCachesForTest,
  getBuiltinRipgrep,
  canUseRipgrep,
  runRipgrep,
} from './ripgrepUtils.js';

const rgPath = getBuiltinRipgrep();
const hasBuiltinRg = rgPath !== null && fs.existsSync(rgPath);

describe.skipIf(!hasBuiltinRg)('runRipgrep with real ripgrep binary', () => {
  let tmpDir: string;
  let emptyPath: string;

  beforeAll(() => {
    _resetRipgrepUtilsCachesForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-real-test-'));
    emptyPath = fs.mkdtempSync(path.join(tmpDir, 'path-'));
    fs.writeFileSync(
      path.join(tmpDir, 'hello.ts'),
      'const greeting = "hello world";\n',
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetRipgrepUtilsCachesForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetRipgrepUtilsCachesForTest();
  });

  it('returns clean no-match result for an absent pattern', async () => {
    vi.stubEnv('PATH', emptyPath);
    const result = await runRipgrep([
      '--json',
      '--no-messages',
      '--path-separator',
      '/',
      '--regexp',
      'zzz_absent_zzz',
      '--threads',
      '4',
      tmpDir,
    ]);

    expect(result.recovery.selectionMode).toBe('builtin');
    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.recovery.retryTriggered).toBe(false);
    expect(result.recovery.failureKind).toBeUndefined();
  });

  it('returns matches for a present pattern', async () => {
    vi.stubEnv('PATH', emptyPath);
    const result = await runRipgrep([
      '--json',
      '--no-messages',
      '--path-separator',
      '/',
      '--regexp',
      'hello',
      '--threads',
      '4',
      tmpDir,
    ]);

    expect(result.recovery.selectionMode).toBe('builtin');
    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('"type":"match"');
    expect(result.stdout).toContain('hello');
  });
  function installSystemWrapper(script: string): () => void {
    const wrapper = path.join(emptyPath, 'rg');
    fs.writeFileSync(wrapper, script, { mode: 0o755 });
    vi.stubEnv('PATH', emptyPath);
    vi.stubEnv('QWEN_TEST_VENDOR_RG', rgPath!);
    return () => fs.rmSync(wrapper, { force: true });
  }

  function search(): ReturnType<typeof runRipgrep> {
    return runRipgrep([
      '--json',
      '--no-messages',
      '--path-separator',
      '/',
      '--ignore-case',
      '--regexp',
      'hello',
      '--threads',
      '4',
      tmpDir,
    ]);
  }

  it.skipIf(process.platform === 'win32')(
    'selects a system wrapper that can emit real JSON matches',
    async () => {
      const cleanup = installSystemWrapper(
        '#!/bin/sh\nexec "$QWEN_TEST_VENDOR_RG" "$@"\n',
      );
      try {
        const result = await search();
        expect(result.recovery.selectionMode).toBe('system');
        expect(result.error).toBeUndefined();
        expect(result.stdout).toContain('"type":"match"');
      } finally {
        cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'falls back for a wrapper that answers --version but lacks --path-separator',
    async () => {
      const cleanup = installSystemWrapper(`#!/bin/sh
case "$*" in *--version*) printf 'ripgrep 12.0.0\\n'; exit 0;; esac
for arg do
  if [ "$arg" = "--path-separator" ]; then
    printf 'rg: unrecognized flag --path-separator\\n' >&2
    exit 2
  fi
done
exec "$QWEN_TEST_VENDOR_RG" "$@"
`);
      try {
        await expect(canUseRipgrep()).resolves.toBe(true);
        const result = await search();
        expect(result.recovery.selectionMode).toBe('builtin');
        expect(result.error).toBeUndefined();
        expect(result.stdout).toContain('"type":"match"');
        await expect(canUseRipgrep(false)).rejects.toThrow('unrecognized flag');
      } finally {
        cleanup();
      }
    },
  );
});
