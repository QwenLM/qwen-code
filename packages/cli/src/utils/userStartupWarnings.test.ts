/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { canUseRipgrep } = vi.hoisted(() => ({ canUseRipgrep: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core/utils/ripgrepUtils.js', () => ({
  canUseRipgrep,
}));

import { getUserStartupWarnings } from './userStartupWarnings.js';
import * as os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('getUserStartupWarnings', () => {
  let testRootDir: string;
  let startupOptions: {
    workspaceRoot: string;
    useRipgrep: boolean;
    useBuiltinRipgrep: boolean;
  };

  beforeEach(async () => {
    canUseRipgrep.mockReset().mockResolvedValue(true);
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    startupOptions = {
      workspaceRoot: testRootDir,
      useRipgrep: true,
      useBuiltinRipgrep: true,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testRootDir, { recursive: true, force: true });
  });

  describe('root directory check', () => {
    it('should return a warning when running in a root directory', async () => {
      const rootDir = path.parse(testRootDir).root;
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: rootDir,
      });
      expect(warnings).toContainEqual(
        expect.stringContaining('root directory'),
      );
      expect(warnings).toContainEqual(
        expect.stringContaining('folder structure will be used'),
      );
    });

    it('should not return a warning when running in a non-root directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: projectDir,
      });
      expect(warnings).not.toContainEqual(
        expect.stringContaining('root directory'),
      );
    });
  });

  it('preserves the original ripgrep call without a cancellation signal', async () => {
    await getUserStartupWarnings(startupOptions);
    expect(canUseRipgrep).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('forwards abort and waits for the supported probe to settle', async () => {
    const controller = new AbortController();
    let closeProbe!: () => void;
    canUseRipgrep.mockImplementationOnce(
      (_builtin, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener('abort', () => {
            closeProbe = () => resolve(false);
          });
        }),
    );
    let settled = false;
    const warnings = getUserStartupWarnings({
      ...startupOptions,
      signal: controller.signal,
    }).then((value) => {
      settled = true;
      return value;
    });
    controller.abort();
    await Promise.resolve();
    expect(canUseRipgrep).toHaveBeenCalledExactlyOnceWith(
      true,
      controller.signal,
    );
    expect(settled).toBe(false);
    closeProbe();
    expect(await warnings).toEqual([]);
  });

  it('skips work for an already aborted owner', async () => {
    const controller = new AbortController();
    controller.abort();
    const realpath = vi.spyOn(fs, 'realpath');
    expect(
      await getUserStartupWarnings({
        ...startupOptions,
        signal: controller.signal,
      }),
    ).toEqual([]);
    expect(realpath).not.toHaveBeenCalled();
    expect(canUseRipgrep).not.toHaveBeenCalled();
  });

  it('discards an uncancellable late realpath result after abort', async () => {
    const controller = new AbortController();
    let finish!: (path: string) => void;
    vi.spyOn(fs, 'realpath').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const warnings = getUserStartupWarnings({
      ...startupOptions,
      useRipgrep: false,
      signal: controller.signal,
    });
    controller.abort();
    finish(path.parse(testRootDir).root);
    expect(await warnings).toEqual([]);
  });

  describe('error handling', () => {
    it('should handle errors when checking directory', async () => {
      const nonExistentPath = path.join(testRootDir, 'non-existent');
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: nonExistentPath,
      });
      const expectedWarning =
        'Could not verify the current directory due to a file system error.';
      expect(warnings).toEqual([expectedWarning]);
    });
  });
});
