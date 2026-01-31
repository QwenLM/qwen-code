/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PartListUnion } from '@google/genai';
import { readManyFiles } from './readManyFiles.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';

/** Helper to convert PartListUnion to string for test assertions */
function contentToString(parts: PartListUnion): string {
  if (typeof parts === 'string') {
    return parts;
  }
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('');
  }
  return JSON.stringify(parts);
}

describe('readManyFiles', () => {
  let tempRootDir: string;

  // Helper to create mock config
  const createMockConfig = (rootDir: string): Config =>
    ({
      getFileService: () => new FileDiscoveryService(rootDir),
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      getTargetDir: () => rootDir,
      getProjectRoot: () => rootDir,
      getWorkspaceContext: () => createMockWorkspaceContext(rootDir),
      getTruncateToolOutputLines: () => 1000,
      getTruncateToolOutputThreshold: () => 2500,
    }) as unknown as Config;

  async function createTestFile(
    ...pathSegments: string[]
  ): Promise<{ relativePath: string; absolutePath: string }> {
    const relativePath = path.join(...pathSegments);
    const absolutePath = path.join(tempRootDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `Content of ${pathSegments.at(-1)}`);
    return { relativePath, absolutePath };
  }

  async function createTestDir(...pathSegments: string[]): Promise<string> {
    const absolutePath = path.join(tempRootDir, ...pathSegments);
    await fs.mkdir(absolutePath, { recursive: true });
    return absolutePath;
  }

  beforeEach(async () => {
    tempRootDir = nodeFs.realpathSync(
      await fs.mkdtemp(path.join(os.tmpdir(), 'read-many-files-test-')),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('file reading', () => {
    it('should read a single file', async () => {
      await createTestFile('file1.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: ['file1.txt'] });

      const content = contentToString(result.contentParts);
      expect(content).toContain('--- Content from referenced files ---');
      expect(content).toContain('Content from');
      expect(content).toContain('file1.txt');
      expect(content).toContain('Content of file1.txt');
      expect(content).toContain('--- End of content ---');
    });

    it('should read multiple files', async () => {
      await createTestFile('file1.txt');
      await createTestFile('file2.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['file1.txt', 'file2.txt'],
      });

      const content = contentToString(result.contentParts);
      expect(content).toContain('--- Content from referenced files ---');
      expect(content).toContain('Content of file1.txt');
      expect(content).toContain('Content of file2.txt');
      expect(content).toContain('--- End of content ---');
    });

    it('should return message when no files found', async () => {
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['nonexistent.txt'],
      });

      expect(contentToString(result.contentParts)).toContain(
        'No files matching the criteria were found',
      );
    });
  });

  describe('directory handling', () => {
    it('should return directory structure when path is a directory', async () => {
      await createTestFile('mydir', 'file1.txt');
      await createTestFile('mydir', 'file2.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: ['mydir'] });

      const content = contentToString(result.contentParts);
      expect(content).toContain('--- Content from referenced files ---');
      expect(content).toContain('Content from');
      expect(content).toContain('mydir');
      expect(content).toContain('file1.txt');
      expect(content).toContain('file2.txt');
      // Should NOT contain the file contents, just the structure
      expect(content).not.toContain('Content of file1.txt');
    });

    it('should handle directory with trailing slash', async () => {
      await createTestFile('mydir', 'file1.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: ['mydir/'] });

      const content = contentToString(result.contentParts);
      expect(content).toContain('Content from');
      expect(content).toContain('mydir');
    });

    it('should handle empty directory', async () => {
      await createTestDir('emptydir');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: ['emptydir'] });

      const content = contentToString(result.contentParts);
      expect(content).toContain('Content from');
      expect(content).toContain('emptydir');
    });
  });

  describe('mixed files and directories', () => {
    it('should handle mix of files and directories', async () => {
      await createTestFile('file.txt');
      await createTestFile('mydir', 'nested.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['file.txt', 'mydir'],
      });

      const content = contentToString(result.contentParts);
      expect(content).toContain('--- Content from referenced files ---');
      // File content should be present
      expect(content).toContain('Content of file.txt');
      // Directory structure should be present
      expect(content).toContain('Content from');
      expect(content).toContain('mydir');
      expect(content).toContain('nested.txt');
    });
  });

  describe('edge cases', () => {
    it('should handle paths with special characters', async () => {
      await createTestFile('dir-with-dash', 'file.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['dir-with-dash'],
      });

      const content = contentToString(result.contentParts);
      expect(content).toContain('Content from');
      expect(content).toContain('dir-with-dash');
    });

    it('should allow directories outside project root', async () => {
      // Create a directory outside the workspace
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'outside-workspace-'),
      );
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');

      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: [outsideDir] });

      // Should include the outside directory listing
      expect(contentToString(result.contentParts)).toContain('secret.txt');

      // Cleanup
      await fs.rm(outsideDir, { recursive: true, force: true });
    });
  });

  describe('files array', () => {
    it('should populate files array for single file', async () => {
      const { absolutePath } = await createTestFile('file1.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: ['file1.txt'] });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].filePath).toBe(absolutePath);
      expect(result.files[0].isDirectory).toBe(false);
      expect(result.files[0].content).toContain('Content of file1.txt');
    });

    it('should populate files array for multiple files', async () => {
      const file1 = await createTestFile('file1.txt');
      const file2 = await createTestFile('file2.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['file1.txt', 'file2.txt'],
      });

      expect(result.files).toHaveLength(2);
      const filePaths = result.files.map((f) => f.filePath);
      expect(filePaths).toContain(file1.absolutePath);
      expect(filePaths).toContain(file2.absolutePath);
    });

    it('should mark directories in files array', async () => {
      await createTestFile('mydir', 'nested.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: ['mydir'] });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].isDirectory).toBe(true);
      expect(result.files[0].filePath).toContain('mydir');
    });

    it('should include both files and directories in files array', async () => {
      const file = await createTestFile('file.txt');
      await createTestFile('mydir', 'nested.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['file.txt', 'mydir'],
      });

      expect(result.files).toHaveLength(2);

      const fileEntry = result.files.find((f) => !f.isDirectory);
      const dirEntry = result.files.find((f) => f.isDirectory);

      expect(fileEntry).toBeDefined();
      expect(fileEntry!.filePath).toBe(file.absolutePath);

      expect(dirEntry).toBeDefined();
      expect(dirEntry!.filePath).toContain('mydir');
    });

    it('should return empty files array when no files found', async () => {
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: ['nonexistent.txt'],
      });

      expect(result.files).toHaveLength(0);
    });

    it('should return empty files array on error', async () => {
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getProjectRoot: () => {
          throw new Error('Test error');
        },
      } as unknown as Config;

      const result = await readManyFiles(mockConfig, { paths: ['file.txt'] });

      expect(result.files).toHaveLength(0);
      expect(result.error).toBeDefined();
    });
  });
});
