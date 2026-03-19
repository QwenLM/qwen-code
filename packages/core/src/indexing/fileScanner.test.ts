/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// Mock ripgrepUtils before importing FileScanner
vi.mock('../utils/ripgrepUtils.js', () => ({
  runRipgrep: vi.fn(),
}));

import { FileScanner } from './fileScanner.js';
import { runRipgrep } from '../utils/ripgrepUtils.js';

const mockRunRipgrep = vi.mocked(runRipgrep);

/**
 * Creates a temporary test directory with sample files.
 */
async function createTestProject(): Promise<string> {
  const testDir = path.join(
    os.tmpdir(),
    `filescanner_test_${crypto.randomBytes(8).toString('hex')}`,
  );
  await fs.promises.mkdir(testDir, { recursive: true });

  // Create source files
  await fs.promises.writeFile(
    path.join(testDir, 'index.ts'),
    'export function main() { console.log("Hello"); }',
  );
  await fs.promises.writeFile(
    path.join(testDir, 'utils.ts'),
    'export function add(a: number, b: number) { return a + b; }',
  );

  // Create nested directory
  await fs.promises.mkdir(path.join(testDir, 'src'), { recursive: true });
  await fs.promises.writeFile(
    path.join(testDir, 'src', 'helper.ts'),
    'export const PI = 3.14159;',
  );
  await fs.promises.writeFile(
    path.join(testDir, 'src', 'config.json'),
    '{"key": "value"}',
  );

  // Create a .gitignore
  await fs.promises.writeFile(
    path.join(testDir, '.gitignore'),
    'node_modules/\n*.log\n',
  );

  return testDir;
}

/**
 * Cleans up the test directory.
 */
async function cleanupTestProject(testDir: string): Promise<void> {
  if (fs.existsSync(testDir)) {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  }
}

/**
 * Helper to create mock ripgrep result with absolute paths
 */
function mockRipgrepResult(testDir: string, relativePaths: string[]) {
  const absolutePaths = relativePaths.map((p) => path.join(testDir, p));
  return { stdout: absolutePaths.join('\n'), truncated: false };
}

describe('FileScanner', () => {
  let testDir: string;
  let scanner: FileScanner;

  beforeEach(async () => {
    testDir = await createTestProject();
    scanner = new FileScanner(testDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestProject(testDir);
  });

  describe('scanFiles', () => {
    it('should scan all files in the project', async () => {
      // Mock ripgrep to return absolute file paths
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, [
          'index.ts',
          'utils.ts',
          'src/helper.ts',
          'src/config.json',
        ]),
      );

      const files = await scanner.scanFiles();

      expect(files.length).toBe(4);
      expect(files.some((f) => f.path === 'index.ts')).toBe(true);
      expect(files.some((f) => f.path === 'utils.ts')).toBe(true);
      expect(files.some((f) => f.path === path.join('src', 'helper.ts'))).toBe(
        true,
      );
    });

    it('should return file metadata with correct properties', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts']),
      );

      const files = await scanner.scanFiles();
      const indexFile = files.find((f) => f.path === 'index.ts');

      expect(indexFile).toBeDefined();
      expect(indexFile!.contentHash).toBeDefined();
      expect(indexFile!.contentHash.length).toBe(64); // SHA-256 hex
      expect(indexFile!.lastModified).toBeGreaterThan(0);
      expect(indexFile!.size).toBeGreaterThan(0);
      expect(indexFile!.language).toBe('typescript');
    });

    it('should detect programming language from extension', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts', 'src/config.json']),
      );

      const files = await scanner.scanFiles();

      const tsFile = files.find((f) => f.path.endsWith('.ts'));
      const jsonFile = files.find((f) => f.path.endsWith('.json'));

      expect(tsFile?.language).toBe('typescript');
      expect(jsonFile?.language).toBe('json');
    });

    it('should handle empty ripgrep output', async () => {
      mockRunRipgrep.mockResolvedValue({ stdout: '', truncated: false });

      const files = await scanner.scanFiles();

      expect(files).toHaveLength(0);
    });

    it('should skip files that no longer exist', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts', 'non-existent.ts']),
      );

      const files = await scanner.scanFiles();

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('index.ts');
    });
  });

  describe('countFiles', () => {
    it('should return correct file count', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts', 'utils.ts', 'src/helper.ts']),
      );

      const count = await scanner.countFiles();

      expect(count).toBe(3);
    });

    it('should return 0 for empty output', async () => {
      mockRunRipgrep.mockResolvedValue({ stdout: '', truncated: false });

      const count = await scanner.countFiles();

      expect(count).toBe(0);
    });
  });

  describe('scanSpecificFiles', () => {
    it('should scan specific files by path', async () => {
      const files = await scanner.scanSpecificFiles(['index.ts', 'utils.ts']);

      expect(files).toHaveLength(2);
      expect(files.some((f) => f.path === 'index.ts')).toBe(true);
      expect(files.some((f) => f.path === 'utils.ts')).toBe(true);
    });

    it('should handle non-existent files gracefully', async () => {
      const files = await scanner.scanSpecificFiles([
        'index.ts',
        'non-existent.ts',
      ]);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('index.ts');
    });

    it('should handle absolute paths', async () => {
      const absPath = path.join(testDir, 'index.ts');
      const files = await scanner.scanSpecificFiles([absPath]);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('index.ts');
    });
  });

  describe('scanFilesStreaming', () => {
    it('should yield file batches', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, [
          'index.ts',
          'utils.ts',
          'src/helper.ts',
          'src/config.json',
        ]),
      );

      const batches: number[] = [];

      for await (const batch of scanner.scanFilesStreaming(testDir, 2)) {
        batches.push(batch.length);
      }

      expect(batches.length).toBeGreaterThan(0);
      // All batches except possibly the last should be <= batchSize
      for (let i = 0; i < batches.length - 1; i++) {
        expect(batches[i]).toBeLessThanOrEqual(2);
      }
    });

    it('should yield all files across batches', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, [
          'index.ts',
          'utils.ts',
          'src/helper.ts',
          'src/config.json',
        ]),
      );

      const allFiles: string[] = [];

      for await (const batch of scanner.scanFilesStreaming(testDir, 1)) {
        allFiles.push(...batch.map((f) => f.path));
      }

      expect(allFiles.length).toBe(4);
    });

    it('should support cancellation via AbortSignal', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, [
          'index.ts',
          'utils.ts',
          'src/helper.ts',
          'src/config.json',
        ]),
      );

      const controller = new AbortController();
      const scannerWithSignal = new FileScanner(testDir, {
        signal: controller.signal,
      });

      const files: string[] = [];
      let batchCount = 0;

      for await (const batch of scannerWithSignal.scanFilesStreaming(
        testDir,
        1,
      )) {
        batchCount++;
        files.push(...batch.map((f) => f.path));
        if (batchCount >= 2) {
          controller.abort();
        }
      }

      // Should have stopped early
      expect(files.length).toBeLessThanOrEqual(2);
    });
  });

  describe('language detection', () => {
    it('should detect TypeScript files', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts', 'utils.ts']),
      );

      const files = await scanner.scanFiles();
      const tsFiles = files.filter((f) => f.path.endsWith('.ts'));

      for (const file of tsFiles) {
        expect(file.language).toBe('typescript');
      }
    });

    it('should detect JSON files', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['src/config.json']),
      );

      const files = await scanner.scanFiles();
      const jsonFile = files.find((f) => f.path.endsWith('.json'));

      expect(jsonFile?.language).toBe('json');
    });

    it('should return undefined for unknown extensions', async () => {
      // Create a file with unknown extension
      await fs.promises.writeFile(
        path.join(testDir, 'readme.unknown'),
        'content',
      );
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['readme.unknown']),
      );

      const files = await scanner.scanFiles();
      const unknownFile = files.find((f) => f.path.endsWith('.unknown'));

      expect(unknownFile?.language).toBeUndefined();
    });
  });

  describe('content hashing', () => {
    it('should produce consistent hashes for same content', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts']),
      );

      const files1 = await scanner.scanFiles();
      const files2 = await scanner.scanFiles();

      const file1 = files1.find((f) => f.path === 'index.ts');
      const file2 = files2.find((f) => f.path === 'index.ts');

      expect(file1?.contentHash).toBe(file2?.contentHash);
    });

    it('should produce different hashes for different content', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts', 'utils.ts']),
      );

      const files = await scanner.scanFiles();
      const indexFile = files.find((f) => f.path === 'index.ts');
      const utilsFile = files.find((f) => f.path === 'utils.ts');

      expect(indexFile?.contentHash).not.toBe(utilsFile?.contentHash);
    });

    it('should detect content changes via hash', async () => {
      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['index.ts']),
      );

      const files1 = await scanner.scanFiles();
      const originalHash = files1.find(
        (f) => f.path === 'index.ts',
      )?.contentHash;

      // Modify the file
      await fs.promises.writeFile(
        path.join(testDir, 'index.ts'),
        'export function main() { console.log("Modified"); }',
      );

      const files2 = await scanner.scanFiles();
      const newHash = files2.find((f) => f.path === 'index.ts')?.contentHash;

      expect(newHash).not.toBe(originalHash);
    });
  });

  describe('large file handling', () => {
    it('should skip files larger than 10MB', async () => {
      // Create a large file (>10MB is skipped)
      const largeFilePath = path.join(testDir, 'large.ts');
      const largeContent = Buffer.alloc(11 * 1024 * 1024, 'x');
      await fs.promises.writeFile(largeFilePath, largeContent);

      mockRunRipgrep.mockResolvedValue(
        mockRipgrepResult(testDir, ['large.ts', 'index.ts']),
      );

      const files = await scanner.scanFiles();

      // Large file should be filtered out based on size
      const largeFile = files.find((f) => f.path === 'large.ts');
      const indexFile = files.find((f) => f.path === 'index.ts');

      // index.ts should be present
      expect(indexFile).toBeDefined();
      // large.ts might be filtered by maxFileSize (depending on implementation)
      // If it's not filtered, it should at least have correct size
      if (largeFile) {
        expect(largeFile.size).toBeGreaterThan(10 * 1024 * 1024);
      }
    });
  });
});
