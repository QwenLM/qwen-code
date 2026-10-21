/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import mock from 'mock-fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { WorkspaceContext } from './workspaceContext.js';
import { readPathFromWorkspace } from './pathReader.js';
import type { Config } from '../config/config.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { PartUnion } from '@google/genai';

// --- Helper for creating a mock Config object ---
// We use the actual implementations of WorkspaceContext and FileSystemService
// to test the integration against mock-fs.
const createMockConfig = (
  cwd: string,
  otherDirs: string[] = [],
  mockFileService?: FileDiscoveryService,
  fileFilteringOptions?: {
    respectGitIgnore: boolean;
    respectQwenIgnore: boolean;
  },
): Config => {
  const workspace = new WorkspaceContext(cwd, otherDirs);
  const fileSystemService = new StandardFileSystemService();
  return {
    getWorkspaceContext: () => workspace,
    // TargetDir is used by processSingleFileContent to generate relative paths in errors/output
    getTargetDir: () => cwd,
    getFileSystemService: () => fileSystemService,
    getFileService: () => mockFileService,
    getFileFilteringOptions: () =>
      fileFilteringOptions ?? {
        respectGitIgnore: true,
        respectQwenIgnore: true,
      },
    getTruncateToolOutputThreshold: () => 2500,
    getTruncateToolOutputLines: () => 500,
    getContentGeneratorConfig: () => ({
      modalities: { image: true, pdf: true, audio: true, video: true },
    }),
  } as unknown as Config;
};

const passThroughFileService = () =>
  ({
    filterFiles: vi.fn((files) => files),
  }) as unknown as FileDiscoveryService;

const solidPng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#306090' } })
    .png()
    .toBuffer();

/** Joins string and `{ text }` parts, dropping every other part. */
const textOf = (parts: PartUnion[]) =>
  parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (typeof p === 'object' && p && 'text' in p) return p.text;
      return '';
    })
    .join('');

describe('readPathFromWorkspace', () => {
  const CWD = path.resolve('/test/cwd');
  const OTHER_DIR = path.resolve('/test/other');
  const OUTSIDE_DIR = path.resolve('/test/outside');

  afterEach(() => {
    mock.restore();
    vi.resetAllMocks();
  });

  /** Reads `target` from a CWD (+ `otherDirs`) workspace. */
  const readInWorkspace = (
    target: string,
    otherDirs: string[] = [],
    fileService = passThroughFileService(),
  ) =>
    readPathFromWorkspace(
      target,
      createMockConfig(CWD, otherDirs, fileService),
    );

  it('should read a text file from the CWD', async () => {
    mock({
      [CWD]: {
        'file.txt': 'hello from cwd',
      },
    });
    const mockFileService = passThroughFileService();
    const result = await readInWorkspace('file.txt', [], mockFileService);
    // Expect [string] for text content
    expect(result).toEqual(['hello from cwd']);
    expect(mockFileService.filterFiles).toHaveBeenCalled();
  });

  it('should read a file from a secondary workspace directory', async () => {
    mock({
      [CWD]: {},
      [OTHER_DIR]: {
        'file.txt': 'hello from other dir',
      },
    });
    const result = await readInWorkspace('file.txt', [OTHER_DIR]);
    expect(result).toEqual(['hello from other dir']);
  });

  it('should prioritize CWD when file exists in both CWD and secondary dir', async () => {
    mock({
      [CWD]: {
        'file.txt': 'hello from cwd',
      },
      [OTHER_DIR]: {
        'file.txt': 'hello from other dir',
      },
    });
    const result = await readInWorkspace('file.txt', [OTHER_DIR]);
    expect(result).toEqual(['hello from cwd']);
  });

  it('should read an image file as overview text and inlineData', async () => {
    const imageData = await solidPng(20, 10);
    mock({
      [CWD]: {
        'image.png': imageData,
      },
    });
    const result = await readInWorkspace('image.png');
    // Expect overview text immediately followed by the bounded image.
    expect(result).toEqual([
      {
        text: expect.stringContaining(
          'Image overview: 20x10; oriented source: 20x10',
        ),
      },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: expect.any(String),
          displayName: 'image.png',
        },
      },
    ]);
  });

  it('should read a generic binary file and return an info string', async () => {
    // Data that is clearly binary (null bytes)
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    mock({
      [CWD]: {
        'data.bin': binaryData,
      },
    });
    const result = await readInWorkspace('data.bin');
    // Expect [string] containing the skip message from fileUtils
    expect(result).toEqual(['Cannot display content of binary file: data.bin']);
  });

  it('should read a file from an absolute path if within workspace', async () => {
    const absPath = path.join(OTHER_DIR, 'abs.txt');
    mock({
      [CWD]: {},
      [OTHER_DIR]: {
        'abs.txt': 'absolute content',
      },
    });
    const result = await readInWorkspace(absPath, [OTHER_DIR]);
    expect(result).toEqual(['absolute content']);
  });

  describe('Directory Expansion', () => {
    it('should expand a directory and read the content of its files', async () => {
      mock({
        [CWD]: {
          'my-dir': {
            'file1.txt': 'content of file 1',
            'file2.md': 'content of file 2',
          },
        },
      });
      const result = await readInWorkspace('my-dir');

      // Convert to a single string for easier, order-independent checking
      const resultText = textOf(result);

      expect(resultText).toContain(
        '--- Start of content for directory: my-dir ---',
      );
      expect(resultText).toContain('--- file1.txt ---');
      expect(resultText).toContain('content of file 1');
      expect(resultText).toContain('--- file2.md ---');
      expect(resultText).toContain('content of file 2');
      expect(resultText).toContain(
        '--- End of content for directory: my-dir ---',
      );
    });

    it('should recursively expand a directory and read all nested files', async () => {
      mock({
        [CWD]: {
          'my-dir': {
            'file1.txt': 'content of file 1',
            'sub-dir': {
              'nested.txt': 'nested content',
            },
          },
        },
      });
      const result = await readInWorkspace('my-dir');

      const resultText = textOf(result);

      expect(resultText).toContain('content of file 1');
      expect(resultText).toContain('nested content');
      expect(resultText).toContain(
        `--- ${path.join('sub-dir', 'nested.txt')} ---`,
      );
    });

    it('should handle mixed content and include files from subdirectories', async () => {
      const imageData = await solidPng(8, 8);
      mock({
        [CWD]: {
          'mixed-dir': {
            'info.txt': 'some text',
            'photo.png': imageData,
            'sub-dir': {
              'nested.txt': 'this should be included',
            },
            'empty-sub-dir': {},
          },
        },
      });
      const result = await readInWorkspace('mixed-dir');

      // Check for the text part (non-text parts are ignored)
      const textContent = textOf(result);
      expect(textContent).toContain('some text');
      expect(textContent).toContain('this should be included');

      // Check for the image part
      const imagePart = result.find(
        (p) => typeof p === 'object' && 'inlineData' in p,
      );
      expect(imagePart).toEqual({
        inlineData: {
          mimeType: 'image/jpeg',
          data: expect.any(String),
          displayName: 'photo.png',
        },
      });
    });

    it('should handle an empty directory', async () => {
      mock({
        [CWD]: {
          'empty-dir': {},
        },
      });
      const result = await readInWorkspace('empty-dir');
      expect(result).toEqual([
        { text: '--- Start of content for directory: empty-dir ---\n' },
        { text: '--- End of content for directory: empty-dir ---' },
      ]);
    });
  });

  describe('File Ignoring', () => {
    it('should return an empty array for an ignored file', async () => {
      mock({
        [CWD]: {
          'ignored.txt': 'ignored content',
        },
      });
      const mockFileService = {
        filterFiles: vi.fn(() => []), // Simulate the file being filtered out
      } as unknown as FileDiscoveryService;
      const result = await readInWorkspace('ignored.txt', [], mockFileService);
      expect(result).toEqual([]);
      expect(mockFileService.filterFiles).toHaveBeenCalledWith(
        ['ignored.txt'],
        {
          respectGitIgnore: true,
          respectQwenIgnore: true,
        },
      );
    });

    it('should not read ignored files when expanding a directory', async () => {
      mock({
        [CWD]: {
          'my-dir': {
            'not-ignored.txt': 'visible',
            'ignored.log': 'invisible',
          },
        },
      });
      const mockFileService = {
        filterFiles: vi.fn((files: string[]) =>
          files.filter((f) => !f.endsWith('ignored.log')),
        ),
      } as unknown as FileDiscoveryService;
      const result = await readInWorkspace('my-dir', [], mockFileService);
      const resultText = textOf(result);

      expect(resultText).toContain('visible');
      expect(resultText).not.toContain('invisible');
      expect(mockFileService.filterFiles).toHaveBeenCalled();
    });

    it('should pass respectGitIgnore: false from config to filterFiles', async () => {
      mock({
        [CWD]: {
          'ignored.txt': 'ignored content',
        },
      });
      const mockFileService = passThroughFileService();
      const config = createMockConfig(CWD, [], mockFileService, {
        respectGitIgnore: false,
        respectQwenIgnore: true,
      });
      await readPathFromWorkspace('ignored.txt', config);
      expect(mockFileService.filterFiles).toHaveBeenCalledWith(
        ['ignored.txt'],
        {
          respectGitIgnore: false,
          respectQwenIgnore: true,
        },
      );
    });
  });

  it('should throw an error for an absolute path outside the workspace', async () => {
    const absPath = path.join(OUTSIDE_DIR, 'secret.txt');
    mock({
      [CWD]: {},
      [OUTSIDE_DIR]: {
        'secret.txt': 'secrets',
      },
    });
    // OUTSIDE_DIR is not added to the config's workspace
    const config = createMockConfig(CWD);
    await expect(readPathFromWorkspace(absPath, config)).rejects.toThrow(
      `Absolute path is outside of the allowed workspace: ${absPath}`,
    );
  });

  it('should throw an error if a relative path is not found anywhere', async () => {
    mock({
      [CWD]: {},
      [OTHER_DIR]: {},
    });
    const config = createMockConfig(CWD, [OTHER_DIR]);
    await expect(
      readPathFromWorkspace('not-found.txt', config),
    ).rejects.toThrow('Path not found in workspace: not-found.txt');
  });

  // mock-fs permission simulation is unreliable on Windows and when running as root.
  it.skipIf(
    process.platform === 'win32' || (process.getuid && process.getuid() === 0),
  )(
    'should return an error string if reading a file with no permissions',
    async () => {
      mock({
        [CWD]: {
          'unreadable.txt': mock.file({
            content: 'you cannot read me',
            mode: 0o222, // Write-only
          }),
        },
      });
      // processSingleFileContent catches the error and returns an error string.
      const result = await readInWorkspace('unreadable.txt');
      const textResult = result[0] as string;

      // processSingleFileContent formats errors using the relative path from the target dir (CWD).
      expect(textResult).toContain('Error reading file unreadable.txt');
      expect(textResult).toMatch(/(EACCES|permission denied)/i);
    },
  );

  it('should truncate text files exceeding 10MB instead of failing', async () => {
    const largeContent = 'a'.repeat(11 * 1024 * 1024); // 11MB
    mock({
      [CWD]: {
        'large.txt': largeContent,
      },
    });
    const result = await readInWorkspace('large.txt');
    const textResult = result[0] as string;
    expect(textResult).toContain('a'.repeat(100));
    expect(textResult).toContain('... [truncated]');
  });
});
