/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import type { Part, PartListUnion } from '@google/genai';
import { readManyFiles } from './readManyFiles.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { checkPriorRead } from './priorReadEnforcement.js';
import { getPDFPageCount, isPdftotextAvailable } from '../utils/pdf.js';

vi.mock('../utils/pdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/pdf.js')>();
  return {
    ...actual,
    getPDFPageCount: vi.fn(),
    isPdftotextAvailable: vi.fn(),
  };
});

const mockGetPDFPageCount = vi.mocked(getPDFPageCount);
const mockIsPdftotextAvailable = vi.mocked(isPdftotextAvailable);

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

function findInlineDataPart(parts: PartListUnion): Part | undefined {
  if (!Array.isArray(parts)) return undefined;
  return parts.find(
    (part): part is Part =>
      typeof part === 'object' && part !== null && 'inlineData' in part,
  );
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
      getFileSystemService: () => new StandardFileSystemService(),
      getContentGeneratorConfig: () => ({ modalities: {} }),
      getModel: () => 'text-only-model',
      getMemoryRecallMode: () => 'legacy',
    }) as unknown as Config;

  // Variant of createMockConfig wired to a live FileReadCache so the
  // prior-read enforcement path (issue #6289) can be exercised end-to-end.
  const createMockConfigWithCache = (
    rootDir: string,
    cache: FileReadCache,
    fileReadCacheDisabled = false,
  ): Config =>
    ({
      ...createMockConfig(rootDir),
      getFileReadCache: () => cache,
      getFileReadCacheDisabled: () => fileReadCacheDisabled,
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

  function mockZeroInodeForPath(absolutePath: string): { restore(): void } {
    const originalStat = fs.stat.bind(fs);
    const originalOpen = fs.open.bind(fs);
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const stats = await originalStat(...args);
      if (String(args[0]) === absolutePath) {
        Object.defineProperty(stats, 'ino', { value: 0 });
      }
      return stats;
    });
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalHandleStat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const stats = await originalHandleStat();
        Object.defineProperty(stats, 'ino', { value: 0 });
        return stats;
      });
      return handle;
    });
    return {
      restore: () => {
        statSpy.mockRestore();
        openSpy.mockRestore();
      },
    };
  }

  async function createTestDir(...pathSegments: string[]): Promise<string> {
    const absolutePath = path.join(tempRootDir, ...pathSegments);
    await fs.mkdir(absolutePath, { recursive: true });
    return absolutePath;
  }

  beforeEach(async () => {
    mockGetPDFPageCount.mockReset();
    mockGetPDFPageCount.mockResolvedValue(null);
    mockIsPdftotextAvailable.mockReset();
    mockIsPdftotextAvailable.mockResolvedValue(true);
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

    it('uses display paths for canonical reads', async () => {
      const { absolutePath } = await createTestFile('target.txt');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: [absolutePath],
        displayPaths: new Map([[absolutePath, 'alias.txt']]),
      });

      const content = contentToString(result.contentParts);
      expect(content).toContain('Content from alias.txt');
      expect(content).not.toContain(`Content from ${absolutePath}`);
      expect(result.files[0]!.filePath).toBe('alias.txt');
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

    it('drops a validated path when its file identity changes before reading', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('approved.txt');
      const approvedStats = await fs.stat(absolutePath);
      await fs.rename(absolutePath, `${absolutePath}.original`);
      await fs.writeFile(absolutePath, 'replacement secret');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
        ]),
      });

      expect(contentToString(result.contentParts)).not.toContain(
        'replacement secret',
      );
      expect(result.files).toHaveLength(0);
    });

    it('surfaces an error when validated inode identity is unverifiable', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('zero-inode.txt');
      const approvedStats = await fs.stat(absolutePath);
      const zeroInodeMock = mockZeroInodeForPath(absolutePath);
      const mockConfig = createMockConfig(tempRootDir);

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: 0 }],
          ]),
        });

        expect(contentToString(result.contentParts)).not.toContain(
          'Content of zero-inode.txt',
        );
        expect(contentToString(result.contentParts)).toContain(
          'Validated file identity is unavailable on this filesystem',
        );
        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.error).toContain(
          'Validated file identity is unavailable on this filesystem',
        );
      } finally {
        zeroInodeMock.restore();
      }
    });

    it('deduplicates unverifiable validated inode errors for repeated paths', async () => {
      const { relativePath, absolutePath } = await createTestFile(
        'zero-inode-duplicate.txt',
      );
      const approvedStats = await fs.stat(absolutePath);
      const zeroInodeMock = mockZeroInodeForPath(absolutePath);
      const mockConfig = createMockConfig(tempRootDir);

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath, relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: 0 }],
          ]),
        });
        const content = contentToString(result.contentParts);

        expect(content).not.toContain('Content of zero-inode-duplicate.txt');
        expect(
          content.match(/Validated file identity is unavailable/g),
        ).toHaveLength(1);
        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.error).toContain(
          'Validated file identity is unavailable',
        );
      } finally {
        zeroInodeMock.restore();
      }
    });

    it('drops a validated read when the identity map has no matching path key', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('approved.txt');
      const approvedStats = await fs.stat(absolutePath);
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [
            path.join(tempRootDir, 'other.txt'),
            { dev: approvedStats.dev, ino: approvedStats.ino },
          ],
        ]),
      });

      expect(contentToString(result.contentParts)).not.toContain(
        'Content of approved.txt',
      );
      expect(result.files).toHaveLength(0);
    });

    it('reads a validated file from its approved handle during an ABA path swap', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('approved.txt');
      const approvedStats = await fs.stat(absolutePath);
      const backupPath = `${absolutePath}.approved`;
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'read-many-files-outside-'),
      );
      const outsidePath = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(outsidePath, 'outside secret');
      const fileSystemService = new StandardFileSystemService();
      const readTextFileFromHandle =
        fileSystemService.readTextFileFromHandle.bind(fileSystemService);
      vi.spyOn(fileSystemService, 'readTextFileFromHandle').mockImplementation(
        async (options) => {
          await fs.rename(absolutePath, backupPath);
          await fs.symlink(outsidePath, absolutePath);
          try {
            return await readTextFileFromHandle(options);
          } finally {
            await fs.unlink(absolutePath);
            await fs.rename(backupPath, absolutePath);
          }
        },
      );
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getFileSystemService: () => fileSystemService,
      } as unknown as Config;

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
          ]),
        });
        const content = contentToString(result.contentParts);

        expect(content).toContain('Content of approved.txt');
        expect(content).not.toContain('outside secret');
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('reads validated large text through a bounded handle without snapshotting', async () => {
      const relativePath = 'large-approved.log';
      const absolutePath = path.join(tempRootDir, relativePath);
      const line = `${'x'.repeat(20)}\n`;
      await fs.writeFile(
        absolutePath,
        line.repeat(Math.ceil((11 * 1024 * 1024) / line.length)),
        'utf-8',
      );
      const approvedStats = await fs.stat(absolutePath);
      const fileSystemService = new StandardFileSystemService();
      const readTextFileSpy = vi.spyOn(fileSystemService, 'readTextFile');
      const readTextFileFromHandleSpy = vi.spyOn(
        fileSystemService,
        'readTextFileFromHandle',
      );
      const mkdtempSpy = vi.spyOn(fs, 'mkdtemp');
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getFileSystemService: () => fileSystemService,
      } as unknown as Config;

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
          ]),
        });
        const content = contentToString(result.contentParts);

        expect(content).toContain('Showing lines 1-');
        expect(content).toContain('... [truncated]');
        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.error).toBeUndefined();
        expect(readTextFileFromHandleSpy).toHaveBeenCalled();
        expect(readTextFileSpy).not.toHaveBeenCalled();
        expect(mkdtempSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('qwen-validated-read-'),
        );
      } finally {
        readTextFileSpy.mockRestore();
        readTextFileFromHandleSpy.mockRestore();
        mkdtempSpy.mockRestore();
      }
    });

    it('reads validated text behind an image extension through the pinned handle', async () => {
      const relativePath = 'validated-screenshot.png';
      const absolutePath = path.join(tempRootDir, relativePath);
      const jsonContent = '{"json": true}';
      await fs.writeFile(absolutePath, jsonContent);
      const approvedStats = await fs.stat(absolutePath);
      const fileSystemService = new StandardFileSystemService();
      const readTextFileFromHandleSpy = vi.spyOn(
        fileSystemService,
        'readTextFileFromHandle',
      );
      const mkdtempSpy = vi.spyOn(fs, 'mkdtemp');
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getFileSystemService: () => fileSystemService,
      } as unknown as Config;

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
          ]),
        });

        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.content).toBe(jsonContent);
        expect(result.files[0]!.error).toBeUndefined();
        expect(readTextFileFromHandleSpy).toHaveBeenCalled();
        expect(mkdtempSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('qwen-validated-read-'),
        );
      } finally {
        readTextFileFromHandleSpy.mockRestore();
        mkdtempSpy.mockRestore();
      }
    });

    it('reads validated text through a handle when truncation is disabled', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('approved.txt');
      const approvedStats = await fs.stat(absolutePath);
      const fileSystemService = new StandardFileSystemService();
      const readTextFileFromHandleSpy = vi.spyOn(
        fileSystemService,
        'readTextFileFromHandle',
      );
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getTruncateToolOutputThreshold: () => Number.POSITIVE_INFINITY,
        getFileSystemService: () => fileSystemService,
      } as unknown as Config;

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
        ]),
      });

      expect(contentToString(result.contentParts)).toContain(
        'Content of approved.txt',
      );
      expect(readTextFileFromHandleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputBytes: Number.MAX_SAFE_INTEGER,
          maxScanBytes: approvedStats.size,
        }),
      );
    });

    it('keeps sibling files when one validated text file fails to open', async () => {
      const good = await createTestFile('good.txt');
      const bad = await createTestFile('bad.txt');
      const goodStats = await fs.stat(good.absolutePath);
      const badStats = await fs.stat(bad.absolutePath);
      const fileSystemService = new StandardFileSystemService();
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          if (String(args[0]) === bad.absolutePath) {
            const err: NodeJS.ErrnoException = new Error(
              'EACCES: permission denied',
            );
            err.code = 'EACCES';
            throw err;
          }
          return originalOpen(...args);
        });
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getFileSystemService: () => fileSystemService,
      } as unknown as Config;

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [good.relativePath, bad.relativePath],
          validatedPathIdentities: new Map([
            [good.absolutePath, { dev: goodStats.dev, ino: goodStats.ino }],
            [bad.absolutePath, { dev: badStats.dev, ino: badStats.ino }],
          ]),
        });
        const text = contentToString(result.contentParts);

        expect(text).toContain('Content of good.txt');
        expect(text).toContain('Error reading');
        expect(text).toContain('EACCES');
        expect(result.files).toHaveLength(2);
        expect(result.files[0]!.error).toBeUndefined();
        expect(result.files[1]!.error).toContain('EACCES');
        expect(result.error).toBeUndefined();
      } finally {
        openSpy.mockRestore();
      }
    });

    it('keeps validated text reads on custom file systems on the original path', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('approved.txt');
      const stats = await fs.stat(absolutePath);
      const readTextFile = vi.fn(async () => ({
        content: 'unsaved buffer',
        _meta: {
          originalLineCount: 1,
          originalLineCountExact: true,
        },
      }));
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getFileSystemService: () => ({
          readTextFile,
          writeTextFile: vi.fn(),
          findFiles: vi.fn(),
        }),
      } as unknown as Config;

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: stats.dev, ino: stats.ino }],
        ]),
      });

      expect(readTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: absolutePath }),
      );
      expect(contentToString(result.contentParts)).toContain('unsaved buffer');
    });

    it('does not cache a validated custom-fs read dropped after identity drift', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('approved.txt');
      const backupPath = `${absolutePath}.approved`;
      const stats = await fs.stat(absolutePath);
      const cache = new FileReadCache();
      const readTextFile = vi.fn(async () => {
        await fs.rename(absolutePath, backupPath);
        await fs.writeFile(absolutePath, 'replacement secret');
        return {
          content: 'unsaved buffer',
          _meta: {
            originalLineCount: 1,
            originalLineCountExact: true,
          },
        };
      });
      const mockConfig = {
        ...createMockConfigWithCache(tempRootDir, cache),
        getFileSystemService: () => ({
          readTextFile,
          writeTextFile: vi.fn(),
          findFiles: vi.fn(),
        }),
      } as unknown as Config;

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: stats.dev, ino: stats.ino }],
          ]),
        });

        const content = contentToString(result.contentParts);
        expect(content).not.toContain('unsaved buffer');
        expect(content).not.toContain('replacement secret');
        expect(result.files).toHaveLength(0);
        expect(cache.size()).toBe(0);
        const decision = await checkPriorRead(cache, absolutePath, 'editing');
        expect(decision.ok).toBe(false);
      } finally {
        await fs.unlink(absolutePath).catch(() => {});
        await fs.rename(backupPath, absolutePath).catch(() => {});
      }
    });

    it('should include truncated large text files instead of reporting a size error', async () => {
      const relativePath = 'large.log';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(absolutePath, 'x'.repeat(11 * 1024 * 1024), 'utf-8');
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: [relativePath] });

      const content = contentToString(result.contentParts);
      expect(content).toContain('Showing lines 1-1 of at least 1 total lines');
      expect(content).toContain('... [truncated]');
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.error).toBeUndefined();
      expect(result.files[0]!.filePath).toBe(absolutePath);
    });

    it('should include truncated notebooks that do not expose text line ranges', async () => {
      const relativePath = 'large.ipynb';
      const absolutePath = path.join(tempRootDir, relativePath);
      const cells = Array.from({ length: 30 }, (_, index) => ({
        cell_type: 'code',
        id: `large-cell-${index}`,
        source: [`value_${index} = "${'x'.repeat(4500)}"`],
        metadata: {},
        outputs: [],
      }));
      await fs.writeFile(
        absolutePath,
        JSON.stringify({ cells, metadata: {} }),
        'utf-8',
      );
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: [relativePath] });

      const content = contentToString(result.contentParts);
      expect(content).toContain('Jupyter Notebook');
      expect(content).toContain('remaining cells truncated');
      expect(content).not.toContain(
        'No files matching the criteria were found',
      );
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.filePath).toBe(absolutePath);
    });

    it('renders canonical images through the overview pipeline even when the bridge handoff flag is set', async () => {
      const relativePath = 'screenshot.png';
      const absolutePath = path.join(tempRootDir, relativePath);
      await sharp({
        create: {
          width: 20,
          height: 10,
          channels: 3,
          background: '#306090',
        },
      })
        .png()
        .toFile(absolutePath);
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        preserveUnsupportedImageForBridge: true,
      });

      const imagePart = findInlineDataPart(result.contentParts);
      expect(imagePart).toBeDefined();
      expect(
        (imagePart as { inlineData: { mimeType: string; data: string } })
          .inlineData,
      ).toMatchObject({
        mimeType: 'image/jpeg',
        data: expect.any(String),
        displayName: 'screenshot.png',
      });
      const parts = result.contentParts as Part[];
      const imageIndex = parts.indexOf(imagePart!);
      expect(parts[imageIndex - 2]?.text).toBe(
        `\nContent from ${absolutePath}:\n`,
      );
      expect(parts[imageIndex - 1]?.text).toContain(
        'Image overview: 20x10; oriented source: 20x10',
      );
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.content).toEqual([
        parts[imageIndex - 1],
        imagePart,
      ]);
    });

    it('reads a validated image from its approved snapshot during a path swap', async () => {
      const relativePath = 'approved.png';
      const absolutePath = path.join(tempRootDir, relativePath);
      await sharp({
        create: {
          width: 20,
          height: 10,
          channels: 3,
          background: '#306090',
        },
      })
        .png()
        .toFile(absolutePath);
      const approvedStats = await fs.stat(absolutePath);
      const backupPath = `${absolutePath}.approved`;
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'read-many-files-outside-'),
      );
      const outsidePath = path.join(outsideDir, 'secret.png');
      await fs.writeFile(outsidePath, Buffer.from('outside secret'));
      const readFile = fs.readFile.bind(fs);
      let swappedAfterSnapshotRead = false;
      const readFileSpy = vi
        .spyOn(fs, 'readFile')
        .mockImplementation(async (file, options) => {
          const result = await readFile(file, options);
          // The first snapshot read proves the descriptor is already bound to
          // the approved inode before the visible path is swapped.
          if (String(file).includes('qwen-validated-read-')) {
            swappedAfterSnapshotRead = true;
            await fs.rename(absolutePath, backupPath);
            await fs.symlink(outsidePath, absolutePath);
          }
          return result;
        });
      const mockConfig = createMockConfig(tempRootDir);

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          preserveUnsupportedImageForBridge: true,
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
          ]),
        });
        const imagePart = findInlineDataPart(result.contentParts);

        expect(imagePart).toBeDefined();
        expect(swappedAfterSnapshotRead).toBe(true);
        expect(contentToString(result.contentParts)).not.toContain(
          'outside secret',
        );
      } finally {
        readFileSpy.mockRestore();
        await fs.rm(absolutePath, { force: true });
        await fs.rename(backupPath, absolutePath).catch(() => undefined);
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('drops a validated directory when its identity changes after reading', async () => {
      const relativePath = 'approved-dir';
      const absolutePath = path.join(tempRootDir, relativePath);
      const backupPath = `${absolutePath}.approved`;
      const visiblePath = path.join(absolutePath, 'visible.txt');
      await fs.mkdir(absolutePath);
      await fs.writeFile(visiblePath, 'visible');
      const approvedStats = await fs.stat(absolutePath);
      const fileService = new FileDiscoveryService(tempRootDir);
      let swapped = false;
      const ignoreSpy = vi
        .spyOn(fileService, 'shouldGitIgnoreFile')
        .mockImplementation((file) => {
          if (file === visiblePath && !swapped) {
            nodeFs.renameSync(absolutePath, backupPath);
            nodeFs.mkdirSync(absolutePath);
            swapped = true;
          }
          return false;
        });
      const mockConfig = {
        ...createMockConfig(tempRootDir),
        getFileService: () => fileService,
      } as Config;

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
          ]),
        });

        expect(swapped).toBe(true);
        expect(contentToString(result.contentParts)).not.toContain(
          'visible.txt',
        );
        expect(result.files).toHaveLength(0);
      } finally {
        ignoreSpy.mockRestore();
        if (swapped) {
          await fs.rm(absolutePath, { recursive: true, force: true });
          await fs.rename(backupPath, absolutePath);
        }
      }
    });

    it('drops a validated snapshot when the source grows during copying', async () => {
      const relativePath = 'approved.bin';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(absolutePath, Buffer.alloc(8, 0x01));
      const approvedStats = await fs.stat(absolutePath);
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          const handle = await originalOpen(...args);
          if (args[0] === absolutePath) {
            const originalRead = handle.read.bind(handle);
            let appended = false;
            vi.spyOn(handle, 'read').mockImplementation((async (
              buffer: NodeJS.ArrayBufferView,
              offset?: number | null,
              length?: number | null,
              position?: number | null,
            ) => {
              if (!appended && position === approvedStats.size) {
                appended = true;
                await fs.appendFile(absolutePath, Buffer.from([0x02]));
              }
              return originalRead(buffer, offset, length, position);
            }) as typeof handle.read);
          }
          return handle;
        });
      const mockConfig = createMockConfig(tempRootDir);

      try {
        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
          validatedPathIdentities: new Map([
            [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
          ]),
        });

        expect(result.files).toHaveLength(0);
        expect(contentToString(result.contentParts)).not.toContain(
          'approved.bin',
        );
      } finally {
        openSpy.mockRestore();
      }
    });

    it('skips unsupported images when the bridge handoff flag is absent', async () => {
      const relativePath = 'screenshot.png';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(
        absolutePath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, { paths: [relativePath] });

      expect(findInlineDataPart(result.contentParts)).toBeUndefined();
      expect(contentToString(result.contentParts)).toContain(
        'Unsupported image file',
      );
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.content).toContain('Unsupported image file');
    });

    it.each([
      { extension: 'png' },
      { extension: 'jpg' },
      { extension: 'gif' },
      { extension: 'webp' },
    ])(
      'reads text content behind a .$extension extension as text',
      async ({ extension }) => {
        const relativePath = `screenshot.${extension}`;
        const absolutePath = path.join(tempRootDir, relativePath);
        const jsonContent = '{"json": true}';
        await fs.writeFile(absolutePath, Buffer.from(jsonContent));
        const mockConfig = createMockConfig(tempRootDir);

        const result = await readManyFiles(mockConfig, {
          paths: [relativePath],
        });

        expect(findInlineDataPart(result.contentParts)).toBeUndefined();
        expect(contentToString(result.contentParts)).toContain('json');
        expect(result.files).toHaveLength(1);
        expect(result.files[0]!.content).toBe(jsonContent);
        expect(result.files[0]!.error).toBeUndefined();
      },
    );

    it('references large PDFs instead of inlining extracted text for @ attachments', async () => {
      const relativePath = 'paper.pdf';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(absolutePath, Buffer.alloc(2 * 1024 * 1024));
      mockGetPDFPageCount.mockResolvedValueOnce(31);
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      const result = await readManyFiles(mockConfig, { paths: [relativePath] });
      const content = contentToString(result.contentParts);

      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.error).toBeUndefined();
      expect(result.files[0]!.content).toContain('PDF "paper.pdf"');
      expect(content).toContain("Use the 'pages' parameter");
      expect(content.length).toBeLessThan(1000);
      expect(mockGetPDFPageCount).toHaveBeenCalledTimes(1);
      expect(mockGetPDFPageCount).toHaveBeenCalledWith(absolutePath);
      expect(mockIsPdftotextAvailable).not.toHaveBeenCalled();

      const status = cache.check(nodeFs.statSync(absolutePath));
      expect(status.state).toBe('fresh');
      if (status.state === 'fresh') {
        expect(status.entry.lastReadCacheable).toBe(false);
      }
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

    it('should propagate aborts before reading a directory', async () => {
      await createTestFile('mydir', 'file1.txt');
      const mockConfig = createMockConfig(tempRootDir);
      const controller = new AbortController();
      controller.abort();

      await expect(
        readManyFiles(mockConfig, {
          paths: ['mydir'],
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort/i);
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

    it('hides managed memory directories only without direct-read capability', async () => {
      await createTestFile('.qwen', 'memory', 'user', 'preference.md');
      const structuredConfig = {
        ...createMockConfig(tempRootDir),
        getMemoryRecallMode: () => 'structured',
      } as Config;

      const hidden = await readManyFiles(structuredConfig, {
        paths: ['.qwen'],
      });
      expect(contentToString(hidden.contentParts)).not.toContain(
        'preference.md',
      );

      const visible = await readManyFiles(
        {
          ...structuredConfig,
          allowsDirectAutoMemoryRead: () => true,
        } as Config,
        { paths: ['.qwen'] },
      );
      expect(contentToString(visible.contentParts)).toContain('preference.md');
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

  describe('per-file error surfacing', () => {
    it('should propagate aborts from file reads instead of returning an error message', async () => {
      const { relativePath } = await createTestFile('cancel.txt');
      const mockConfig = createMockConfig(tempRootDir);
      const controller = new AbortController();
      controller.abort();

      await expect(
        readManyFiles(mockConfig, {
          paths: [relativePath],
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort/i);
    });

    it('should surface processSingleFileContent errors instead of silently skipping the file', async () => {
      // Trigger the >10MB file-size error path in processSingleFileContent.
      const relativePath = 'huge.bin';
      const absolutePath = path.join(tempRootDir, relativePath);
      // 10MB + 1 byte to cross the 9.9MB threshold.
      await fs.writeFile(absolutePath, Buffer.alloc(10 * 1024 * 1024 + 1));
      const stats = await fs.stat(absolutePath);

      const mockConfig = createMockConfig(tempRootDir);
      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: stats.dev, ino: stats.ino }],
        ]),
      });

      const content = contentToString(result.contentParts);
      expect(content).toContain('File size exceeds the 10MB limit');
      expect(content).toContain('huge.bin');
      expect(content).not.toContain('qwen-validated-read-');
      expect(content).not.toContain(
        'No files matching the criteria were found',
      );
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.filePath).toBe(absolutePath);
      // Downstream callers (e.g. atCommandProcessor) inspect this field to
      // render the read as failed rather than successful.
      expect(result.files[0]!.error).toMatch(/exceeds the 10MB limit/i);
      expect(result.files[0]!.error).not.toContain('qwen-validated-read-');
    });

    it('uses display paths for validated binary-file messages', async () => {
      const relativePath = 'blob.bin';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(absolutePath, Buffer.from([0x00, 0x01]));
      const stats = await fs.stat(absolutePath);
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: stats.dev, ino: stats.ino }],
        ]),
        displayPaths: new Map([[absolutePath, 'alias.bin']]),
      });

      const content = contentToString(result.contentParts);
      expect(content).toContain(
        'Cannot display content of binary file: alias.bin',
      );
      expect(content).not.toContain('qwen-validated-read-');
    });

    it('surfaces a size error for a validated file too large to snapshot', async () => {
      const relativePath = 'huge-image.png';
      const absolutePath = path.join(tempRootDir, relativePath);
      const handle = await fs.open(absolutePath, 'w');
      await handle.truncate(101 * 1024 * 1024 + 1);
      await handle.close();
      const stats = await fs.stat(absolutePath);
      const mockConfig = createMockConfig(tempRootDir);

      const result = await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: stats.dev, ino: stats.ino }],
        ]),
      });

      const content = contentToString(result.contentParts);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.error).toMatch(/exceeds/i);
      expect(content).not.toContain(
        'No files matching the criteria were found',
      );
    });
  });

  // Issue #6289: files attached via `@path` load their content into context
  // but were never recorded in the session FileReadCache, so a follow-up
  // Edit / WriteFile was rejected with EDIT_REQUIRES_PRIOR_READ until the
  // model redundantly re-read the file with read_file.
  describe('prior-read enforcement (issue #6289)', () => {
    it('records an @-attached text file so a later edit passes prior-read enforcement', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('attached.ts');
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      // Precondition: the file has never been read this session, so the
      // enforcement helper rejects an edit.
      const before = await checkPriorRead(cache, absolutePath, 'editing');
      expect(before.ok).toBe(false);

      await readManyFiles(mockConfig, { paths: [relativePath] });

      // The @-mention read must now satisfy prior-read enforcement without
      // a redundant read_file.
      const after = await checkPriorRead(cache, absolutePath, 'editing');
      expect(after.ok).toBe(true);
    });

    it('records a validated text read by canonical path for prior-read enforcement', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('validated.ts');
      const approvedStats = await fs.stat(absolutePath);
      const cache = new FileReadCache();
      const fileSystemService = new StandardFileSystemService();
      const mockConfig = {
        ...createMockConfigWithCache(tempRootDir, cache),
        getFileSystemService: () => fileSystemService,
      } as unknown as Config;

      await readManyFiles(mockConfig, {
        paths: [relativePath],
        validatedPathIdentities: new Map([
          [absolutePath, { dev: approvedStats.dev, ino: approvedStats.ino }],
        ]),
      });

      const decision = await checkPriorRead(cache, absolutePath, 'editing');
      expect(decision.ok).toBe(true);
    });

    it('records the read as fresh and cacheable in the FileReadCache', async () => {
      const { relativePath, absolutePath } = await createTestFile('notes.md');
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      await readManyFiles(mockConfig, { paths: [relativePath] });

      const stats = nodeFs.statSync(absolutePath);
      const status = cache.check(stats);
      expect(status.state).toBe('fresh');
      if (status.state === 'fresh') {
        expect(status.entry.lastReadAt).toBeDefined();
        expect(status.entry.lastReadCacheable).toBe(true);
      }
    });

    it('does not record reads when fileReadCacheDisabled is set', async () => {
      const { relativePath, absolutePath } =
        await createTestFile('attached.ts');
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache, true);

      await readManyFiles(mockConfig, { paths: [relativePath] });

      expect(cache.size()).toBe(0);
      const decision = await checkPriorRead(cache, absolutePath, 'editing');
      expect(decision.ok).toBe(false);
    });

    it('does not record directories (edit enforcement still rejects them)', async () => {
      await createTestFile('mydir', 'nested.txt');
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      await readManyFiles(mockConfig, { paths: ['mydir'] });

      expect(cache.size()).toBe(0);
    });

    it('does not let a binary image attachment satisfy text-edit enforcement', async () => {
      const relativePath = 'screenshot.png';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(
        absolutePath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      await readManyFiles(mockConfig, { paths: [relativePath] });

      // A binary payload cannot be mutated as text by Edit / WriteFile, so
      // enforcement must still reject it rather than being cleared by the
      // attachment.
      const decision = await checkPriorRead(cache, absolutePath, 'editing');
      expect(decision.ok).toBe(false);
    });

    it('records a binary file as a full but non-cacheable read', async () => {
      // A `.bin` file with a null byte is classified as `binary`: unlike an
      // image it returns `stats` (so it IS recorded), but it carries no
      // `originalLineCount`, so `cacheable` must be `false`. This guards the
      // `originalLineCount !== undefined` clause of the cacheable derivation
      // — dropping it would wrongly let a non-text payload clear prior-read
      // enforcement for Edit / WriteFile.
      const relativePath = 'payload.bin';
      const absolutePath = path.join(tempRootDir, relativePath);
      await fs.writeFile(
        absolutePath,
        Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]),
      );
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      await readManyFiles(mockConfig, { paths: [relativePath] });

      const stats = nodeFs.statSync(absolutePath);
      const status = cache.check(stats);
      expect(status.state).toBe('fresh');
      if (status.state === 'fresh') {
        expect(status.entry.lastReadCacheable).toBe(false);
      }
    });

    it('records a truncated @-attached file as a partial (full: false) read', async () => {
      // This attachment exceeds both truncation caps the mock config sets —
      // the 1000-line `getTruncateToolOutputLines()` limit and the 2500-char
      // `getTruncateToolOutputThreshold()` — so `processSingleFileContent`
      // marks it `isTruncated`, which `recordAttachedFileRead` maps to
      // `full: false`. On a fresh cache a partial read leaves the sticky
      // `lastReadWasFull` at its `false` default, so this cleanly separates
      // correct behaviour (false) from the bug it guards against: recording a
      // truncated attachment as `full: true` would silently clear Edit /
      // WriteFile prior-read enforcement for a file the model only partly saw.
      // The file is still cacheable (text with a known `originalLineCount`).
      const relativePath = 'big.ts';
      const absolutePath = path.join(tempRootDir, relativePath);
      const big = Array.from(
        { length: 1500 },
        (_, i) => `const x${i} = ${i};`,
      ).join('\n');
      await fs.writeFile(absolutePath, big);
      const cache = new FileReadCache();
      const mockConfig = createMockConfigWithCache(tempRootDir, cache);

      await readManyFiles(mockConfig, { paths: [relativePath] });

      const stats = nodeFs.statSync(absolutePath);
      const status = cache.check(stats);
      expect(status.state).toBe('fresh');
      if (status.state === 'fresh') {
        expect(status.entry.lastReadWasFull).toBe(false);
        expect(status.entry.lastReadCacheable).toBe(true);
      }
    });
  });
});
