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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetRipgrepUtilsCachesForTest,
  getBuiltinRipgrep,
  runRipgrep,
} from './ripgrepUtils.js';

const rgPath = getBuiltinRipgrep();
const hasBuiltinRg = rgPath !== null && fs.existsSync(rgPath);

describe.skipIf(!hasBuiltinRg)('runRipgrep with real ripgrep binary', () => {
  let tmpDir: string;

  beforeAll(() => {
    _resetRipgrepUtilsCachesForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-real-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'hello.ts'),
      'const greeting = "hello world";\n',
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetRipgrepUtilsCachesForTest();
  });

  it('returns clean no-match result for an absent pattern', async () => {
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

    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.recovery.retryTriggered).toBe(false);
    expect(result.recovery.failureKind).toBeUndefined();
  });

  it('returns matches for a present pattern', async () => {
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

    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('"type":"match"');
    expect(result.stdout).toContain('hello');
  });
});
