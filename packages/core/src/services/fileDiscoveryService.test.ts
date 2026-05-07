/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the entire module before importing the class under test
vi.mock('../utils/gitUtils.js', () => ({
    isGitRepository: vi.fn(),
    findGitRoot: vi.fn(),
    getGitIgnorePatterns: vi.fn(),
  }));

import * as gitUtils from '../utils/gitUtils.js';
import { FileDiscoveryService } from './fileDiscoveryService.js';

describe('FileDiscoveryService', () => {
  let testRootDir: string;
  let projectRoot: string;

  function createTestFile(filePath: string, content = '') {
    const fullPath = path.join(projectRoot, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  beforeEach(() => {
    testRootDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'file-discovery-test-')),
    );
    projectRoot = path.join(testRootDir, 'project');
    fs.mkdirSync(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(testRootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize git ignore parser by default in a git repo', () => {
      vi.mocked(gitUtils.isGitRepository).mockReturnValue(true);
      createTestFile('.gitignore', 'node_modules');

      const service = new FileDiscoveryService(projectRoot);
      expect(
        service.shouldGitIgnoreFile(
          path.join(projectRoot, 'node_modules/foo.js'),
        ),
      ).toBe(true);
    });

    it('should not load git repo patterns when not in a git repo', () => {
      vi.mocked(gitUtils.isGitRepository).mockReturnValue(false);
      createTestFile('.gitignore', 'node_modules');
      const service = new FileDiscoveryService(projectRoot);

      expect(
        service.shouldGitIgnoreFile(
          path.join(projectRoot, 'node_modules/foo.js'),
        ),
      ).toBe(false);
    });
  });

  describe('filterFiles', () => {
    it('should filter out git-ignored and qwen-ignored files by default', () => {
      vi.mocked(gitUtils.isGitRepository).mockReturnValue(true);
      createTestFile('.gitignore', 'node_modules');
      createTestFile('.qwenignore', 'logs');

      const files = [
        'src/index.ts',
        'node_modules/package/index.js',
        'README.md',
        'logs/latest.log',
      ].map((f) => path.join(projectRoot, f));

      const service = new FileDiscoveryService(projectRoot);

      expect(service.filterFiles(files).sort()).toEqual(
        ['src/index.ts', 'README.md']
          .map((f) => path.join(projectRoot, f))
          .sort(),
      );
    });

    it('should not filter files when respectGitIgnore is false', () => {
      vi.mocked(gitUtils.isGitRepository).mockReturnValue(true);
      createTestFile('.gitignore', 'node_modules');

      const files = ['src/index.ts', 'node_modules/package/index.js'].map((f) =>
        path.join(projectRoot, f),
      );

      const service = new FileDiscoveryService(projectRoot);

      expect(
        service.filterFiles(files, { respectGitIgnore: false }).sort(),
      ).toEqual(files.sort());
    });

    it('should not filter files when respectQwenIgnore is false', () => {
      vi.mocked(gitUtils.isGitRepository).mockReturnValue(true);
      createTestFile('.qwenignore', 'logs');

      const files = ['src/index.ts', 'logs/latest.log'].map((f) =>
        path.join(projectRoot, f),
      );

      const service = new FileDiscoveryService(projectRoot);

      const filtered = service.filterFiles(files, {
        respectQwenIgnore: false,
      });

      expect(filtered.sort()).toEqual(
        ['src/index.ts', 'logs/latest.log']
          .map((f) => path.join(projectRoot, f))
          .sort(),
      );
    });
  });

  describe('shouldGitIgnoreFile & shouldQwenIgnoreFile', () => {
    beforeEach(() => {
      vi.mocked(gitUtils.isGitRepository).mockReturnValue(true);
      createTestFile('.gitignore', 'node_modules\n*.log');
      createTestFile('.qwenignore', 'secrets.txt\nconfig.json');
    });

    it('should return true for git-ignored files', () => {
      const service = new FileDiscoveryService(projectRoot);
      expect(
        service.shouldGitIgnoreFile(
          path.join(projectRoot, 'node_modules/package/index.js'),
        ),
      ).toBe(true);
      expect(
        service.shouldGitIgnoreFile(path.join(projectRoot, 'app.log')),
      ).toBe(true);
    });

    it('should return false for non-git-ignored files', () => {
      const service = new FileDiscoveryService(projectRoot);
      expect(
        service.shouldGitIgnoreFile(path.join(projectRoot, 'src/index.ts')),
      ).toBe(false);
    });

    it('should return true for qwen-ignored files', () => {
      const service = new FileDiscoveryService(projectRoot);
      expect(service.shouldQwenIgnoreFile('secrets.txt')).toBe(true);
      expect(service.shouldQwenIgnoreFile('config.json')).toBe(true);
    });

    it('should return false for non-qwen-ignored files', () => {
      const service = new FileDiscoveryService(projectRoot);
      expect(service.shouldQwenIgnoreFile('README.md')).toBe(false);
    });
  });
});
