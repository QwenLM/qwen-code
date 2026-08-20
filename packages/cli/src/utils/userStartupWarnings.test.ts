/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    startupOptions = {
      workspaceRoot: testRootDir,
      useRipgrep: true,
      useBuiltinRipgrep: true,
    };
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
});
