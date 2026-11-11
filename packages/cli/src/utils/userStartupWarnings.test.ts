/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getUserStartupWarnings } from './userStartupWarnings.js';
import * as os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isFolderTrustEnabled,
  isWorkspaceTrusted,
} from '../config/trustedFolders.js';
import {
  getCompatibilityWarnings,
  WarningPriority,
} from '@qwen-code/core';

// Mock os.homedir to control the home directory in tests
vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    homedir: () => os.homedir(),
    getCompatibilityWarnings: vi.fn().mockReturnValue([]),
    WarningPriority: {
      Low: 'low',
      High: 'high',
    },
  };
});

vi.mock('../config/trustedFolders.js', () => ({
  isFolderTrustEnabled: vi.fn(),
  isWorkspaceTrusted: vi.fn(),
}));

describe('getUserStartupWarnings', () => {
  let testRootDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    homeDir = path.join(testRootDir, 'home');
    await fs.mkdir(homeDir, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(homeDir);
    vi.mocked(isFolderTrustEnabled).mockReturnValue(false);
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: false,
      source: undefined,
    });
    vi.mocked(getCompatibilityWarnings).mockReturnValue([]);
  });

  afterEach(async () => {
    await fs.rm(testRootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('home directory check', () => {
    it('should return a warning when running in home directory', async () => {
      const warnings = await getUserStartupWarnings({}, homeDir);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          id: 'home-directory',
          message: expect.stringContaining(
            'Warning you are running Qwen Code in your home directory',
          ),
          priority: WarningPriority.Low,
        }),
      );
    });

    it('should not return a warning when running in a project directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings({}, projectDir);
      expect(warnings.find((w) => w.id === 'home-directory')).toBeUndefined();
    });

    it('should not return a warning when showHomeDirectoryWarning is false', async () => {
      const warnings = await getUserStartupWarnings(
        { ui: { showHomeDirectoryWarning: false } },
        homeDir,
      );
      expect(warnings.find((w) => w.id === 'home-directory')).toBeUndefined();
    });

    it('should not return a warning when folder trust is enabled and workspace is trusted', async () => {
      vi.mocked(isFolderTrustEnabled).mockReturnValue(true);
      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: true,
        source: 'file',
      });

      const warnings = await getUserStartupWarnings({}, homeDir);
      expect(warnings.find((w) => w.id === 'home-directory')).toBeUndefined();
    });
  });

  describe('root directory check', () => {
    it('should return a warning when running in a root directory', async () => {
      const rootDir = path.parse(testRootDir).root;
      const warnings = await getUserStartupWarnings({}, rootDir);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          id: 'root-directory',
          message: expect.stringContaining('root directory'),
          priority: WarningPriority.High,
        }),
      );
    });

    it('should not return a warning when running in a non-root directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings({}, projectDir);
      expect(warnings.find((w) => w.id === 'root-directory')).toBeUndefined();
    });
  });

  describe('network working directory check', () => {
    it('should warn and name the workspace root when it is a network location', async () => {
      const warnings = await getUserStartupWarnings(
        {},
        '\\\\fileserver\\share\\project',
      );

      expect(warnings).toContainEqual(
        expect.objectContaining({
          id: 'network-working-directory',
          message: expect.stringContaining('\\\\fileserver\\share\\project'),
          priority: WarningPriority.High,
        }),
      );
    });

    it('should name a network directory added via workingDirectories', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);

      const warnings = await getUserStartupWarnings({}, projectDir, {
        workingDirectories: ['\\\\fileserver\\share\\other'],
      });

      const notice = warnings.find(
        (w) => w.id === 'network-working-directory',
      );
      expect(notice?.message).toContain('\\\\fileserver\\share\\other');
      expect(notice?.message).not.toContain(projectDir);
    });

    it('should not warn when every working directory is local', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);

      const warnings = await getUserStartupWarnings({}, projectDir, {
        workingDirectories: [path.join(testRootDir, 'other')],
      });

      expect(
        warnings.find((w) => w.id === 'network-working-directory'),
      ).toBeUndefined();
    });

    it('should not report a filesystem error for a network workspace root', async () => {
      // The home and root checks realpath the workspace. On a network location
      // that either repeats a handshake the launch already performed or throws,
      // which used to surface as a spurious "could not verify" warning.
      const warnings = await getUserStartupWarnings(
        {},
        '\\\\fileserver\\share\\project',
      );

      expect(
        warnings.some((w) => w.message.includes('Could not verify')),
      ).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle errors when checking directory', async () => {
      const nonExistentPath = path.join(testRootDir, 'non-existent');
      const warnings = await getUserStartupWarnings({}, nonExistentPath);
      const expectedMessage =
        'Could not verify the current directory due to a file system error.';
      expect(warnings).toEqual([
        expect.objectContaining({ message: expectedMessage }),
        expect.objectContaining({ message: expectedMessage }),
      ]);
    });
  });

  describe('compatibility warnings', () => {
    it('should include compatibility warnings by default', async () => {
      const compWarning = {
        id: 'comp-1',
        message: 'Comp warning 1',
        priority: WarningPriority.High,
      };
      vi.mocked(getCompatibilityWarnings).mockReturnValue([compWarning]);
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);

      const warnings = await getUserStartupWarnings({}, projectDir);
      expect(warnings).toContainEqual(compWarning);
    });

    it('should not include compatibility warnings when showCompatibilityWarnings is false', async () => {
      const compWarning = {
        id: 'comp-1',
        message: 'Comp warning 1',
        priority: WarningPriority.High,
      };
      vi.mocked(getCompatibilityWarnings).mockReturnValue([compWarning]);
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);

      const warnings = await getUserStartupWarnings(
        { ui: { showCompatibilityWarnings: false } },
        projectDir,
      );
      expect(warnings).not.toContainEqual(compWarning);
    });
  });
});
