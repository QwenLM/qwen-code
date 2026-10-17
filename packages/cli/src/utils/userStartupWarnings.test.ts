/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getUserStartupWarnings } from './userStartupWarnings.js';
import { canUseRipgrep } from '@qwen-code/qwen-code-core/utils/ripgrepUtils.js';
import * as os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

vi.mock('@qwen-code/qwen-code-core/utils/ripgrepUtils.js', () => ({
  canUseRipgrep: vi.fn(),
}));

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

// The banner is deliberately a single line, so a probe failure only survives in
// the debug log. Spy on the logger to pin that it is actually written rather
// than dropped by the `catch` (review R1-1).
//
// `isEnabled` matches production rather than being hard-coded off: the real
// `createDebugLogger` returns `isEnabled: () => getActiveSession() !== null`,
// and `Config`'s constructor binds a session (`setDebugLogSession(this)`) before
// `getUserStartupWarnings` runs. Modelling the logger as disabled while the spy
// still records is a state the call site never reaches, and it would redden this
// test the moment the idiomatic `if (debugLogger.isEnabled())` guard is added
// around the write (review R3-1).
vi.mock('@qwen-code/qwen-code-core/utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    isEnabled: () => true,
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

describe('getUserStartupWarnings', () => {
  let testRootDir: string;
  let startupOptions: {
    workspaceRoot: string;
    useRipgrep: boolean;
    useBuiltinRipgrep: boolean;
  };

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    startupOptions = {
      workspaceRoot: testRootDir,
      useRipgrep: true,
      useBuiltinRipgrep: true,
    };
    vi.mocked(canUseRipgrep).mockReset();
    vi.mocked(canUseRipgrep).mockResolvedValue(true);
    warnSpy.mockClear();
  });

  afterEach(async () => {
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

  describe('ripgrep availability check', () => {
    const ripgrepWarning = (warnings: string[]): string | undefined =>
      warnings.find((warning) => warning.includes('Ripgrep not available'));

    it('should stay silent when ripgrep is available', async () => {
      vi.mocked(canUseRipgrep).mockResolvedValue(true);
      const warnings = await getUserStartupWarnings(startupOptions);
      expect(ripgrepWarning(warnings)).toBeUndefined();
    });

    it('should report a single actionable line when no usable ripgrep is found', async () => {
      vi.mocked(canUseRipgrep).mockResolvedValue(false);
      const warnings = await getUserStartupWarnings(startupOptions);
      const warning = ripgrepWarning(warnings);
      expect(warning).toBeDefined();
      expect(warning).toContain('built-in grep');
      expect(warning).toContain('Install ripgrep');
      expect(warning!.split('\n')).toHaveLength(1);
    });

    it('should not surface the probe output when the bundled binary cannot run (#13704)', async () => {
      vi.mocked(canUseRipgrep).mockRejectedValue(
        new Error(
          'Command failed: /app/vendor/ripgrep/arm64-linux/rg --version\n' +
            '<jemalloc>: Unsupported system page size\n' +
            '<jemalloc>: Unsupported system page size\n' +
            'memory allocation of 160 bytes failed\n',
        ),
      );
      const warnings = await getUserStartupWarnings(startupOptions);
      const warning = ripgrepWarning(warnings);
      expect(warning).toBeDefined();
      // The probe's loader/allocator diagnostics read like a Qwen Code memory
      // failure, so they must not reach the startup banner.
      expect(warning).not.toContain('jemalloc');
      expect(warning).not.toContain('memory allocation');
      expect(warning).not.toContain('Command failed');
      expect(warning!.split('\n')).toHaveLength(1);
    });

    it('should not probe ripgrep when the user turned it off', async () => {
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        useRipgrep: false,
      });
      expect(canUseRipgrep).not.toHaveBeenCalled();
      expect(ripgrepWarning(warnings)).toBeUndefined();
    });

    it('forwards the configured builtin-ripgrep setting to the probe', async () => {
      // `canUseRipgrep` defaults its own parameter to `true`, so a dropped
      // argument would silently probe the bundled binary even when the user
      // asked for system rg only. Pin both directions (review R1-3).
      await getUserStartupWarnings({
        ...startupOptions,
        useBuiltinRipgrep: true,
      });
      expect(canUseRipgrep).toHaveBeenCalledWith(true);

      vi.mocked(canUseRipgrep).mockClear();
      await getUserStartupWarnings({
        ...startupOptions,
        useBuiltinRipgrep: false,
      });
      expect(canUseRipgrep).toHaveBeenCalledWith(false);
    });

    it('keeps a probe failure in the debug log instead of dropping it', async () => {
      // The quiet banner is only defensible if the reason is recoverable
      // somewhere. On the throw path nothing else records it —
      // `resolveHealthyRipgrep` re-throws a system-rg failure before reaching
      // its own `debugLogger.warn` — so an empty `catch` would lose it entirely
      // (review R1-1).
      vi.mocked(canUseRipgrep).mockRejectedValue(
        new Error('rg: permission denied'),
      );
      const warnings = await getUserStartupWarnings(startupOptions);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('rg: permission denied'),
      );
      // Logging must not leak the reason back into the banner.
      const warning = ripgrepWarning(warnings);
      expect(warning).toBeDefined();
      expect(warning).not.toContain('permission denied');
    });
  });
});
